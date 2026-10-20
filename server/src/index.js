"use strict";
const { loadConfig, assertProductionReady } = require("./config");
const { openDatabase } = require("./db");
const { createNotifier } = require("./notify");
const { createService } = require("./service");
const { buildApp } = require("./app");
const { createAvailability } = require("./availability/engine");
const { createSource } = require("./availability/google");
const { createCalendarSync } = require("./availability/sync");

async function main() {
  const config = loadConfig();
  assertProductionReady(config);

  const db = openDatabase(config.dbPath);
  const service = createService({ db, notifier: createNotifier(config), perEmailDailyCap: config.perEmailDailyCap });
  const availability = createAvailability({ db, config });
  availability.recordConfiguration();
  const app = buildApp({ config, service, availability });

  // External calendar (Google free/busy): refresh the busy cache now and every 15 minutes. A failing
  // source turns public availability "unverified" (see availability/engine.js); it never takes the inquiry form down.
  const source = createSource(config);
  let stopCalendarSync = () => {};
  if (source) {
    const g = config.calendar.google;
    if (!(g.clientId && g.clientSecret && g.refreshToken)) app.log.warn("CALENDAR_PROVIDER=google but GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN are not all set: availability will report 'unverified'");
    const sync = createCalendarSync({ db, source });
    stopCalendarSync = sync.start({ onResult: (r) => (r.ok ? app.log.info({ intervals: r.count }, "calendar synced") : app.log.warn({ code: r.code }, "calendar sync failed")) });
  }

  // Retry unsent owner notifications (e.g. provider outage, or key added later).
  const sweeper = setInterval(() => service.retryPending().catch((e) => app.log.error({ err: { message: e.message } }, "retry sweep failed")), 5 * 60 * 1000);
  sweeper.unref();

  const shutdown = async (signal) => {
    app.log.info({ signal }, "shutting down");
    clearInterval(sweeper);
    stopCalendarSync();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
  service.retryPending().catch(() => {}); // pick up anything left over from before a restart
  if (config.production && !config.turnstileSecret) app.log.warn("TURNSTILE_SECRET not set: bot check is OFF (rate limits and honeypot still apply)");
  if (config.notify.provider === "none") app.log.warn("NOTIFY_PROVIDER=none: inquiries are stored but the owner is NOT emailed");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
