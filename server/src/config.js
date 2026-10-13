"use strict";
// Environment-driven configuration. Secrets only ever come from the environment
// (systemd EnvironmentFile on the server) — never from files in this repo.

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
    rateLimit: {
      max: Number(env.RATE_LIMIT_MAX || 5),
      windowMs: Number(env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000),
    },
    perEmailDailyCap: Number(env.PER_EMAIL_DAILY_CAP || 5),
  };
  return config;
}

// Fail fast on unsafe production configuration instead of silently degrading.
function assertProductionReady(config) {
  if (!config.production) return;
  const problems = [];
  if (!config.allowedOrigins.length) problems.push("ALLOWED_ORIGINS must list the site origin(s)");
  if (config.allowedOrigins.some((o) => o === "*" || !/^https:\/\//.test(o))) problems.push("ALLOWED_ORIGINS must be exact https:// origins (no wildcard)");
  if (config.notify.provider === "dev") problems.push("NOTIFY_PROVIDER=dev is not allowed in production");
  if (config.notify.provider === "resend" && !(config.notify.resendApiKey && config.notify.to && config.notify.from)) {
    problems.push("NOTIFY_PROVIDER=resend needs RESEND_API_KEY, NOTIFY_TO and NOTIFY_FROM");
  }
  if (problems.length) throw new Error("Unsafe production config:\n - " + problems.join("\n - "));
}

module.exports = { loadConfig, assertProductionReady };
