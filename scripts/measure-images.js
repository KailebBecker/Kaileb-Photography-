// Measures image bytes a visitor downloads per page (dev tool, not part of the site).
//   npm run serve   (in another terminal)   then   node scripts/measure-images.js [label]
// Reports, per profile and page: image bytes + request count on initial load, and
// after scrolling the whole page (to trigger lazy loading), plus the LCP element.
const { chromium, devices } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://localhost:4173";
const PROFILES = {
  "mobile 390px @3x": { ...devices["iPhone 13"] },
  "desktop 1440px @1x": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  "desktop 1440px @2x": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
};
const PAGES = ["index", "collections", "gallery"];

(async () => {
  const browser = await chromium.launch();
  const rows = [];
  for (const [profile, opts] of Object.entries(PROFILES)) {
    for (const name of PAGES) {
      const ctx = await browser.newContext(opts);
      const page = await ctx.newPage();
      let bytes = 0;
      let count = 0;
      const seen = new Set();
      page.on("response", async (res) => {
        const type = res.headers()["content-type"] || "";
        // Some static servers send AVIF as octet-stream, so also match on extension.
        const isImage = type.startsWith("image/") || /\.(avif|webp|jpe?g|png|svg)(\?|$)/i.test(res.url());
        if (!isImage || seen.has(res.url())) return;
        seen.add(res.url());
        count += 1;
        // Static server sends Content-Length; this is the transferred image size.
        bytes += Number(res.headers()["content-length"] || 0);
      });
      await page.addInitScript(() => {
        window.__lcp = null;
        new PerformanceObserver((list) => {
          const e = list.getEntries().pop();
          window.__lcp = { t: Math.round(e.startTime), url: e.url ? e.url.split("/").slice(-2).join("/") : e.element && e.element.tagName };
        }).observe({ type: "largest-contentful-paint", buffered: true });
      });
      await page.goto(`${BASE}/${name}.html`, { waitUntil: "load" });
      await page.waitForTimeout(800);
      const initial = { bytes, count };
      const lcp = await page.evaluate(() => window.__lcp);
      // Scroll through the whole page in viewport steps to trigger lazy loading.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < height; y += 500) {
        await page.evaluate((y) => window.scrollTo(0, y), y);
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(800);
      rows.push({ profile, page: name, initialKB: Math.round(initial.bytes / 1024), initialReqs: initial.count, fullKB: Math.round(bytes / 1024), fullReqs: count, lcp: lcp ? `${lcp.t}ms ${lcp.url}` : "n/a" });
      await ctx.close();
    }
  }
  await browser.close();
  console.log(process.argv[2] || "measurement");
  console.table(rows);
})();
