# Codebase Map (navigation index — source code is authoritative)

Purpose: find where things live without reading the repo. Reflects the site as of M1 (front-end hardening). Update only when file responsibilities or important relationships materially change — not for ordinary edits. Planned-but-nonexistent files (Worker, admin, image scripts) are in ARCHITECTURE.md, not here; add them when created.

## Shape
Plain static site: 6 HTML pages → one `styles/main.css` → one `scripts/main.js`. No build step, no CI, no deploy config. `package.json` is dev-tooling only (Playwright, axe, http-server): `npm test`, or `npm run serve` to browse at :4173.

## Shared page skeleton (duplicated in every HTML page — no templating)
Each page repeats: `<head>` (title, description, OG tags, canonical, inline SVG favicon, Google Fonts, `styles/main.css?v=N`), skip link, `.site-header` + nav (`#nav-toggle`, `#primary-nav`, `.header-cta`), `<main id="main">`, `.site-footer`, `<script src="scripts/main.js?v=N">`. **A change to nav/footer/head/category list must be made in all 6 pages**; `?v=` query strings are manual cache-busters (bump when CSS/JS change). Domain `www.kailebbeckerphotography.com` is hardcoded in canonicals/OG/sitemap/robots.

## Pages
| Path | Responsibility | Owns / key hooks | Relationships | Inspect when |
|---|---|---|---|---|
| `index.html` | Home: transparent-header hero (`.photo-hero`), 5-card services grid (links to `pricing.html#<cat>`), 6-image teaser grid (links `gallery.html#<cat>`) | Only page with `.site-header--transparent` + hero; hero photo is CSS `background-image` of `images/hero-bg.jpg` (not an `<img>`) | Anchors must match `pricing.html` ids and `gallery.html` category ids | Hero/LCP, home CTAs, services copy |
| `collections.html` | Full-bleed landing, one `.scroll-section` per category (Graduations, Proposals, Cars, Portraits — **no Weddings**), `nav.scroll-dots`; native page scroll (no wheel hijack) | Background photos set in CSS (`Background photos per collection`), not HTML; links to `gallery.html#<cat>` | Behavior in `main.js` `initScrollLanding`; sets `body.has-scroll-landing` | Collections UX/keyboard/overlay work |
| `gallery.html` | `.gallery-jump` category nav, then grouped gallery: `.category-block#<cat>` → `.photo-grid` → `.photo-item` (img + overlay + `.typewriter` caption); hosts the `#lightbox` markup (close/prev/next/`#lightbox-status`) at the bottom; loads extra Special Elite font | ~41 hand-written `<img loading=lazy>` with **no width/height or srcset**; categories: graduations (multiple locations/subsections), proposals, cars, portraits (SVG placeholders) | Lightbox/typewriter in `main.js`; category ids are link targets from index/collections; images in `images/<cat>/` | Image pipeline (M2), lightbox (M1), gallery nav, adding photos |
| `pricing.html` | Per-category price cards (`id=weddings…portraits`, reuse `.service-card`), "Good to know" callout (deposit/travel copy), CTA | Prices/inclusions copy; should match owner's price sheet | Ids targeted by index service cards; deposit copy interacts with V1 payments decision | Pricing/terms copy, deposit/cancellation text |
| `about.html` | Photographer story, testimonial grid (placeholders `.testimonial-placeholder`), CTA | Placeholder structure + instructions in an HTML comment | Uses `images/kaileb-portrait.svg` (placeholder) [A — verify before editing] | Trust content (M7) |
| `contact.html` | Contact info card + `#contact-form` (name, email, phone, sessionType, discountCode, preferredDate, location, message), static `.form-notice` (not available yet), per-field `#<id>-error` slots, `#form-status`; submit button ships `disabled` | `novalidate`; JS validation; field names are the future payload keys | Handler: `main.js` `initContactForm` — TEMPORARY no-backend behavior behind `INQUIRY_BACKEND_ENABLED`; M5 replaces it with `POST /api/requests` (V1-SPEC F1) | Form/inquiry work (M1, M5), availability hint |

