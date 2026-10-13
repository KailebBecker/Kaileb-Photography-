const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const PAGES = ["index", "collections", "gallery", "pricing", "about", "contact"];

/* ---------- every page: loads clean, no overflow ---------- */
for (const name of PAGES) {
  test(`${name}: no console errors, no failed requests, no horizontal overflow`, async ({ page }) => {
    const problems = [];
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    page.on("requestfailed", (r) => problems.push("FAILED " + r.url()));
    page.on("pageerror", (e) => problems.push(e.message));
    const external = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (!/^https?:$/.test(u.protocol)) return; // data: etc.
      if (u.origin !== new URL(page.url() === "about:blank" ? r.url() : page.url()).origin) external.push(r.url());
    });
    await page.goto(`${name}.html`);
    await page.waitForLoadState("load");
    // Google Fonts are third-party and may be unreachable offline; only fail on first-party problems.
    expect(external, "no third-party requests (fonts etc. are self-hosted)").toEqual([]);
    const own = problems.filter((p) => !/fonts\.(googleapis|gstatic)\.com/.test(p) && !/ERR_(FAILED|INTERNET|NAME)/.test(p));
    expect(own).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

/* ---------- accessibility (axe) ---------- */
for (const name of PAGES) {
  test(`${name}: axe has no serious/critical violations`, async ({ page }) => {
    await page.goto(`${name}.html`);
    await page.waitForTimeout(300);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const bad = results.violations.filter((v) => ["serious", "critical"].includes(v.impact));
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(" | ")}`)).toEqual([]);
  });
}

/* ---------- touch targets ---------- */
test("header controls and hero link meet touch-target size", async ({ page }) => {
  await page.goto("index.html");
  for (const sel of ["#nav-toggle", ".site-header .logo", ".header-cta"]) {
    const box = await page.locator(sel).first().boundingBox();
    if (!box) continue; // e.g. nav-toggle is hidden on desktop
    expect(box.height, sel).toBeGreaterThanOrEqual(43.5);
    if (sel === "#nav-toggle") expect(box.width, sel).toBeGreaterThanOrEqual(43.5);
  }
  // The hero "View Gallery" text link keeps its visual size but its hit area extends to 44px.
  const hit = await page.evaluate(() => {
    const el = document.querySelector(".hero-gallery-link");
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    return [r.top - 8, r.bottom + 8].map((y) => document.elementFromPoint(cx, y) === el);
  });
  expect(hit).toEqual([true, true]);
});

test("mobile: footer and contact links are 44px tall", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  await page.goto("contact.html");
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll(".footer-links a, .contact-info-list a, .footer-social a")].map((a) => Math.round(a.getBoundingClientRect().height))
  );
  expect(heights.length).toBeGreaterThan(5);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
});

/* ---------- reveal content must exist without JS enhancement ---------- */
test("reveal + typewriter content is visible with JavaScript disabled", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  for (const [file, sel] of [["index", ".service-card"], ["pricing", ".pricing-card"], ["gallery", ".photo-caption"], ["about", ".about-story"]]) {
    await page.goto(`${file}.html`);
    const m = await page.locator(sel).first().evaluate((e) => ({ o: getComputedStyle(e).opacity, w: e.getBoundingClientRect().width }));
    expect(Number(m.o), file).toBe(1);
    expect(m.w, file).toBeGreaterThan(20);
  }
  await ctx.close();
});

test("reveal content becomes visible with JS on (scrolling in)", async ({ page }) => {
  await page.goto("pricing.html");
  const last = page.locator(".pricing-card").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toHaveCSS("opacity", "1");
});

test("reveal content is visible under prefers-reduced-motion", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("gallery.html");
  const cap = page.locator(".photo-caption").first();
  await expect(cap).toHaveCSS("opacity", "1");
  expect(await cap.evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(40);
  await ctx.close();
});

/* ---------- navigation (keyboard) ---------- */
test("mobile nav toggles via keyboard and exposes aria-expanded; Escape closes", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  await page.goto("about.html");
  const toggle = page.locator("#nav-toggle");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#primary-nav a").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
});

/* ---------- contact form: truthful interim behavior (no backend until M5) ---------- */
test.describe("contact form", () => {
  test("empty submit shows inline errors, focuses the first, never reports success, sends nothing", async ({ page }) => {
    const sent = [];
    page.on("request", (r) => !["GET", "HEAD"].includes(r.method()) && sent.push(r.url()));
    await page.goto("contact.html");
    await page.click("#contact-form button[type=submit]");
    await expect(page.locator("#name")).toBeFocused();
    await expect(page.locator("#name")).toHaveAttribute("aria-invalid", "true");
    for (const id of ["name", "email", "sessionType", "message"]) await expect(page.locator(`#${id}-error`)).toBeVisible();
    const status = (await page.locator("#form-status").innerText()).toLowerCase();
    expect(status).not.toMatch(/thanks|sent|received|in touch/);
    expect(sent).toEqual([]);
  });

  test("invalid email is rejected", async ({ page }) => {
    await page.goto("contact.html");
    await page.fill("#name", "Test");
    await page.fill("#email", "not-an-email");
    await page.selectOption("#sessionType", "Cars");
    await page.fill("#message", "Hello");
    await page.click("#contact-form button[type=submit]");
    await expect(page.locator("#email-error")).toBeVisible();
    await expect(page.locator("#email")).toBeFocused();
  });

  test("date picker has a min and past dates are rejected", async ({ page }) => {
    await page.goto("contact.html");
    expect(await page.getAttribute("#preferredDate", "min")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await page.fill("#name", "Test");
    await page.fill("#email", "t@example.com");
    await page.selectOption("#sessionType", "Cars");
    await page.fill("#message", "Hello");
    await page.fill("#preferredDate", "2020-01-01");
    await page.click("#contact-form button[type=submit]");
    await expect(page.locator("#preferredDate-error")).toBeVisible();
  });

  test("valid details: says online submission is unavailable, shows real contact paths, keeps data, sends nothing, logs no PII", async ({ page }) => {
    const sent = [];
    const logs = [];
    page.on("request", (r) => !["GET", "HEAD"].includes(r.method()) && sent.push(r.url()));
    page.on("console", (m) => logs.push(m.text()));
    await page.goto("contact.html");
    await page.fill("#name", "Test Person");
    await page.fill("#email", "test@example.com");
    await page.selectOption("#sessionType", "Cars");
    await page.fill("#message", "Unique-message-123");
    await page.click("#contact-form button[type=submit]");
    const status = page.locator("#form-status");
    await expect(status).toBeVisible();
    const text = (await status.innerText()).toLowerCase();
    expect(text).toMatch(/not available|isn't available|not currently/);
    expect(text).not.toMatch(/thanks|be in touch|has been sent|we received|i received/);
    await expect(status.locator("a[href='mailto:kaibecker13@gmail.com']")).toBeVisible();
    await expect(status.locator("a[href='tel:+14804048969']")).toBeVisible();
    await expect(page.locator("#message")).toHaveValue("Unique-message-123");
    expect(sent).toEqual([]);
    expect(logs.join("\n")).not.toContain("test@example.com");
  });

  test("the unavailable notice is in static HTML and the form has no submit target (JS disabled)", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("contact.html");
    await expect(page.locator(".form-notice")).toBeVisible();
    expect((await page.locator(".form-notice").innerText()).toLowerCase()).toMatch(/not available|isn't available|not currently/);
    expect(await page.locator("#contact-form").getAttribute("action")).toBeNull();
    // Without JS the submit button ships disabled, so the form cannot post anywhere.
    await expect(page.locator("#contact-form button[type=submit]")).toBeDisabled();
    await ctx.close();
  });
});

/* ---------- collections: native scrolling + keyboard ---------- */
test.describe("collections", () => {
  test("wheel is not hijacked: native scrolling moves the page", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await page.goto("collections.html");
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test("all links reachable; dots and PageDown/PageUp move between sections", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await page.goto("collections.html");
    const links = page.locator(".scroll-section a");
    await expect(links).toHaveCount(4);
    for (const i of [0, 1, 2, 3]) {
      await expect(links.nth(i)).not.toHaveAttribute("tabindex", "-1");
      await expect(page.locator(".scroll-section").nth(i)).not.toHaveAttribute("aria-hidden", "true");
    }
    const idx = () => page.evaluate(() => Math.round(window.scrollY / window.innerHeight));
    await page.locator(".dot").nth(2).click();
    await expect.poll(idx).toBe(2);
    await expect(page.locator(".dot").nth(2)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("PageDown");
    await expect.poll(idx).toBe(3);
    // Let the browser's smooth-scroll animation settle before the next key (a keypress mid-animation can be dropped).
    let last = -1;
    await expect
      .poll(async () => {
        const y = await page.evaluate(() => window.scrollY);
        const settled = y === last;
        last = y;
        return settled;
      }, { intervals: [150] })
      .toBe(true);
    await page.keyboard.press("PageUp");
    await expect.poll(idx).toBeLessThanOrEqual(2);
  });

  test("a focused collection link has a visible focus indicator", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop");
    await page.goto("collections.html");
    await page.keyboard.press("Tab"); // skip link
    await page.locator(".scroll-section a").first().focus();
    const outline = await page.locator(".scroll-section a").first().evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(outline).not.toBe("none");
  });

  test("mobile: sections stack and scroll normally; dot-nav hidden", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile");
    await page.goto("collections.html");
    await expect(page.locator(".scroll-dots")).toBeHidden();
    const tops = await page.locator(".scroll-section").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top + window.scrollY)));
    expect(tops[1]).toBeGreaterThan(tops[0]);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");
  });
});

