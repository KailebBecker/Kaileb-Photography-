// Contact form <-> inquiry API behaviour, with the API mocked at the network layer.
// (tests/inquiry-e2e.spec.js drives the real server.) The M1 "no backend configured" behaviour is covered in site.spec.js.
const { test, expect } = require("@playwright/test");

const API = "https://api.test.example/api/inquiries";

async function configured(page, extra = "") {
  await page.route("**/scripts/site-config.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: `window.SITE_CONFIG = { inquiryApiUrl: "${API}", turnstileSiteKey: "" }; ${extra}` })
  );
  await page.goto("contact.html");
}

async function fillValid(page, overrides = {}) {
  await page.fill("#name", overrides.name ?? "Jamie Client");
  await page.fill("#email", overrides.email ?? "jamie@example.com");
  await page.selectOption("#sessionType", "Graduations");
  await page.fill("#message", overrides.message ?? "We would love grad photos.");
}

const json = (status, body) => ({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
const submit = (page) => page.click("#contact-form button[type=submit]");

test("configured: notice hidden, button says Send Inquiry", async ({ page }) => {
  await configured(page);
  await expect(page.locator("#form-notice")).toBeHidden();
  await expect(page.locator("#contact-form button[type=submit]")).toContainText("Send Inquiry");
  await expect(page.locator("#contact-form button[type=submit]")).toBeEnabled();
});

test("success is shown only after the server confirms storage; request shape is correct", async ({ page }) => {
  let body;
  let release;
  const gate = new Promise((r) => (release = r));
  await configured(page);
  await page.route(API, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    body = route.request().postDataJSON();
    await gate; // hold the response: nothing may claim success yet
    return route.fulfill(json(201, { ok: true, id: "ABCDE12345", duplicate: false }));
  });
  await fillValid(page);
  await submit(page);
  await expect(page.locator("#contact-form button[type=submit]")).toBeDisabled();
  await expect(page.locator("#contact-form button[type=submit]")).toContainText("Sending");
  await expect(page.locator("#inquiry-success")).toBeHidden();
  expect((await page.locator("#form-status").innerText()).toLowerCase()).not.toMatch(/received|thank/);
  release();
  await expect(page.locator("#inquiry-success")).toBeVisible();
  await expect(page.locator("#inquiry-success")).toBeFocused();
  await expect(page.locator("#inquiry-success [data-ref]")).toHaveText("ABCDE12345");
  await expect(page.locator("#inquiry-success [data-email]")).toHaveText("jamie@example.com");
  const text = (await page.locator("#inquiry-success").innerText()).toLowerCase();
  expect(text).toContain("request, not a booking");
  expect(text).not.toMatch(/you(?:'| a)re booked|booking confirmed|session confirmed/);
  await expect(page.locator("#contact-form")).toBeHidden();
  expect(body).toMatchObject({ name: "Jamie Client", email: "jamie@example.com", sessionType: "Graduations", message: "We would love grad photos.", website: "" });
  expect(body.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
  // "Send another inquiry" returns a clean form.
  await page.click("[data-again]");
  await expect(page.locator("#contact-form")).toBeVisible();
  await expect(page.locator("#name")).toHaveValue("");
});

test("double-click while in flight sends exactly one request", async ({ page }) => {
  let count = 0;
  await configured(page);
  await page.route(API, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    count += 1;
    await new Promise((r) => setTimeout(r, 400));
    return route.fulfill(json(201, { ok: true, id: "DBL0000001" }));
  });
  await fillValid(page);
  await page.dispatchEvent("#contact-form", "submit");
  await page.dispatchEvent("#contact-form", "submit");
  await page.dispatchEvent("#contact-form", "submit");
  await expect(page.locator("#inquiry-success")).toBeVisible();
  expect(count).toBe(1);
});

test("server error: not confirmed, input preserved, no success; retry reuses the key and can succeed", async ({ page }) => {
  const keys = [];
  let fail = true;
  await configured(page);
  await page.route(API, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    keys.push(route.request().postDataJSON().idempotencyKey);
    return fail ? route.fulfill(json(500, { ok: false, error: "server" })) : route.fulfill(json(200, { ok: true, id: "RETRY00001", duplicate: true }));
  });
  await fillValid(page, { message: "Keep this text" });
  await submit(page);
  const status = page.locator("#form-status");
  await expect(status).toBeVisible();
  const text = (await status.innerText()).toLowerCase();
  expect(text).toContain("couldn't confirm");
  expect(text).toContain("try again");
  await expect(status.locator("a[href='mailto:kaibecker13@gmail.com']")).toBeVisible();
  await expect(status.locator("a[href='tel:+14804048969']")).toBeVisible();
  await expect(page.locator("#inquiry-success")).toBeHidden();
  await expect(page.locator("#message")).toHaveValue("Keep this text");
  await expect(page.locator("#contact-form button[type=submit]")).toBeEnabled();
  fail = false;
  await submit(page);
  await expect(page.locator("#inquiry-success")).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]); // same content => same idempotency key => no duplicate possible
});

