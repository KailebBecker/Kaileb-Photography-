// Image pipeline regression tests (M2). File-level checks run once; browser checks run per project.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HTML = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
const KB = 1024;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test.describe("image files (static checks)", () => {
  test.beforeEach(async ({}, info) => {
    test.skip(info.project.name !== "desktop", "file checks run once");
  });

  test("derivatives, manifest and <picture> markup are up to date with the sources", () => {
    expect(() => execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-images.js"), "--check"], { stdio: "pipe" })).not.toThrow();
  });

  test("every <picture data-photo> has dimensions, alt, and existing files", () => {
    let pictures = 0;
    for (const file of HTML) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const m of text.matchAll(/<picture\b[^>]*data-photo="([^"]+)"[^>]*data-preset="([^"]+)"[^>]*>([\s\S]*?)<\/picture>/g)) {
        pictures += 1;
        const [, key, preset, inner] = m;
        const img = /<img\b([^>]*)>/.exec(inner)[1];
        expect(img, `${file} ${key}`).toMatch(/\swidth="\d+"/);
        expect(img, `${file} ${key}`).toMatch(/\sheight="\d+"/);
        expect(img, `${file} ${key}`).toMatch(/\salt="/);
        if (preset === "grid" || preset === "teaser") expect(img, `${file} ${key} needs descriptive alt`).toMatch(/\salt="[^"]{8,}"/);
        const files = [...inner.matchAll(/images\/[^\s",]+\.(?:avif|jpg)/g)].map((x) => x[0]);
        expect(files.length, `${file} ${key}`).toBeGreaterThan(1);
        for (const f of files) expect(fs.existsSync(path.join(ROOT, f)), `${file}: ${f}`).toBe(true);
        expect(inner, `${file} ${key} srcset has sizes`).toMatch(/sizes="/);
      }
    }
    expect(pictures).toBeGreaterThan(45);
  });

  test("no page references an un-optimised raster image or the removed hero-bg.jpg", () => {
    const files = [...HTML.map((f) => path.join(ROOT, f)), path.join(ROOT, "styles", "main.css"), path.join(ROOT, "scripts", "main.js")];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      expect(text, f).not.toContain("hero-bg.jpg");
      // raster files must be hashed derivatives
      for (const m of text.matchAll(/images\/[\w/-]+\.(?:jpe?g|png)\b/g)) {
        if (/og-image\.png/.test(m[0])) continue;
        expect(m[0], `${path.basename(f)} references ${m[0]}`).toMatch(/-[0-9a-f]{8}-\d+\.jpg$/);
      }
    }
  });

  test("derivative size budgets: AVIF grid-range <=300KB, any file <=600KB, legacy JPEG fallback <=400KB", () => {
    const files = walk(path.join(ROOT, "images")).filter((f) => /-[0-9a-f]{8}-\d+\.(avif|jpg)$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) {
      const size = fs.statSync(f).size;
      const width = Number(/-(\d+)\.\w+$/.exec(f)[1]);
      expect(size, path.relative(ROOT, f)).toBeLessThanOrEqual(600 * KB);
      // The JPEG is only for browsers without AVIF (rare), so it gets a looser cap than the AVIF steps.
      if (f.endsWith(".jpg")) expect(size, path.relative(ROOT, f)).toBeLessThanOrEqual(400 * KB);
      else if (width <= 1440) expect(size, path.relative(ROOT, f)).toBeLessThanOrEqual(300 * KB);
    }
  });

  test("sources are never served from images/ and originals/ is gitignored", () => {
    const stray = walk(path.join(ROOT, "images")).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f) && !/-[0-9a-f]{8}-\d+\.jpg$/.test(f) && !/og-image/.test(f));
    expect(stray.map((f) => path.relative(ROOT, f))).toEqual([]);
    expect(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")).toMatch(/^originals\/$/m);
  });
});

const widthOf = (url) => Number((/-(\d+)\.(?:avif|jpg)/.exec(url) || [])[1]);

test("hero is a real high-priority <img>, not a CSS background", async ({ page }) => {
  await page.goto("index.html");
  const hero = page.locator("img.hero-photo");
  await expect(hero).toHaveAttribute("fetchpriority", "high");
  await expect(hero).toHaveAttribute("loading", "eager");
  await expect.poll(() => hero.evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".photo-hero"), "::before").backgroundImage)).toBe("none");
  // It really covers the hero.
  const [h, s] = await Promise.all([hero.boundingBox(), page.locator(".photo-hero").boundingBox()]);
  expect(Math.abs(h.width - s.width)).toBeLessThan(2);
  expect(Math.abs(h.height - s.height)).toBeLessThan(2);
});

