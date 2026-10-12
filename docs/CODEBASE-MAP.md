# Codebase Map (navigation index — source code is authoritative)

Purpose: find where things live without reading the repo. Reflects the pre-M1 static site (commit 35e5ed7). Update only when file responsibilities or important relationships materially change — not for ordinary edits. Planned-but-nonexistent files (Worker, admin, image scripts) are in ARCHITECTURE.md, not here; add them when created.

## Shape
Plain static site: 6 HTML pages → one `styles/main.css` → one `scripts/main.js`. No build, no package.json, no tests, no CI, no deploy config. Open via any static server (e.g. `python -m http.server`).

## Shared page skeleton (duplicated in every HTML page — no templating)
Each page repeats: `<head>` (title, description, OG tags, canonical, inline SVG favicon, Google Fonts, `styles/main.css?v=N`), skip link, `.site-header` + nav (`#nav-toggle`, `#primary-nav`, `.header-cta`), `<main id="main">`, `.site-footer`, `<script src="scripts/main.js?v=N">`. **A change to nav/footer/head/category list must be made in all 6 pages**; `?v=` query strings are manual cache-busters (bump when CSS/JS change). Domain `www.kailebbeckerphotography.com` is hardcoded in canonicals/OG/sitemap/robots.

## Pages
| Path | Responsibility | Owns / key hooks | Relationships | Inspect when |
|---|---|---|---|---|
| `index.html` | Home: transparent-header hero (`.photo-hero`), 5-card services grid (links to `pricing.html#<cat>`), 6-image teaser grid (links `gallery.html#<cat>`) | Only page with `.site-header--transparent` + hero; hero photo is CSS `background-image` of `images/hero-bg.jpg` (not an `<img>`) | Anchors must match `pricing.html` ids and `gallery.html` category ids | Hero/LCP, home CTAs, services copy |
| `collections.html` | Full-bleed scroll-landing, one `.scroll-section` per category (Graduations, Proposals, Cars, Portraits — **no Weddings**), dot-nav | Background photos set in CSS (`Background photos per collection`), not HTML; links to `gallery.html#<cat>` | Behavior in `main.js` `initScrollLanding`; sets `body.has-scroll-landing` | Collections UX/keyboard/overlay work |
| `gallery.html` | Grouped gallery: `.category-block#<cat>` → `.photo-grid` → `.photo-item` (img + overlay + `.typewriter` caption); hosts the `#lightbox` markup at the bottom; loads extra Special Elite font | ~41 hand-written `<img loading=lazy>` with **no width/height or srcset**; categories: graduations (multiple locations/subsections), proposals, cars, portraits (SVG placeholders) | Lightbox/typewriter in `main.js`; category ids are link targets from index/collections; images in `images/<cat>/` | Image pipeline (M2), lightbox (M1), gallery nav, adding photos |
| `pricing.html` | Per-category price cards (`id=weddings…portraits`, reuse `.service-card`), "Good to know" callout (deposit/travel copy), CTA | Prices/inclusions copy; should match owner's price sheet | Ids targeted by index service cards; deposit copy interacts with V1 payments decision | Pricing/terms copy, deposit/cancellation text |
| `about.html` | Photographer story, testimonial grid (placeholders `.testimonial-placeholder`), CTA | Placeholder structure + instructions in an HTML comment | Uses `images/kaileb-portrait.svg` (placeholder) [A — verify before editing] | Trust content (M7) |
| `contact.html` | Contact info card + `#contact-form` (name, email, phone, sessionType, discountCode, preferredDate, location, message) with `#form-status` | Form is `novalidate`; no min date; field names are the payload keys | Handler: `main.js` `initContactForm` (stub: `console.log` + fake success). Future target: `POST /api/requests` (V1-SPEC F1) | Form/inquiry work (M1, M5), availability hint |

## Scripts
| Path | Responsibility | Key functions (all init on DOMContentLoaded, each guards for missing DOM) | Inspect when |
|---|---|---|---|
| `scripts/main.js` | Only JS file, shared by all pages | `initNavToggle` (mobile menu, aria-expanded) · `initTransparentHeaderOnScroll` (is-scrolled class; skipped on collections) · `initScrollLanding` (desktop wheel-hijack paging ≥769px, dots, aria-hidden/tabindex sync, fade-out before navigation) · `initTypewriterCaptions` (IntersectionObserver adds `.animate`) · `initPhotoLightbox` (open/close, Escape, `inert` background, focus return; uses `img.currentSrc`, no prev/next) · `initContactForm` (stub submit) · `initScrollReveal` (adds `.is-visible` to `.reveal`) | Any behavior change; M1 touches form, lightbox, collections, reveal |

## Styles
`styles/main.css` (single file, ~1650 lines; `:root` tokens at top incl. palette `--color-accent` sage). Section headers to jump by (`grep -n "^/\* ---"`): Reset · Scroll reveal · Buttons & links · Pill badges · Header/nav (+ transparent/scrolled variants, mobile nav) · Hero (`.photo-hero`, grain, mobile overrides) · Sections · Services grid · Pricing cards · Callout · Teaser grid · Collections (scroll-landing + per-collection background images + mobile stack override at max-width 768) · Photo grid (gallery, per-location subsections, rotation) · Lightbox · About · Contact · Footer · Page hero. Breakpoint 768px is the key mobile/desktop switch and is mirrored in JS (`window.innerWidth > 768`). `prefers-reduced-motion` blocks exist near reveal, collections, and photo grid. Inspect for any visual, touch-target, contrast, or palette work.

## SEO / crawl files
`sitemap.xml` (6 URLs, hardcoded domain, no lastmod) · `robots.txt` (allow all + sitemap) — edit when pages/domain change.

## Images (do not enumerate)
`images/<category>/` (graduations, proposals, cars, portraits[SVG placeholders]) are the gallery sources, referenced directly from HTML/CSS. `images/hero-bg.jpg` home hero; `images/og-image.png|svg` social card; `kaileb-portrait.svg` placeholder. `images/weddings/` (SVG), `images/engagements/`, `images/events/` are unused leftovers. Current JPEGs are already-downsized derivatives, not originals.

## Docs / meta
`CLAUDE.md` site conventions (categories, page behavior) — keep in sync when behavior changes · `BACKEND.md` legacy Wise Agent/AWS notes (superseded once G1/G3 decided) · `docs/*` planning set (see STATE.md) · `.gitignore` (`.DS_Store`, `Thumbs.db`) · `LICENSE`.

## Cross-cutting coupling to remember
- Category order/names: index services, pricing cards, contact dropdown, footers (all pages), collections, gallery ids, `CLAUDE.md`. Weddings is intentionally marketing-pages-only.
- Anchor contract: `pricing.html#<cat>`, `gallery.html#<cat>`.
- Nav/footer/head are copy-pasted ×6; JS and CSS are shared and guard on element presence.
