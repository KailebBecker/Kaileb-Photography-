#!/usr/bin/env node
/* ==========================================================================
   Image pipeline — generates responsive web derivatives from source photos
   and keeps the <picture> markup in the HTML pages in sync.

   npm run images          generate derivatives + manifest, rewrite <picture> markup
   npm run images:check    verify everything is up to date (exit 1 if not; used by tests)

   SOURCES (never modified by this script)
     originals/<category>/<Name>.(jpg|jpeg|png|tif|tiff)   private full-resolution
         originals, gitignored, NEVER committed. Preferred when present.
     source/<category>/<Name>.jpg                          interim sources committed
         to git (today these are already-downsized JPEGs, not true originals).
   Per photo, originals/ wins over source/ if both exist. Keys are
   "<category>/<Name>" and must match between the two trees.

   OUTPUT (generated, reproducible, safe to delete and regenerate)
     images/<category>/<Name>-<hash>-<width>.avif          responsive sizes (AVIF only; see below)
     images/<category>/<Name>-<hash>-<width>.jpg           one JPEG fallback
     images/manifest.json                                  dimensions, hash, widths
   <hash> = first 8 hex of sha1(source bytes + encoder settings), so filenames
   change exactly when pixels or settings change and are safe to cache forever
   (Cache-Control: immutable) on any static host.

   MARKUP — in the pages, author only:
     <picture data-photo="cars/Car1" data-preset="grid"><img alt="Describe it"></picture>
   and this script expands it to <source>/<img> with srcset, sizes, width/height,
   loading/decoding/fetchpriority. Re-running is idempotent. Presets are below.

   Formats: AVIF (all current browsers) + one JPEG fallback. WebP is deliberately not
   generated: it added ~11 MB of committed files for a sliver of browsers that a
   1200 px JPEG already serves acceptably. Add it back here if analytics say otherwise.

   Photos are never upscaled: widths larger than the source are not generated.
   EXIF/GPS metadata is stripped; orientation is applied; colour is sRGB.
   ========================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = [path.join(ROOT, "originals"), path.join(ROOT, "source")]; // first match wins
const OUT_DIR = path.join(ROOT, "images");
const MANIFEST = path.join(OUT_DIR, "manifest.json");
const SOURCE_EXT = /\.(jpe?g|png|tiff?)$/i;
const GENERATED = /-[0-9a-f]{8}-\d+\.(avif|jpg)$/;

/* ----- encoder settings (part of the hash: change them => new filenames) ----- */
// Ladder chosen from real layouts: grid ~390 css px (x1/x2/x3 => 480/960), lightbox up to
// ~1300 css px (=> 1440+), native width as the top step. Capped at 2400; never upscaled.
const WIDTHS = [480, 960, 1440, 2000, 2400];
const FALLBACK_WIDTH = 1200; // the single JPEG for browsers without AVIF/WebP
const SETTINGS = {
  v: 2,
  avif: { quality: 60, effort: 4 },
  jpeg: { quality: 82, mozjpeg: true, progressive: true },
};

/* ----- markup presets ----- */
const GRID_SIZES = "(max-width: 600px) 88vw, 28vw";
const TEASER_SIZES = "(max-width: 699px) 46vw, (max-width: 1240px) 30vw, 380px";
const PRESETS = {
  grid: { sizes: GRID_SIZES, loading: "lazy" },
  teaser: { sizes: TEASER_SIZES, loading: "lazy" },
  hero: { sizes: "100vw", loading: "eager", fetchpriority: "high", imgClass: "hero-photo" },
  cover: { sizes: "100vw", loading: "lazy", imgClass: "scroll-photo" },
  "cover-first": { sizes: "100vw", loading: "eager", fetchpriority: "high", imgClass: "scroll-photo" },
};

const checkOnly = process.argv.includes("--check");
const problems = [];

function sha8(buf) {
  return crypto.createHash("sha1").update(buf).update(JSON.stringify(SETTINGS)).digest("hex").slice(0, 8);
}

function findSources() {
  const found = new Map(); // key -> { file, tree }
  for (const dir of SOURCE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const cat of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!cat.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(dir, cat.name))) {
        if (!SOURCE_EXT.test(f)) continue;
        const key = `${cat.name}/${f.replace(SOURCE_EXT, "")}`;
        if (!found.has(key)) found.set(key, { file: path.join(dir, cat.name, f), tree: path.basename(dir) });
      }
    }
  }
  return found;
}

function widthsFor(sourceWidth) {
  const list = WIDTHS.filter((w) => w < sourceWidth * 0.95);
  list.push(Math.min(sourceWidth, WIDTHS[WIDTHS.length - 1])); // never upscale
  return [...new Set(list)];
}

async function encode(file, width, fmt, out) {
  let img = sharp(file).rotate().resize({ width, withoutEnlargement: true });
  if (fmt === "avif") img = img.avif(SETTINGS.avif);
  else img = img.jpeg(SETTINGS.jpeg);
  await img.toFile(out);
}

