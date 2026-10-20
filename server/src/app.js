"use strict";
const Fastify = require("fastify");
const cors = require("@fastify/cors");
const rateLimit = require("@fastify/rate-limit");
const crypto = require("crypto");
const { validateInquiry, arizonaToday } = require("./validate");
const { RateLimitedError } = require("./service");
const { isRealDate, isRealMonth, addDays } = require("./availability/time");

const BODY_LIMIT = 16 * 1024;

/**
 * Builds the Fastify app. Dependencies are injected so tests can swap the database,
 * notifier, clock and outbound fetch without touching the network.
 */
function buildApp({ config, service, availability = null, fetchImpl = globalThis.fetch, logger = true, now = () => new Date() }) {
  const app = Fastify({
    logger, // default Fastify logging records method/url/status — never request bodies
    bodyLimit: BODY_LIMIT,
    // Honour X-Forwarded-For only from the local reverse proxy (nginx on loopback); a request that
    // reaches Node from any other address cannot choose the IP used for rate limiting.
    trustProxy: config.trustProxy ? ["127.0.0.1", "::1"] : false,
    requestTimeout: 15_000, // whole request must arrive within 15 s (nginx already buffers it)
    keepAliveTimeout: 10_000,
  });

  // JSON only. Fastify also parses text/plain by default, which is the content type a hostile web page
  // can POST cross-origin without a CORS preflight; with the parser removed it is refused outright (415).
  app.removeContentTypeParser("text/plain");

  const allowed = new Set(config.allowedOrigins);
  // Turnstile reports the hostname the widget ran on; it must be one of our website hostnames.
  const allowedHostnames = new Set(config.allowedOrigins.map((o) => new URL(o).hostname.toLowerCase()));

  // API responses are per-request and personal: never cacheable.
  app.addHook("onSend", async (req, reply) => {
    if (!reply.getHeader("cache-control")) reply.header("Cache-Control", "no-store");
  });

  // Exact-match CORS allowlist; no wildcard, no credentials/cookies are ever used.
  app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: 600,
  });

  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({ statusCode: 429, ok: false, error: "rate_limited" }),
  });

  // Reject browser requests from origins we don't know, even though CORS would also
  // stop the page from reading the response. (Requests with no Origin — curl, server
  // to server — are allowed but still rate limited and validated.)
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin) && req.url.startsWith("/api/")) {
      return reply.code(403).send({ ok: false, error: "origin_not_allowed" });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.statusCode && err.statusCode < 500) {
      const map = { 413: "too_large", 415: "unsupported_media_type", 429: "rate_limited" };
      return reply.code(err.statusCode).send({ ok: false, error: map[err.statusCode] || "bad_request" });
    }
    req.log.error({ err: { message: err.message, code: err.code } }, "request failed"); // no body/PII
    return reply.code(500).send({ ok: false, error: "server" });
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ ok: false, error: "not_found" }));

  // true = verified, false = visitor failed the check; throws when the check could not be performed
  // (callers fail closed). The secret and the token are never logged or echoed. Cloudflare tokens are
  // single-use and expire after 5 minutes, so a captured token cannot be replayed; the website also
  // requests a fresh token after every attempt.
  async function passesBotCheck(token, ip, log) {
    if (!config.turnstileSecret) return true; // bot check not configured (staging/dev)
    if (!token) return false;
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: config.turnstileSecret, response: token, remoteip: ip || "" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`turnstile http ${res.status}`);
    const data = await res.json();
    if (!data || typeof data !== "object") throw new Error("turnstile bad response");
    if (data.success === true) {
      const host = typeof data.hostname === "string" ? data.hostname.toLowerCase() : "";
      if (allowedHostnames.has(host)) return true;
      log.warn("bot check passed for a hostname that is not in ALLOWED_ORIGINS"); // widget/site-key hostname misconfiguration
      return false;
    }
    // Provider error codes are short fixed strings (e.g. invalid-input-secret = wrong TURNSTILE_SECRET,
    // timeout-or-duplicate = reused token). Logging them lets the administrator diagnose a misconfiguration.
    const codes = (Array.isArray(data["error-codes"]) ? data["error-codes"] : []).filter((c) => typeof c === "string" && /^[a-z0-9-]{1,40}$/.test(c));
    if (codes.includes("internal-error")) throw new Error("turnstile internal error"); // provider-side: retryable, not the visitor's fault
    log.warn({ turnstileErrors: codes }, "bot check rejected");
    return false;
  }

  // Routes are registered inside a plugin so they are defined AFTER cors/rate-limit have
  // loaded (otherwise the per-route rate limit would silently not apply).
  app.register(async (routesApp) => {
    routesApp.post(
      "/api/inquiries",
      { config: { rateLimit: { max: config.rateLimit.max, timeWindow: config.rateLimit.windowMs } } },
      async (req, reply) => {
        const result = validateInquiry(req.body, now());
        if (!result.ok) return reply.code(400).send({ ok: false, error: "validation", fields: result.fields });

        // Honeypot: bots fill the hidden field. Pretend success, store nothing.
        if (result.honeypot) return reply.code(201).send({ ok: true, id: crypto.randomBytes(5).toString("hex").toUpperCase(), duplicate: false });

        let botOk;
        try {
          botOk = await passesBotCheck(result.turnstileToken, req.ip, req.log);
        } catch (err) {
          req.log.warn("bot check unavailable");
          return reply.code(503).send({ ok: false, error: "bot_check_unavailable" }); // fail closed
        }
        if (!botOk) return reply.code(400).send({ ok: false, error: "bot_check_failed" });

        let created;
        try {
          created = service.create(result.value, req.headers.origin);
        } catch (err) {
          if (err instanceof RateLimitedError) return reply.code(429).send({ ok: false, error: "rate_limited" });
          throw err; // storage failure -> 500, never a success response
        }

        // Stored durably. Success is reported regardless of the notification outcome;
        // a failed/pending notification is retried and visible in /health + the CLI.
        if (!created.duplicate) service.notify(created.id);
        return reply.code(created.duplicate ? 200 : 201).send({ ok: true, id: created.id, duplicate: created.duplicate });
      }
    );

    // Public availability: per date, available or not, plus one overall "verified" flag. Never intervals,
    // reasons, sources, labels or counts. When a required external calendar can't be verified every date
    // comes back available:false with verified:false (never a silent "available").
    if (availability) {
      routesApp.get(
        "/api/availability",
        { config: { rateLimit: { max: 60, timeWindow: 10 * 60 * 1000 } } },
        async (req, reply) => {
          const keys = Object.keys(req.query || {});
          const { month, date } = req.query || {};
          const bad = keys.some((k) => k !== "month" && k !== "date") || (month === undefined) === (date === undefined) || (month !== undefined && typeof month !== "string") || (date !== undefined && typeof date !== "string");
          const today = arizonaToday(now());
          const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + 6, 1)).toISOString().slice(0, 7);
          if (bad || (month !== undefined && !(isRealMonth(month) && month >= today.slice(0, 7) && month <= lastMonth)) || (date !== undefined && !(isRealDate(date) && date >= today && date <= addDays(today, availability.HORIZON_DAYS)))) {
            return reply.code(400).send({ ok: false, error: "validation" });
          }
          const body = month !== undefined ? { ok: true, month, ...availability.month(month) } : { ok: true, ...availability.day(date) };
          // Verified answers may be cached briefly (AC-F2.5); unverified ones never are.
          reply.header("Cache-Control", body.verified ? "public, max-age=60" : "no-store");
          return body;
        }
      );
    }

    // Liveness + notification backlog (no PII). Not CORS-enabled for browsers' use.
    routesApp.get("/health", async () => ({ ok: true, notifyBacklog: service.notifyBacklog(), ...(availability ? { calendar: availability.healthSummary() } : {}) }));

  });

  return app;
}

module.exports = { buildApp, BODY_LIMIT };
