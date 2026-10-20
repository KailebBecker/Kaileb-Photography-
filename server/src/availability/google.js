"use strict";
// Google Calendar as an availability source, behind a deliberately narrow interface:
//
//   source.getBusy(fromMs, toMs) -> Promise<Array<{ start: number, end: number }>>   (UTC milliseconds)
//
// Nothing else leaves this file: no Google event objects, titles, descriptions, attendees or
// locations. It calls ONLY the free/busy endpoint (POST /calendar/v3/freeBusy), which by design
// returns busy time ranges and nothing else, with the single OAuth scope
//   https://www.googleapis.com/auth/calendar.freebusy
// (the free/busy query also accepts broader scopes; this app never asks for them).
//
// Credentials come from the environment: an OAuth client id/secret and a long-lived refresh token
// obtained once by `node src/calendar-auth.js`. Access tokens live in memory only. Failures are
// reported as short fixed codes (CalendarError.code); provider response bodies, tokens and secrets
// are never copied into errors or logs.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
const CHUNK_MS = 90 * 86400000; // query long horizons in 90-day pieces
const TIMEOUT_MS = 10000;

class CalendarError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // not_configured | auth_revoked | auth_config | auth_failed | forbidden | calendar_not_found | provider_unavailable | timeout | network | bad_response | provider_error
  }
}

const PERMANENT = new Set(["auth_revoked", "auth_config", "forbidden", "calendar_not_found", "not_configured"]);

function createGoogleSource({ clientId, clientSecret, refreshToken, calendarId = "primary" }, fetchImpl = globalThis.fetch, clock = Date.now) {
  let access = null; // { token, expiresAt } (memory only)
  // One id or a comma-separated list (e.g. "primary,work@group.calendar.google.com"); busy time is the union.
  const ids = String(calendarId).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (!ids.length) ids.push("primary");

  async function post(url, init) {
    try {
      return await fetchImpl(url, { ...init, method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new CalendarError(err && err.name === "TimeoutError" ? "timeout" : "network");
    }
  }

  const readJson = async (res) => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  async function accessToken() {
    if (access && access.expiresAt - 60000 > clock()) return access.token;
    if (!clientId || !clientSecret || !refreshToken) throw new CalendarError("not_configured");
    const res = await post(TOKEN_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const data = await readJson(res);
    if (!res.ok) {
      const err = data && typeof data.error === "string" ? data.error : "";
      if (err === "invalid_grant") throw new CalendarError("auth_revoked"); // revoked, expired (Testing-mode app) or password reset
      if (err === "invalid_client" || err === "unauthorized_client") throw new CalendarError("auth_config");
      throw new CalendarError(res.status >= 500 || res.status === 429 ? "provider_unavailable" : "auth_failed");
    }
    if (!data || typeof data.access_token !== "string" || !(Number(data.expires_in) > 0)) throw new CalendarError("bad_response");
    access = { token: data.access_token, expiresAt: clock() + Number(data.expires_in) * 1000 };
    return access.token;
  }

  async function queryChunk(from, to) {
    const token = await accessToken();
    // Request body: the time range and ONE calendar id. Nothing identifying about the business or customers.
    const res = await post(FREEBUSY_URL, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), timeZone: "UTC", items: ids.map((id) => ({ id })) }),
    });
    if (!res.ok) {
      if (res.status === 401) {
        access = null; // token rejected: get a fresh one next time
        throw new CalendarError("auth_failed");
      }
      if (res.status === 403) throw new CalendarError("forbidden"); // Calendar API not enabled, or scope not granted
      if (res.status === 404) throw new CalendarError("calendar_not_found");
      throw new CalendarError(res.status === 429 || res.status >= 500 ? "provider_unavailable" : "provider_error");
    }
    const data = await readJson(res);
    const calendars = data && typeof data === "object" ? data.calendars : null;
    if (!calendars || typeof calendars !== "object") throw new CalendarError("bad_response");
    // Google keys each result by the requested id; a lone "primary" may be keyed by the account's address.
    const keys = Object.keys(calendars);
    const out = [];
    for (const id of ids) {
      const entry = calendars[id] || (ids.length === 1 && keys.length === 1 ? calendars[keys[0]] : null);
      if (!entry || typeof entry !== "object") throw new CalendarError("bad_response"); // a requested calendar is missing: unverifiable
      if (Array.isArray(entry.errors) && entry.errors.length) {
        throw new CalendarError(entry.errors.some((e) => e && e.reason === "notFound") ? "calendar_not_found" : "provider_error");
      }
      if (!Array.isArray(entry.busy)) throw new CalendarError("bad_response");
      // Take ONLY start/end from each busy range; anything else in the payload is discarded here.
      for (const r of entry.busy) {
        const start = Date.parse(r && r.start);
        const end = Date.parse(r && r.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new CalendarError("bad_response");
        out.push({ start, end });
      }
    }
    return out;
  }

  return {
    name: "google",
    async getBusy(fromMs, toMs) {
      const out = [];
      for (let from = fromMs; from < toMs; from += CHUNK_MS) out.push(...(await queryChunk(from, Math.min(toMs, from + CHUNK_MS))));
      return out;
    },
  };
}

/** The source for the configured provider, or null when external calendars are off. */
function createSource(config, fetchImpl) {
  if (config.calendar.provider === "google") return createGoogleSource(config.calendar.google, fetchImpl);
  return null;
}

module.exports = { createGoogleSource, createSource, CalendarError, PERMANENT, SCOPE, TOKEN_URL, FREEBUSY_URL };