async function build() {
  const sources = findSources();
  if (!sources.size) throw new Error("No source photos found in originals/ or source/");
  const manifest = {};
  const expected = new Set();
  let made = 0;

  for (const [key, { file, tree }] of [...sources].sort()) {
    const buf = fs.readFileSync(file);
    const hash = sha8(buf);
    const meta = await sharp(buf).metadata();
    const swap = meta.orientation >= 5;
    const w = swap ? meta.height : meta.width;
    const h = swap ? meta.width : meta.height;
    const [cat, name] = key.split("/");
    const widths = widthsFor(w);
    const fallbackW = widths.includes(FALLBACK_WIDTH) ? FALLBACK_WIDTH : widths[widths.length - 1] < FALLBACK_WIDTH ? widths[widths.length - 1] : widths.find((x) => x >= FALLBACK_WIDTH) || widths[widths.length - 1];
    manifest[key] = { width: w, height: h, hash, source: tree, widths, fallbackWidth: fallbackW };

    const jobs = [];
    for (const width of widths) jobs.push([width, "avif", "avif"]);
    jobs.push([fallbackW, "jpeg", "jpg"]);
    for (const [width, fmt, ext] of jobs) {
      const rel = path.join(cat, `${name}-${hash}-${width}.${ext}`);
      expected.add(rel.replace(/\\/g, "/"));
      const out = path.join(OUT_DIR, rel);
      if (fs.existsSync(out)) continue;
      if (checkOnly) {
        problems.push(`missing derivative: images/${rel.replace(/\\/g, "/")}`);
        continue;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await encode(file, width, fmt, out);
      made += 1;
    }
  }

  // Remove stale generated files (only names matching the generated pattern, only under images/<category>/).
  for (const cat of fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR, { withFileTypes: true }) : []) {
    if (!cat.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(OUT_DIR, cat.name))) {
      const rel = `${cat.name}/${f}`;
      if (GENERATED.test(f) && !expected.has(rel)) {
        if (checkOnly) problems.push(`stale derivative: images/${rel}`);
        else fs.unlinkSync(path.join(OUT_DIR, cat.name, f));
      }
    }
  }

  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const current = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== manifestText) {
    if (checkOnly) problems.push("images/manifest.json is out of date (run npm run images)");
    else fs.writeFileSync(MANIFEST, manifestText);
  }
  return { manifest, made };
}

/* ----- <picture data-photo> expansion ----- */
function escapeAttr(s) {
  return s.replace(/&(?!(?:amp|lt|gt|quot|#\d+);)/g, "&amp;").replace(/"/g, "&quot;");
}

function srcset(cat, name, m, ext) {
  return m.widths.map((w) => `images/${cat}/${name}-${m.hash}-${w}.${ext} ${w}w`).join(", ");
}

function expandPicture(openTag, inner, key, manifest, file) {
  const m = manifest[key];
  if (!m) {
    problems.push(`${file}: no source photo for data-photo="${key}"`);
    return null;
  }
  const presetName = (/data-preset="([^"]+)"/.exec(openTag) || [])[1] || "grid";
  const preset = PRESETS[presetName];
  if (!preset) {
    problems.push(`${file}: unknown data-preset="${presetName}" on ${key}`);
    return null;
  }
  const altMatch = /\balt="([^"]*)"/.exec(inner);
  const alt = altMatch ? altMatch[1] : "";
  if (!altMatch) problems.push(`${file}: <picture data-photo="${key}"> needs an <img alt="...">`);
  const [cat, name] = key.split("/");
  const sizes = escapeAttr(preset.sizes);
  const img = [
    preset.imgClass ? `class="${preset.imgClass}"` : "",
    `src="images/${cat}/${name}-${m.hash}-${m.fallbackWidth}.jpg"`,
    `width="${m.width}"`,
    `height="${m.height}"`,
    `alt="${alt}"`,
    `loading="${preset.loading}"`,
    `decoding="async"`,
    preset.fetchpriority ? `fetchpriority="${preset.fetchpriority}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${openTag}
<source type="image/avif" srcset="${srcset(cat, name, m, "avif")}" sizes="${sizes}">
<img ${img}>
</picture>`;
}

function rewriteHtml(manifest) {
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  const re = /<picture\b([^>]*\bdata-photo="([^"]+)"[^>]*)>([\s\S]*?)<\/picture>/g;
  for (const f of files) {
    const p = path.join(ROOT, f);
    const raw = fs.readFileSync(p, "utf8");
    const crlf = raw.includes("\r\n");
    const text = raw.replace(/\r\n/g, "\n");
    const next = text.replace(re, (whole, attrs, key, inner) => {
      // Re-indent: keep the indentation of the line the <picture> starts on.
      const lineStart = text.lastIndexOf("\n", text.indexOf(whole)) + 1;
      const indent = /^\s*/.exec(text.slice(lineStart))[0];
      const out = expandPicture(`<picture${attrs}>`, inner, key, manifest, f);
      return out === null ? whole : out.split("\n").map((l, i) => (i === 0 ? l : indent + l)).join("\n");
    });
    if (next !== text) {
      if (checkOnly) problems.push(`${f}: <picture> markup is out of date (run npm run images)`);
      else fs.writeFileSync(p, crlf ? next.replace(/\n/g, "\r\n") : next);
    }
  }
}

(async () => {
  const { manifest, made } = await build();
  rewriteHtml(manifest);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(checkOnly ? "images: up to date" : `images: ${Object.keys(manifest).length} photos, ${made} new derivatives`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
