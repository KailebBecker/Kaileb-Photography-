"use strict";
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { createService } = require("../src/service");
const { buildApp } = require("../src/app");
const { createAvailability } = require("../src/availability/engine");

const NOW = new Date("2026-10-14T18:00:00Z");
const ORIGIN = "https://kailebbecker.github.io";

let counter = 0;
const key = () => `test-key-${String(++counter).padStart(8, "0")}-abcdef`;

function payload(overrides = {}) {
  return {
    name: "Jamie Client",
    email: "jamie@example.com",
    phone: "(480) 555-0100",
    sessionType: "Graduations",
    preferredDate: "2026-12-20",
    location: "ASU Tempe",
    message: "We would love grad photos at sunset.",
    discountCode: "",
    idempotencyKey: key(),
    website: "",
    ...overrides,
  };
}

function setup({ env = {}, notifier, fetchImpl, db } = {}) {
  const config = loadConfig({ ALLOWED_ORIGINS: ORIGIN, NODE_ENV: "test", RATE_LIMIT_MAX: "1000", ...env });
  const database = db || openDatabase(":memory:");
  const sent = [];
  const fakeNotifier = notifier || {
    provider: "fake",
    async send(row) {
      sent.push(row);
    },
  };
  const service = createService({ db: database, notifier: fakeNotifier, now: () => NOW, perEmailDailyCap: config.perEmailDailyCap });
  const logs = [];
  const stream = { write: (line) => logs.push(line) };
  const availability = createAvailability({ db: database, config, now: () => NOW });
  const app = buildApp({ config, service, availability, fetchImpl, now: () => NOW, logger: { level: "info", stream } });
  const post = (body, headers = {}) =>
    app.inject({ method: "POST", url: "/api/inquiries", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, payload: typeof body === "string" ? body : JSON.stringify(body) });
  return { app, db: database, service, availability, sent, logs, post, config };
}

module.exports = { setup, payload, ORIGIN, NOW, key };
