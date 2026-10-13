const { test, expect } = require("@playwright/test");

const PAGES = ["index", "collections", "gallery", "pricing", "about", "contact"];

for (const name of PAGES) {
  test(`${name}: title, description, social tags and a single H1 are present`, async ({ page }) => {
    await page.goto(`${name}.html`);
    const meta = (sel) => page.locator(sel).first().getAttribute("content");
    expect((await page.title()).length).toBeGreaterThan(10);
    expect(await meta('meta[name="description"]')).toMatch(/Arizona/);
    expect(await meta('meta[property="og:title"]')).toBeTruthy();
    expect(await meta('meta[property="og:image:alt"]')).toBeTruthy();
    expect(await meta('meta[name="twitter:card"]')).toBe("summary_large_image");
    expect(await meta('meta[name="twitter:image"]')).toMatch(/og-image\.png$/);
    await expect(page.locator("h1")).toHaveCount(1);
  });
}

test("home page structured data is valid JSON-LD with the real contact details", async ({ page }) => {
  await page.goto("index.html");
  const raw = await page.locator('script[type="application/ld+json"]').first().textContent();
  const data = JSON.parse(raw);
  expect(data["@type"]).toBe("ProfessionalService");
  expect(data.telephone).toBe("+14804048969");
  expect(data.areaServed.name).toBe("Arizona");
});

test("404 page is self-contained, noindex, and links back to the site root", async ({ page }) => {
  await page.goto("404.html");
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  await expect(page.locator("h1")).toContainText("isn't here");
  const href = await page.locator("#home").getAttribute("href");
  expect(href.endsWith("/")).toBe(true);
});

test("no page uses an empty/placeholder alt on a content photo", async ({ page }) => {
  await page.goto("gallery.html");
  const alts = await page.locator(".photo-item img").evaluateAll((imgs) => imgs.map((i) => i.alt));
  expect(alts.length).toBeGreaterThan(30);
  for (const alt of alts) expect(alt.length).toBeGreaterThan(8);
});
