"use strict";
const Fastify = require("fastify");
const cors = require("@fastify/cors");
const rateLimit = require("@fastify/rate-limit");
const crypto = require("crypto");
const { validateInquiry } = require("./validate");
const { RateLimitedError } = require("./service");

const BODY_LIMIT = 16 * 1024;

/**
 * Builds the Fastify app. Dependencies are injected so tests can swap the database,
 * notifier, clock and outbound fetch without touching the network.
 */
function buildApp({ config, service, fetchImpl = globalThis.fetch, logger = true, now = () => new Date() }) {
  const app = Fastify({
    logger, // default Fastify logging records method/url/status — never request bodies
    bodyLimit: BODY_LIMIT,
    trustProxy: config.trustProxy,
  });

  const allowed = new Set(config.allowedOrigins);

  // Exact-match CORS allowlist; no wildcard, no credentials/cookies are ever used.
  app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    methods: ["POST", "OPTIONS"],
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

  async function passesBotCheck(token, ip) {
    if (!config.turnstileSecret) return true; // bot check not configured (staging/dev)
    if (!token) return false;
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: config.turnstileSecret, response: token, remoteip: ip || "" }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return data && data.success === true;
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
          botOk = await passesBotCheck(result.turnstileToken, req.ip);
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

    // Liveness + notification backlog (no PII). Not CORS-enabled for browsers' use.
    routesApp.get("/health", async () => ({ ok: true, notifyBacklog: service.notifyBacklog() }));

  });

  return app;
}

module.exports = { buildApp, BODY_LIMIT };