test("editing the content after a failure uses a new idempotency key", async ({ page }) => {
  const keys = [];
  await configured(page);
  await page.route(API, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    keys.push(route.request().postDataJSON().idempotencyKey);
    return route.fulfill(json(503, { ok: false, error: "server" }));
  });
  await fillValid(page);
  await submit(page);
  await expect(page.locator("#form-status")).toContainText("couldn't confirm");
  await page.fill("#message", "Edited message");
  await submit(page);
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
});

test("network failure is reported as not confirmed (never success)", async ({ page }) => {
  await configured(page);
  await page.route(API, (route) => route.abort("failed"));
  await fillValid(page);
  await submit(page);
  await expect(page.locator("#form-status")).toContainText("couldn't confirm");
  await expect(page.locator("#inquiry-success")).toBeHidden();
  await expect(page.locator("#name")).toHaveValue("Jamie Client");
});

test("200 responses that are not a clear stored-ok are NOT treated as success", async ({ page }) => {
  await configured(page);
  const replies = [
    { status: 200, contentType: "text/html", body: "<html>captive portal</html>", headers: { "access-control-allow-origin": "*" } },
    json(200, { ok: false }),
    json(200, { ok: true }), // no id
    json(202, { ok: true, id: "X" }), // not 200/201
  ];
  let i = 0;
  await page.route(API, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    return route.fulfill(replies[i++ % replies.length]);
  });
  await fillValid(page);
  for (let n = 0; n < replies.length; n++) {
    await submit(page);
    await expect(page.locator("#form-status")).toContainText("couldn't confirm");
    await expect(page.locator("#inquiry-success")).toBeHidden();
    await expect(page.locator("#contact-form button[type=submit]")).toBeEnabled();
  }
});

test("server-side validation errors are shown on the right fields", async ({ page }) => {
  await configured(page);
  await page.route(API, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    return route.fulfill(json(400, { ok: false, error: "validation", fields: { email: "Enter a valid email address." } }));
  });
  await fillValid(page);
  await submit(page);
  await expect(page.locator("#email-error")).toHaveText("Enter a valid email address.");
  await expect(page.locator("#email")).toBeFocused();
  await expect(page.locator("#inquiry-success")).toBeHidden();
});

test("rate limited: tells the visitor it was not sent and offers email/phone", async ({ page }) => {
  await configured(page);
  await page.route(API, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
    return route.fulfill(json(429, { ok: false, error: "rate_limited" }));
  });
  await fillValid(page);
  await submit(page);
  const text = (await page.locator("#form-status").innerText()).toLowerCase();
  expect(text).toContain("not sent");
  await expect(page.locator("#inquiry-success")).toBeHidden();
});

test("client-side validation still blocks empty submits before any request", async ({ page }) => {
  let requests = 0;
  await configured(page);
  await page.route(API, (route) => {
    requests += 1;
    return route.abort();
  });
  await submit(page);
  await expect(page.locator("#name-error")).toBeVisible();
  expect(requests).toBe(0);
});

test("honeypot field is invisible and unreachable for people", async ({ page }) => {
  await page.goto("contact.html");
  const hp = page.locator("#website");
  expect(await hp.getAttribute("tabindex")).toBe("-1");
  expect(await hp.evaluate((e) => e.closest(".hp-field").getAttribute("aria-hidden"))).toBe("true");
  const box = await hp.boundingBox();
  expect(box === null || box.x < -1000).toBe(true);
  await expect(hp).toHaveValue("");
});

test("a non-https (non-localhost) API URL is refused: form stays in the truthful unavailable mode", async ({ page }) => {
  await page.route("**/scripts/site-config.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: 'window.SITE_CONFIG = { inquiryApiUrl: "http://api.insecure.example/api/inquiries" };' })
  );
  const requests = [];
  page.on("request", (r) => r.url().includes("insecure.example") && requests.push(r.url()));
  await page.goto("contact.html");
  await expect(page.locator("#form-notice")).toBeVisible();
  await page.fill("#name", "T");
  await page.fill("#email", "t@example.com");
  await page.selectOption("#sessionType", "Cars");
  await page.fill("#message", "hi");
  await page.click("#contact-form button[type=submit]");
  await expect(page.locator("#form-status")).toContainText("not available yet");
  expect(requests).toEqual([]);
});
