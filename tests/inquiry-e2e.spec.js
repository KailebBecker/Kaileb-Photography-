// Real end-to-end: browser -> the actual inquiry server (Fastify + SQLite) -> dev mail outbox.
// Runs only against the local static server (it needs CORS to allow http://localhost:4173).
const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(ROOT, "server");
const PORT = 4180;
const API = `http://localhost:${PORT}/api/inquiries`;
let proc;
let dir;
let dbFile;
let mailFile;

test.describe.configure({ mode: "serial" });
const skipHere = (info) => info.project.name !== "desktop" || !!process.env.BASE_URL;
test.beforeEach(async ({}, info) => {
  test.skip(skipHere(info), "local desktop only");
});

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("inquiry server did not start");
}

test.beforeAll(async ({}, info) => {
  if (skipHere(info)) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "inq-e2e-"));
  dbFile = path.join(dir, "e2e.db");
  mailFile = path.join(dir, "mail.jsonl");
  proc = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      DB_PATH: dbFile,
      ALLOWED_ORIGINS: "http://localhost:4173",
      NOTIFY_PROVIDER: "dev",
      NOTIFY_TO: "owner@example.test",
      DEV_MAIL_FILE: mailFile,
      RATE_LIMIT_MAX: "100",
    },
    stdio: "ignore",
  });
  await waitForHealth();
});

test.afterAll(async () => {
  if (proc && !proc.killed) proc.kill();
});

function rows() {
  const Database = require(path.join(SERVER_DIR, "node_modules", "better-sqlite3"));
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare("SELECT * FROM inquiries ORDER BY created_at").all();
  } finally {
    db.close();
  }
}

async function open(page, url = "contact.html") {
  await page.route("**/scripts/site-config.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: `window.SITE_CONFIG = { inquiryApiUrl: "${API}", turnstileSiteKey: "" };` })
  );
  await page.goto(url);
}

async function fillAndSend(page, message) {
  await page.fill("#name", "E2E Tester");
  await page.fill("#email", "e2e@example.com");
  await page.fill("#phone", "480-555-0101");
  await page.selectOption("#sessionType", "Cars");
  await page.fill("#location", "Tempe");
  await page.fill("#message", message);
  await page.click("#contact-form button[type=submit]");
}

test("a real browser submission is stored durably, emailed to the owner, and confirmed truthfully", async ({ page }) => {
  await open(page);
  await fillAndSend(page, "E2E message <b>bold</b> & unicode: café");
  await expect(page.locator("#inquiry-success")).toBeVisible();
  const id = (await page.locator("#inquiry-success [data-ref]").innerText()).trim();
  expect(id).toMatch(/^[0-9A-Z]{10}$/);

  const stored = rows();
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ id, status: "new", name: "E2E Tester", email: "e2e@example.com", session_type: "Cars", location: "Tempe", message: "E2E message <b>bold</b> & unicode: café", source_origin: "http://localhost:4173" });

  await expect.poll(() => rows()[0].notify_status).toBe("sent");
  const mails = fs.readFileSync(mailFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(mails).toHaveLength(1);
  expect(mails[0].subject).toContain("Cars");
  expect(mails[0].replyTo).toBe("e2e@example.com");
  expect(mails[0].text).toContain(id);
});

test("a page on a disallowed origin cannot submit: nothing stored, truthful failure", async ({ page }) => {
  const before = rows().length;
  await open(page, "http://127.0.0.1:4173/contact.html");
  await fillAndSend(page, "from the wrong origin");
  await expect(page.locator("#form-status")).toContainText("couldn't confirm");
  await expect(page.locator("#inquiry-success")).toBeHidden();
  expect(rows()).toHaveLength(before);
});

test("when the API is down the visitor is told it was not confirmed, and input is kept", async ({ page }) => {
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  await open(page);
  await fillAndSend(page, "server is down");
  await expect(page.locator("#form-status")).toContainText("couldn't confirm");
  await expect(page.locator("#inquiry-success")).toBeHidden();
  await expect(page.locator("#message")).toHaveValue("server is down");
});
