# Current Product Audit (as of 2026-10-12)

Evidence legend: **[V]** verified in repo or running browser (Playwright/Chromium at 390×844 and 1440×900, served via `python -m http.server`); **[R]** recommendation; **[A]** assumption.
This is a point-in-time snapshot. Do not re-audit; update `STATE.md` instead.

## What exists today [V]
- 6 static HTML pages (index, collections, gallery, pricing, about, contact), one `styles/main.css` (1644 lines), one `scripts/main.js` (293 lines). No build step, no dependencies, no tests, no CI, no deployment config, no analytics.
- 39 JPEGs (6.4 MB total): graduations 24, proposals 8, cars 6, plus hero. Portraits/weddings are SVG placeholders. Max image 2000×3000, ≤650 KB, typical ~160 KB. **These are already web-sized derivatives, not originals.**
- Contact form: client-side only. **Nothing is sent or stored.** `console.log` + a success message (see `scripts/main.js` `initContactForm`).
- SEO basics present: unique titles/descriptions, canonical, Open Graph, sitemap.xml, robots.txt, one `<h1>` per page, alt text. Domain `www.kailebbeckerphotography.com` is hardcoded; ownership/DNS unverified [A].
- `BACKEND.md` records two pre-existing intentions: leads forward to **Wise Agent CRM** (a real-estate CRM) via a server-side token, and hosting on an **AWS box from a personal contact** (type/access unknown).

## Customer journey walk-through [V]
1. Home: strong photo-led hero, clear "Book a Session" CTA. Good.
2. Browse: collections (full-bleed paged landing) → gallery (grouped grids) → lightbox. Works; mobile and desktop both OK, no console errors, no horizontal overflow on any page at either size.
3. Pricing: clear starting rates per category; mentions "a deposit is required" but there is no way to pay one or any stated amount/method.
4. About: story copy is generic; the three testimonials are placeholders; the portrait is an SVG placeholder (no photo of Kaileb).
5. Inquire: form accepts **empty submission and shows "Thanks, I'll be in touch!"** [V — clicked submit with every field empty]. A visitor who submits today believes they booked; the lead is lost. **This is the #1 problem.**
6. Booking: there is no booking path beyond "send an inquiry", no availability signal, no confirmation email, no owner notification.

## Findings by area

### Product / business (priority order)
| # | Finding | Sev |
|---|---|---|
| P1 | Form loses every lead and falsely confirms success; no validation despite `required` attrs (form is `novalidate`, no JS validation) | Critical |
| P2 | No owner notification, storage, or follow-up workflow | Critical |
| P3 | No availability signal; date field has no `min` (past dates accepted) | High |
| P4 | Deposit promised on pricing page with no mechanism or amount | High |
| P5 | Pricing page promises "private online gallery… full digital image rights" — no delivery mechanism exists | Medium (owner process, not site) |
| P6 | "Discount code" field exists with no defined codes or meaning | Low |
| P7 | No trust content: testimonials empty, no photo of Kaileb, no named venues/press; Instagram handle (`@chai_photographyy`) differs from business name — brand inconsistency | Medium |
| P8 | Weddings is a marketed category with zero photos and no gallery section (intentional per CLAUDE.md, but a credibility risk for the top-priced service) | Medium |

### Visual / UX
- Strengths [V]: photography leads on home and collections; type pairing (Playfair + Inter) reads editorial; warm off-white palette; restrained motion; gallery captions/alternating tilt give personality.
- U1 **Palette contradicts CLAUDE.md**: CLAUDE.md says "no green"; CSS accent is sage `#7c9d72` (header CTA, "Becker" wordmark, dots). Either update CLAUDE.md or the CSS — owner choice (low-stakes; recorded in STATE.md).
- U2 Heavy dark/olive overlay on the collections photos and gradient on the header mutes the photography (desktop screenshot). Lighter, more neutral scrim would be more photo-first.
- U3 Collections desktop hijacks the mouse wheel (`preventDefault`, 800 ms lock); trackpads/keyboards (no arrow-key paging) are second-class. Content is only reachable by wheel/dots/links.
- U4 Lightbox has no prev/next/swipe; on mobile a visitor must close and re-open for each photo. The brief spec'd "simple", but for a portfolio sold on browsing, prev/next + swipe is V1-worthy.
- U5 `.reveal` content is `opacity:0` until JS adds a class; **no no-JS or JS-failure fallback** [V in CSS].
- U6 Gallery is one long page: 21,000 px tall on mobile (3 categories × many photos), no in-page category jump nav.
- U7 `.html` URLs and inline `style=` in footers: minor polish.

### Mobile [V]
- No horizontal overflow on any page. Nav toggle works.
- Touch targets under 44 px: hamburger 42×38, logo 125×32, mobile nav links 24 px tall, "View Gallery" text link 27 px, contact info links 20 px, footer links ~24 px. Gallery photo cards and form inputs (44 px) are fine.
- Form usability: native `type=date`/`tel`/`email` used (good) but no inline errors since validation is missing.

### Accessibility
- Good [V]: skip link, `aria-current`, labelled controls, lightbox is `role=dialog aria-modal`, Escape/× close, `inert` on background, focus returned to trigger, `prefers-reduced-motion` handled in three places, `aria-live` form status.
- Gaps: empty-submit behavior (no error association or `aria-invalid`), touch-target sizes, collections keyboard paging, typewriter caption animation motion (verify it respects reduced motion), contrast of sage-green text on cream and of "Becker" on photo hero (needs measured check in M1 — not measured here).

### Performance [V unless noted]
- Total image weight is small (6.4 MB across all pages); mobile gallery first load fetched ~1.05 MB / 16 requests thanks to `loading="lazy"`.
- No `srcset`/`sizes`, no AVIF/WebP, no `<picture>`; gallery `<img>` tags have **no width/height** (layout shift risk); teaser images do.
- Home hero is a **CSS `background-image` (630 KB, 2400×1600)** → not discoverable by the preload scanner, no preload, no `fetchpriority`; this is the LCP element [A — LCP not measured with Lighthouse; measure in M1].
- Lightbox reuses the grid image (same file); 1088×1633 sources will look soft full-screen on desktop/retina.
- Fonts: Google Fonts (3 families) render-blocking CSS, third-party request.
- No caching/CDN config exists (host-dependent).
- **Image-quality strategy [R]:** originals must be kept out of the repo (private storage); the site serves generated derivatives only. See ARCHITECTURE.md §Images.

### SEO
- Present: titles, descriptions, canonical, OG (image 1200×630 PNG), sitemap, robots. No Twitter card tags, no JSON-LD, no `lastmod`, no per-image alt beyond generic repeated phrases, `og:image` is a generic card.
- V1 SEO: `LocalBusiness`/`ProfessionalService` JSON-LD (Arizona service area), real domain + redirect/canonical consistency, Twitter tags, descriptive unique alt text, Google Business Profile (owner action), clean URLs.
- Later: per-category landing pages with unique copy ("Arizona graduation photographer"), image sitemap, review schema (only with real reviews).

## Repo hygiene [V]
- 2 commits, clean tree. `images/weddings/*.svg`, `images/engagements/`, `images/events/` are unused leftovers. No LICENSE-vs-content concerns noted. No secrets in repo.
