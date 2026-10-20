"use strict";
// Environment-driven configuration. Secrets only ever come from the environment
// (systemd EnvironmentFile on the server) — never from files in this repo.

const path = require("path");

function list(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const production = nodeEnv === "production";
  const config = {
    nodeEnv,
    production,
    host: env.HOST || "127.0.0.1", // stay behind the HTTPS reverse proxy
    port: Number(env.PORT || 8787),
    dbPath: env.DB_PATH || "./data/inquiries.db",
    // Exact origins (scheme + host [+ port]) allowed to call the API from a browser.
    allowedOrigins: list(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, "")),
    trustProxy: env.TRUST_PROXY === "true",
    notify: {
      provider: env.NOTIFY_PROVIDER || "none", // resend | dev | none
      resendApiKey: env.RESEND_API_KEY || "",
      to: env.NOTIFY_TO || "",
      from: env.NOTIFY_FROM || "",
      devMailFile: env.DEV_MAIL_FILE || "",
    },
    turnstileSecret: env.TURNSTILE_SECRET || "",
    // External conflict source for availability. "none" = manual rules/blocks/sessions only.
    // "google" = Google Calendar free/busy (scope calendar.freebusy). Once enabled it is REQUIRED:
    // if it cannot be verified, public availability never reports a date as available.
    calendar: {
      provider: env.CALENDAR_PROVIDER || "none",
      google: {
        clientId: env.GOOGLE_CLIENT_ID || "",
        clientSecret: env.GOOGLE_CLIENT_SECRET || "",
        refreshToken: env.GOOGLE_REFRESH_TOKEN || "",
        calendarId: env.GOOGLE_CALENDAR_ID || "primary",
      },
      maxStaleMinutes: Number(env.CALENDAR_MAX_STALE_MINUTES || 60),
    },
    rateLimit: {
      max: Number(env.RATE_LIMIT_MAX || 5),
      windowMs: Number(env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
    },
    perEmailDailyCap: Number(env.PER_EMAIL_DAILY_CAP || 5),
  };
  return config;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const REPO_ROOT = path.resolve(__dirname, "..", ".."); // the code checkout that updates replace

function isInside(file, dir) {
  const rel = path.relative(dir, path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isBareOrigin(o) {
  try {
    return new URL(o).origin === o;
  } catch {
    return false;
  }
}

// Fail fast on unsafe production configuration instead of silently degrading.
function assertProductionReady(config) {
  if (!config.production) return;
  const problems = [];
  if (!config.allowedOrigins.length) problems.push("ALLOWED_ORIGINS must list the site origin(s)");
  if (config.allowedOrigins.some((o) => o === "*" || !/^https:\/\//.test(o))) problems.push("ALLOWED_ORIGINS must be exact https:// origins (no wildcard)");
  // A browser's Origin header never has a path, so "https://user.github.io/repo/" would silently never match.
  if (config.allowedOrigins.some((o) => !isBareOrigin(o))) problems.push("ALLOWED_ORIGINS entries must be scheme + host only (no path), e.g. https://kailebbecker.github.io");
  // Only the local reverse proxy may reach Node (this also keeps X-Forwarded-For trustworthy).
  if (!LOOPBACK.has(config.host)) problems.push("HOST must be a loopback address (127.0.0.1): nginx on the same server is the only public entry point");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) problems.push("PORT must be a valid port number");
  // Updates replace the code checkout; the database must live elsewhere so they can never touch it.
  if (!path.isAbsolute(config.dbPath) || isInside(config.dbPath, REPO_ROOT)) problems.push("DB_PATH must be an absolute path outside the code checkout, e.g. /var/lib/kaileb-inquiry/inquiries.db");
  if (!["none", "google"].includes(config.calendar.provider)) problems.push("CALENDAR_PROVIDER must be none or google");
  if (!(config.calendar.maxStaleMinutes >= 15)) problems.push("CALENDAR_MAX_STALE_MINUTES must be at least 15 (the sync interval)");
  if (config.notify.provider === "dev") problems.push("NOTIFY_PROVIDER=dev is not allowed in production");
  if (config.notify.provider === "resend" && !(config.notify.resendApiKey && config.notify.to && config.notify.from)) {
    problems.push("NOTIFY_PROVIDER=resend needs RESEND_API_KEY, NOTIFY_TO and NOTIFY_FROM");
  }
  if (problems.length) throw new Error("Unsafe production config:\n - " + problems.join("\n - "));
}

module.exports = { loadConfig, assertProductionReady };
