# Kaileb Becker Photography — Site Build Instructions

Static site for a photography business, separate from Kaileb's engineering
portfolio. Plain HTML/CSS/JS, no framework, mobile-first responsive.

## Folder structure

```
/index.html
/collections.html
/gallery.html
/pricing.html
/about.html
/contact.html
/styles/main.css
/scripts/main.js
/images/graduations/
/images/proposals/
/images/cars/
/images/portraits/
```

**Categories changed after the initial spec, more than once.** The original
spec (and this file, until it was corrected) was built around Weddings/
Engagements/Portraits/Events. As real shoots came in, the categories became
Graduations, Proposals, and Cars — collections.html and gallery.html were
updated first, and index.html/pricing.html/contact.html/about.html were
brought in line with them afterward. Portraits was added back as a fourth
category (no real shoot yet, so it still uses the off-white placeholder
graphics in `images/portraits/`). Weddings was then added back as a fifth
category too, but **only on the marketing pages** (index.html services
grid, pricing.html, contact.html dropdown, about.html copy, and every
page's footer) — Kaileb has no wedding photos yet, so gallery.html and
collections.html deliberately do NOT have a Weddings section or scroll-page.
Don't add one until real wedding photos exist; adding a Weddings entry to
collections.html without a matching `gallery.html#weddings` section would
produce a dead link.

Current site-wide category order (used consistently across index.html
services, pricing.html cards, and the contact.html dropdown): **Weddings,
Proposals, Graduations, Cars, Portraits.**

`images/weddings/` still has its old SVG placeholders (unused — no page
references them). `images/engagements/` and `images/events/` are leftover
empty folders from the old spec. If a real engagement/event shoot happens,
add it as its own category the same way Cars, Portraits, and Weddings were
added — full restore only once there's a plan for real photos, marketing-
pages-only restore (like Weddings) if photos are still pending.

`collections.html` was added after the initial spec (see below) — it
restores a page design recovered from Kaileb's site history that didn't
fit into a single gallery.html.

`pricing.html` was added after the initial spec too — a public pricing
page sourced from the price sheet PDF, linked from the nav alongside
Gallery/About/Contact. Keep it in sync with the PDF if pricing changes.
When the categories were renamed, each new category kept the closest
existing dollar amount: Weddings kept its original rate, Graduations ← old
Events rate, Proposals ← old Engagements rate, Cars and Portraits ← old
Portraits rate (confirmed by Kaileb — Cars and Portraits are priced
identically).

## Design reference

Use the attached homepage screenshot as the exact design reference — match
layout, dark background with photo overlay, off-white + near-black
palette (no green), typography (large stacked name headline), and
pill-style badges.

Keep tagline: "Hi, I'm Kaileb — a photographer capturing life's biggest
moments, one frame at a time."

## Homepage (index.html)

- Match screenshot exactly for the hero.
- Primary button: "Book a Session →" → links to contact.html
- Secondary text link next to it: "View Gallery" → links to collections.html
- Below the hero: services section, 5 cards (Weddings, Proposals,
  Graduations, Cars, Portraits — see category order note above), each
  linking to that category's anchor on pricing.html
  (e.g. `pricing.html#graduations`)
- Below that: 6-image gallery teaser grid with a "View Full Gallery" link
- Footer: contact info + social links

## Collections (collections.html) — recovered page, not in the original spec

Full-bleed scroll-landing: one 100vh section per category with real or
placeholder photos and a gallery.html section (currently Graduations,
Proposals, Cars, Portraits — no Weddings section, see note above), each
with its own background photo, giant title, tagline, and a
"View Gallery →" link to that category's
anchor on gallery.html. Desktop: mouse-wheel pages between sections with
a fade transition; side dot-nav jumps directly. Mobile: sections stack
and scroll normally, dot-nav hidden. This is the recovered
PhotographyCollections.html/Photography.css design, off-white instead of
the original sage-green.

## Gallery (gallery.html)

- NOT a filter-tab UI. Grouped sections, one per category
  (`<div class="category-block" id="graduations">` etc.), each with its own
  `<h2 class="category-title">` and a `.photo-grid` of `.photo-item` cards
  — matches the recovered PhotosPage.html/Photos.css design: light
  section background, slight alternating rotation, hover overlay
  ("VIEW IMAGE"), typewriter-effect location caption.
- Click a photo → simple full-screen lightbox (click outside or × to
  close, Escape works too). No counter/arrows — matches the recovered
  design, which didn't have them.
- Lazy-loaded images (`loading="lazy"`).
- Graduations, Proposals, and Cars have real photos. Portraits has no real
  shoot yet and uses the off-white placeholder graphics in
  `images/portraits/` — swap in real photos once a portrait session
  happens. If another new category is added before real photos exist for
  it, follow the same placeholder pattern rather than fabricating photos.

## About (about.html)

- Kaileb's story as a photographer (not engineering bio)
- Testimonials section (leave placeholder structure even with no quotes yet)

## Contact (contact.html)

Form fields: name, email, phone, session type (dropdown: Weddings /
Proposals / Graduations / Cars / Portraits), preferred date, location,
message.

**Submission handling — stub for now, see BACKEND.md.** On submit:
`console.log` the form data and show a "Thanks, I'll be in touch!"
success message on the page. Leave a clear comment in the JS marking
where real submission logic (a `fetch()` POST to a backend endpoint)
will go later.

## SEO

- Unique `<title>` + `<meta name="description">` per page, including
  "Arizona photographer"
- Open Graph tags (`og:title`, `og:image`, `og:description`)
- `sitemap.xml` and `robots.txt`
- Descriptive `alt` text on every image
- Semantic HTML throughout (`<header>`, `<main>`, `<section>`, `<footer>`)

## Explicitly deferred

Hosting and the real contact-form backend are not decided yet — see
BACKEND.md. Don't build anything that assumes a specific host.