test("gallery grid photos are not layout-shifting and use responsive sources", async ({ page }) => {
  await page.goto("gallery.html");
  const info = await page.locator(".photo-item picture img").evaluateAll((imgs) =>
    imgs.map((i) => ({ w: i.getAttribute("width"), h: i.getAttribute("height"), lazy: i.loading, srcset: !!i.closest("picture").querySelector("source[srcset]") }))
  );
  expect(info.length).toBeGreaterThan(30);
  for (const i of info) {
    expect(Number(i.w)).toBeGreaterThan(0);
    expect(Number(i.h)).toBeGreaterThan(0);
    expect(i.lazy).toBe("lazy");
    expect(i.srcset).toBe(true);
  }
});

test("mobile visitors download a small, right-sized gallery", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  const loaded = [];
  page.on("response", (r) => /images\/.*\.(avif|jpg)/.test(r.url()) && loaded.push({ url: r.url(), bytes: Number(r.headers()["content-length"] || 0) }));
  await page.goto("gallery.html");
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 500) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(800);
  expect(loaded.length).toBeGreaterThan(30);
  expect(loaded.every((l) => l.url.endsWith(".avif"))).toBe(true); // modern format served
  expect(Math.max(...loaded.map((l) => widthOf(l.url)))).toBeLessThan(2000); // thumbnails never pull the 2000/2400 px steps
  const total = loaded.reduce((a, l) => a + l.bytes, 0);
  expect(total).toBeLessThan(3.6 * 1024 * KB); // baseline before M2: ~5.8 MB (3 DPR phones still need ~1000px-wide photos)
});

test("lightbox loads a larger derivative than the grid, but not the largest on phones", async ({ page }, info) => {
  await page.goto("gallery.html#cars");
  const first = page.locator("#cars .photo-item").first();
  await first.scrollIntoViewIfNeeded();
  await expect.poll(() => first.locator("img").evaluate((i) => i.complete && i.currentSrc !== "")).toBe(true);
  const gridW = widthOf(await first.locator("img").evaluate((i) => i.currentSrc));
  await first.click();
  const lb = page.locator("#lightbox-img");
  await expect.poll(() => lb.evaluate((i) => i.complete && i.naturalWidth > 0 && /\.avif/.test(i.currentSrc))).toBe(true);
  const lbW = widthOf(await lb.evaluate((i) => i.currentSrc));
  // Desktop: lightbox box is much larger than a grid card. Phones: the grid card is already
  // ~1000 device px wide, so the lightbox may legitimately pick the same step.
  if (info.project.name === "desktop") expect(lbW).toBeGreaterThan(gridW);
  else {
    expect(lbW).toBeGreaterThanOrEqual(gridW);
    expect(lbW).toBeLessThanOrEqual(1440);
  }
  // Next photo keeps working with the picture sources.
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => lb.evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
  // Closing clears the sources so nothing keeps loading behind the page.
  await page.keyboard.press("Escape");
  expect(await page.locator("#lightbox source[srcset]").count()).toBe(0);
});

test("lightbox still works for the non-picture portrait placeholders", async ({ page }) => {
  await page.goto("gallery.html#portraits");
  await page.locator("#portraits .photo-item").first().click();
  const lb = page.locator("#lightbox-img");
  await expect(lb).toHaveAttribute("src", /portraits\/portrait-0\d\.svg/);
  expect(await page.locator("#lightbox source[srcset]").count()).toBe(0);
});

test("collections photos are real images that fill their sections", async ({ page }) => {
  await page.goto("collections.html");
  const imgs = page.locator(".scroll-section .scroll-photo");
  await expect(imgs).toHaveCount(4);
  const first = imgs.first();
  await expect(first).toHaveAttribute("loading", "eager");
  await expect.poll(() => first.evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
  const [a, b] = await Promise.all([first.boundingBox(), page.locator(".scroll-section").first().boundingBox()]);
  expect(Math.abs(a.width - b.width)).toBeLessThan(2);
  expect(Math.abs(a.height - b.height)).toBeLessThan(2);
});
