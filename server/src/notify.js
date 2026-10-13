"use strict";
const fs = require("fs");

// Owner notification via a mature transactional-email API (Resend) — never a
// homemade mail server, and credentials never leave the server. Plain-text only
// (no HTML), so inquiry content can't inject markup into the owner's inbox.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;
const oneLine = (s, max) => String(s).replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);

function buildEmail(inq) {
  const subject = `New inquiry: ${oneLine(inq.session_type, 30)} — ${oneLine(inq.name, 60)}`;
  const text = [
    `New photography inquiry (${inq.id})`,
    `Received: ${inq.created_at}`,
    "",
    `Name: ${oneLine(inq.name, 100)}`,
    `Email: ${oneLine(inq.email, 254)}`,
    `Phone: ${oneLine(inq.phone || "-", 30)}`,
    `Session type: ${oneLine(inq.session_type, 30)}`,
    `Preferred date: ${inq.preferred_date || "-"}`,
    `Location: ${oneLine(inq.location || "-", 200)}`,
    `Discount code: ${oneLine(inq.discount_code || "-", 50)}`,
    "",
    "Message:",
    inq.message,
    "",
    "This is an inquiry/request, not a confirmed booking. Reply to this email to answer the client directly.",
  ].join("\n");
  return { subject, text };
}

class NotifyError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // short, non-sensitive code stored in the DB (never provider response bodies)
  }
}

function createNotifier(config, fetchImpl = globalThis.fetch) {
  const { provider, resendApiKey, to, from, devMailFile } = config.notify;

  if (provider === "resend") {
    return {
      provider,
      async send(inq) {
        if (!resendApiKey || !to || !from) throw new NotifyError("not_configured");
        const { subject, text } = buildEmail(inq);
        let res;
        try {
          res = await fetchImpl("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from, to: [to], subject, text, reply_to: inq.email }),
            signal: AbortSignal.timeout(8000),
          });
        } catch (err) {
          throw new NotifyError(err && err.name === "TimeoutError" ? "timeout" : "network");
        }
        if (!res.ok) throw new NotifyError(`http_${res.status}`);
      },
    };
  }

  if (provider === "dev") {
    // Local development / tests only (refused in production by config validation).
    return {
      provider,
      async send(inq) {
        const mail = { to: to || "owner@example.test", ...buildEmail(inq), replyTo: inq.email, id: inq.id };
        if (devMailFile) fs.appendFileSync(devMailFile, JSON.stringify(mail) + "\n");
      },
    };
  }

  // No provider configured: inquiries are still stored; notifications stay pending
  // (visible in /health and the CLI) and are sent automatically once configured.
  return {
    provider: "none",
    async send() {
      throw new NotifyError("not_configured");
    },
  };
}

module.exports = { createNotifier, buildEmail, NotifyError };
