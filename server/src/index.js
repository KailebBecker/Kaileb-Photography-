"use strict";
const { loadConfig, assertProductionReady } = require("./config");
const { openDatabase } = require("./db");
const { createNotifier } = require("./notify");
const { createService } = require("./service");
const { buildApp } = require("./app");

async function main() {
  const config = loadConfig();
  assertProductionReady(config);

  const db = openDatabase(config.dbPath);
  const service = createService({ db, notifier: createNotifier(config), perEmailDailyCap: config.perEmailDailyCap });
  const app = buildApp({ config, service });

  // Retry unsent owner notifications (e.g. provider outage, or key added later).
  const sweeper = setInterval(() => service.retryPending().catch((e) => app.log.error({ err: { message: e.message } }, "retry sweep failed")), 5 * 60 * 1000);
  sweeper.unref();

  const shutdown = async (signal) => {
    app.log.info({ signal }, "shutting down");
    clearInterval(sweeper);
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
  service.retryPending().catch(() => {}); // pick up anything left over from before a restart
  if (config.notify.provider === "none") app.log.warn("NOTIFY_PROVIDER=none: inquiries are stored but the owner is NOT emailed");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
