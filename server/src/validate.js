"use strict";
// Server-side validation/normalisation. The client's validation is a convenience;
// this is the only validation that counts. Unknown fields are rejected, every field
// has an explicit type and length cap, and nothing is trusted from hidden inputs.

const SESSION_TYPES = ["Weddings", "Proposals", "Graduations", "Cars", "Portraits"];
const LIMITS = { name: 100, email: 254, phone: 30, location: 200, message: 5000, discountCode: 50 };
const ALLOWED_FIELDS = new Set(["name", "email", "phone", "sessionType", "preferredDate", "location", "message", "discountCode", "idempotencyKey", "website", "turnstileToken"]);

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const PHONE = /^[0-9+()\-.\s]+$/;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
// Text that can mislead or attack whoever reads it later (terminal, email client, future admin UI):
// C0 controls (keeps \t \n \r), DEL + C1 controls (some terminals act on U+009B as an escape
// introducer), bidi overrides/isolates and line/paragraph separators (visual spoofing), BOM.
// Zero-width joiners are kept: emoji and several scripts need them.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function arizonaToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function isRealDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function clean(value, { multiline = false } = {}) {
  let s = String(value).normalize("NFC").replace(UNSAFE_TEXT, "");
  if (!multiline) s = s.replace(/[\r\n\t]+/g, " ");
  return s.trim();
}

/**
 * @returns {{ ok: true, value: object, honeypot: boolean } | { ok: false, fields: Record<string,string> }}
 */
function validateInquiry(body, now = new Date()) {
  const fields = {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, fields: { _: "Request body must be a JSON object." } };

  for (const key of Object.keys(body)) if (!ALLOWED_FIELDS.has(key)) fields[key] = "Unexpected field.";

  const str = (name, { required = false, max, multiline = false } = {}) => {
    const raw = body[name];
    if (raw === undefined || raw === null || raw === "") {
      if (required) fields[name] = "This field is required.";
      return "";
    }
    if (typeof raw !== "string") {
      fields[name] = "Must be text.";
      return "";
    }
    const v = clean(raw, { multiline });
    if (!v && required) fields[name] = "This field is required.";
    else if (v.length > max) fields[name] = `Must be ${max} characters or fewer.`;
    return v;
  };

  const name = str("name", { required: true, max: LIMITS.name });
  const email = str("email", { required: true, max: LIMITS.email }).toLowerCase();
  if (email && !fields.email && !EMAIL.test(email)) fields.email = "Enter a valid email address.";
  const phone = str("phone", { max: LIMITS.phone });
  if (phone && !fields.phone && (!PHONE.test(phone) || phone.replace(/\D/g, "").length < 7)) fields.phone = "Enter a valid phone number.";
  const sessionType = str("sessionType", { required: true, max: 20 });
  if (sessionType && !fields.sessionType && !SESSION_TYPES.includes(sessionType)) fields.sessionType = "Choose one of the listed session types.";
  const location = str("location", { max: LIMITS.location });
  const message = str("message", { required: true, max: LIMITS.message, multiline: true });
  const discountCode = str("discountCode", { max: LIMITS.discountCode });

  const preferredDate = str("preferredDate", { max: 10 });
  if (preferredDate && !fields.preferredDate) {
    const today = arizonaToday(now);
    if (!isRealDate(preferredDate)) fields.preferredDate = "Enter a valid date.";
    else if (preferredDate < today) fields.preferredDate = "The date can't be in the past.";
    else if (preferredDate > addDays(today, 730)) fields.preferredDate = "Please choose a date within the next two years.";
  }

  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  if (!KEY.test(idempotencyKey)) fields.idempotencyKey = "Missing or invalid request key.";

  if (body.website !== undefined && typeof body.website !== "string") fields.website = "Unexpected field.";
  if (body.turnstileToken !== undefined && typeof body.turnstileToken !== "string") fields.turnstileToken = "Unexpected field.";
  if (typeof body.turnstileToken === "string" && body.turnstileToken.length > 2048) fields.turnstileToken = "Unexpected field.";

  if (Object.keys(fields).length) return { ok: false, fields };

  return {
    ok: true,
    honeypot: typeof body.website === "string" && body.website.trim() !== "",
    turnstileToken: body.turnstileToken || "",
    value: { name, email, phone, sessionType, preferredDate, location, message, discountCode, idempotencyKey },
  };
}

module.exports = { validateInquiry, SESSION_TYPES, LIMITS, UNSAFE_TEXT, arizonaToday };