## Scripts
| Path | Responsibility | Key functions (all init on DOMContentLoaded, each guards for missing DOM) | Inspect when |
|---|---|---|---|
| `scripts/main.js` | Only JS file, shared by all pages. Loaded at end of body; inits run immediately at the bottom of the file, each in try/catch | `initNavToggle` (menu, aria-expanded, Escape) · `initTransparentHeaderOnScroll` · `initScrollLanding` (IntersectionObserver tracks current section → dots/`.active`; dots `scrollIntoView`; no wheel/key handlers) · `initTypewriterCaptions` · `initPhotoLightbox` (per-category prev/next, arrows, swipe, focus trap, `inert` background) · `initContactForm` (validation, min date in Arizona time, truthful unavailable message; M5 replacement point) · `initScrollReveal`. `enableCssEnhancements()` sets `html.js-enhanced`, the only thing that hides `.reveal`/`.typewriter` (progressive enhancement; skipped under reduced motion) | Any behavior change |

## Styles
`styles/main.css` (single file, ~1650 lines; `:root` tokens at top incl. palette `--color-accent` sage). Contrast uses `--color-accent-text` / `--color-accent-deep` (accessible shades; palette decision still open). Section headers to jump by (`grep -n "^/\* ---"`): Reset · Scroll reveal · Buttons & links · Pill badges · Header/nav (+ transparent/scrolled variants, mobile nav) · Hero (`.photo-hero`, grain, mobile overrides) · Sections · Services grid · Pricing cards · Callout · Teaser grid · Collections (native-scroll sections + per-collection background images + max-width 768 centered layout) · Gallery jump-nav · Photo grid (gallery, per-location subsections, rotation) · Lightbox (close/prev/next/status) · About · Contact (+ form notice/error/status states) · Footer · Page hero. Breakpoint 768px is the key mobile/desktop switch and is mirrored in JS (`window.innerWidth > 768`). `prefers-reduced-motion` blocks exist near reveal, collections, and photo grid. Inspect for any visual, touch-target, contrast, or palette work.

## SEO / crawl files
`sitemap.xml` (6 URLs, hardcoded domain, no lastmod) · `robots.txt` (allow all + sitemap) — edit when pages/domain change.

## Images (do not enumerate)
`images/<category>/` (graduations, proposals, cars, portraits[SVG placeholders]) are the gallery sources, referenced directly from HTML/CSS. `images/hero-bg.jpg` home hero; `images/og-image.png|svg` social card; `kaileb-portrait.svg` placeholder. Current JPEGs are already-downsized derivatives, not originals.

## Tests / tooling
`package.json` (dev deps only) · `playwright.config.js` (desktop 1440 + mobile iPhone 13 projects; auto-starts `http-server` on :4173) · `tests/site.spec.js` (single file: page health + overflow, axe per page, touch targets, no-JS/reduced-motion reveal, nav keyboard, contact-form truthfulness, collections, gallery/lightbox). Add new regression tests here. `node_modules/`, `test-results/` are gitignored.

## Docs / meta
`CLAUDE.md` site conventions (categories, page behavior) — keep in sync when behavior changes · `BACKEND.md` legacy Wise Agent/AWS notes (superseded once G1/G3 decided) · `docs/*` planning set (see STATE.md) · `.gitignore` (`.DS_Store`, `Thumbs.db`) · `LICENSE`.

## Cross-cutting coupling to remember
- Category order/names: index services, pricing cards, contact dropdown, footers (all pages), collections, gallery ids, `CLAUDE.md`. Weddings is intentionally marketing-pages-only.
- Anchor contract: `pricing.html#<cat>`, `gallery.html#<cat>`.
- Nav/footer/head are copy-pasted ×6; JS and CSS are shared and guard on element presence.