/* ---------- gallery + lightbox ---------- */
test.describe("gallery & lightbox", () => {
  test("category jump nav links to existing category blocks", async ({ page }) => {
    await page.goto("gallery.html");
    const hrefs = await page.locator(".gallery-jump a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs).toEqual(["#graduations", "#proposals", "#cars", "#portraits"]);
    for (const h of hrefs) await expect(page.locator(h)).toHaveCount(1);
  });

  test("keyboard: open, arrow-navigate within category (wraps), Tab stays inside, Escape restores focus", async ({ page }) => {
    await page.goto("gallery.html#cars");
    const items = page.locator("#cars .photo-item");
    expect(await items.count()).toBeGreaterThan(2);
    await items.first().focus();
    await page.keyboard.press("Enter");
    const box = page.locator("#lightbox");
    await expect(box).toHaveClass(/active/);
    await expect(page.locator(".lightbox-close")).toBeFocused();
    const img = page.locator("#lightbox-img");
    const src0 = await img.getAttribute("src");
    await page.keyboard.press("ArrowRight");
    const src1 = await img.getAttribute("src");
    expect(src1).not.toBe(src0);
    expect(src1).toContain("images/cars/");
    await page.keyboard.press("ArrowLeft");
    expect(await img.getAttribute("src")).toBe(src0);
    await page.keyboard.press("ArrowLeft"); // wraps to the last photo of the category
    expect(await img.getAttribute("src")).toContain("images/cars/");
    await page.locator(".lightbox-next").click(); // wraps back to the first
    expect(await img.getAttribute("src")).toBe(src0);
    await expect(page.locator("#lightbox-status")).toContainText(/Image 1 of \d+/);
    expect(await page.locator("#main").getAttribute("inert")).not.toBeNull();
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.getElementById("lightbox").contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(box).not.toHaveClass(/active/);
    await expect(items.first()).toBeFocused();
    expect(await page.locator("#main").getAttribute("inert")).toBeNull();
  });

  test("close button and backdrop click close it", async ({ page }) => {
    await page.goto("gallery.html#proposals");
    await page.locator("#proposals .photo-item").first().click();
    await page.locator(".lightbox-close").click();
    await expect(page.locator("#lightbox")).not.toHaveClass(/active/);
    await page.locator("#proposals .photo-item").first().click();
    await page.mouse.click(3, 3);
    await expect(page.locator("#lightbox")).not.toHaveClass(/active/);
  });

  test("mobile: controls are 44px and swipe changes photo", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile");
    await page.goto("gallery.html#cars");
    await page.locator("#cars .photo-item").first().tap();
    const img = page.locator("#lightbox-img");
    const src0 = await img.getAttribute("src");
    for (const sel of [".lightbox-close", ".lightbox-prev", ".lightbox-next"]) {
      const b = await page.locator(sel).boundingBox();
      expect(b.width, sel).toBeGreaterThanOrEqual(43.5);
      expect(b.height, sel).toBeGreaterThanOrEqual(43.5);
    }
    const swipe = (dx) =>
      page.evaluate((dx) => {
        const lb = document.getElementById("lightbox");
        const touch = (x) => new Touch({ identifier: 1, target: lb, clientX: x, clientY: 400 });
        lb.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch(200)], changedTouches: [touch(200)] }));
        lb.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [touch(200 + dx)] }));
      }, dx);
    await swipe(-120);
    expect(await img.getAttribute("src")).not.toBe(src0);
    await swipe(120);
    expect(await img.getAttribute("src")).toBe(src0);
  });
});
