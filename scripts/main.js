/* ==========================================================================
   Kaileb Becker Photography — main.js
   Vanilla JS, no dependencies. Every block below guards for the elements
   it needs, so this single file can be shared across all pages.

   Progressive enhancement: every page must be fully readable without this
   file. Scripts load at the end of <body>, so the DOM is already parsed when
   this runs — init happens immediately at the bottom of this file (no
   DOMContentLoaded wait) so reveal animations never flash visible-then-hidden.
   ========================================================================== */


function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* CSS only hides .reveal / .typewriter content under html.js-enhanced, so a
   blocked script, an old browser, or reduced-motion never hides content. */
let enhancementsEnabled = null;
function enableCssEnhancements() {
  if (enhancementsEnabled === null) {
    enhancementsEnabled = "IntersectionObserver" in window && !prefersReducedMotion();
    if (enhancementsEnabled) document.documentElement.classList.add("js-enhanced");
  }
  return enhancementsEnabled;
}

function disableCssEnhancements() {
  enhancementsEnabled = false;
  document.documentElement.classList.remove("js-enhanced");
}

/* ---------- Fade/slide-up reveal on scroll (.reveal elements) ---------- */
function initScrollReveal() {
  const items = document.querySelectorAll(".reveal");
  if (!items.length || !enableCssEnhancements()) return;

  try {
    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );

    items.forEach((item) => {
      // Already on screen at load: show immediately (no fade), better for LCP.
      const rect = item.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) item.classList.add("is-visible");
      else observer.observe(item);
    });
  } catch (err) {
    disableCssEnhancements();
  }
}

/* ---------- Mobile nav toggle ---------- */
function initNavToggle() {
  const toggle = document.getElementById("nav-toggle");
  const nav = document.getElementById("primary-nav");
  if (!toggle || !nav) return;

  function setOpen(isOpen) {
    nav.classList.toggle("is-open", isOpen);
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.setAttribute("aria-label", isOpen ? "Close navigation menu" : "Open navigation menu");
  }

  toggle.addEventListener("click", () => setOpen(!nav.classList.contains("is-open")));

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("is-open")) {
      setOpen(false);
      toggle.focus();
    }
  });
}

/* ---------- Transparent hero header: solid once scrolled past the photo ---------- */
function initTransparentHeaderOnScroll() {
  const header = document.querySelector(".site-header--transparent");
  if (!header) return;

  // collections.html keeps a full-bleed photo behind the header the whole
  // time, so it keeps the light-text treatment throughout rather than
  // switching to solid.
  if (document.body.classList.contains("has-scroll-landing")) return;

  const getThreshold = () => Math.max(window.innerHeight * 0.75, 120);

  function update() {
    header.classList.toggle("is-scrolled", window.scrollY > getThreshold());
  }

  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
}

/* ---------- Collections scroll-landing (collections.html) ---------- */
/* The page scrolls natively (wheel, touch, keyboard). This only tracks which
   section is on screen (for the dot-nav and copy dimming) and lets the dots
   jump between sections. No wheel/keyboard listeners, no scroll locking. */
function initScrollLanding() {
  const landing = document.querySelector(".scroll-landing");
  const sections = Array.from(document.querySelectorAll(".scroll-section"));
  if (!landing || !sections.length) return;

  const dots = Array.from(document.querySelectorAll(".scroll-dots .dot"));

  function setCurrent(index) {
    sections.forEach((section, i) => section.classList.toggle("active", i === index));
    dots.forEach((dot) => {
      const isCurrent = Number(dot.dataset.index) === index;
      dot.classList.toggle("active", isCurrent);
      if (isCurrent) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
    });
  }

  dots.forEach((dot) => {
    dot.addEventListener("click", () => {
      const target = sections[Number(dot.dataset.index)];
      if (target) target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    });
  });

  if (!("IntersectionObserver" in window)) {
    setCurrent(0);
    return; // copy stays fully visible, dots still jump
  }

  document.body.classList.add("has-scroll-landing");
  setCurrent(0);

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) setCurrent(sections.indexOf(entry.target));
      });
    },
    { threshold: 0.5 }
  );
  sections.forEach((section) => observer.observe(section));
}

/* ---------- Typewriter caption reveal (gallery.html) ---------- */
function initTypewriterCaptions() {
  const captions = document.querySelectorAll(".typewriter");
  if (!captions.length || !enableCssEnhancements()) return;

  try {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add("animate");
        });
      },
      { threshold: 0.5 }
    );

    captions.forEach((caption) => observer.observe(caption));
  } catch (err) {
    disableCssEnhancements();
  }
}

/* ---------- Lightbox (gallery.html photo grid) ---------- */
/* Click/Enter a photo to open. Prev/next (buttons, arrow keys, swipe) move
   within the photo's own category block. Escape, the × button, or a click on
   the backdrop closes it; focus returns to the photo that opened it. */
function initPhotoLightbox() {
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");
  const closeBtn = lightbox ? lightbox.querySelector(".lightbox-close") : null;
  const prevBtn = lightbox ? lightbox.querySelector(".lightbox-prev") : null;
  const nextBtn = lightbox ? lightbox.querySelector(".lightbox-next") : null;
  const status = document.getElementById("lightbox-status");
  const items = document.querySelectorAll(".photo-item");
  if (!lightbox || !lightboxImg || !closeBtn || !prevBtn || !nextBtn || !items.length) return;

  let lastFocused = null;
  let group = [];
  let index = 0;

  // The lightbox overlays the page but everything behind it (header, main
  // content, footer) stays in the DOM and tabbable by default — `inert`
  // removes it from both the tab order and the accessibility tree while
  // open, so keyboard/screen-reader users can't wander behind the modal.
  const backgroundEls = [
    document.querySelector(".site-header"),
    document.getElementById("main"),
    document.querySelector(".site-footer"),
  ].filter(Boolean);

  function setBackgroundInert(isInert) {
    backgroundEls.forEach((el) => {
      if (isInert) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    });
  }

  function isOpen() {
    return lightbox.classList.contains("active");
  }

  function show(i) {
    index = (i + group.length) % group.length;
    const img = group[index].querySelector("img");
    lightboxImg.src = img.currentSrc || img.src;
    lightboxImg.alt = img.alt || "";
    if (status) status.textContent = `Image ${index + 1} of ${group.length}`;
  }

  function open(item) {
    lastFocused = item;
    const block = item.closest(".category-block");
    group = Array.from((block || document).querySelectorAll(".photo-item")).filter((el) => el.querySelector("img"));
    lightbox.classList.toggle("is-single", group.length < 2);
    show(group.indexOf(item));
    lightbox.classList.add("active");
    setBackgroundInert(true);
    closeBtn.focus();
  }

  function close() {
    lightbox.classList.remove("active");
    lightboxImg.removeAttribute("src");
    setBackgroundInert(false);
    if (lastFocused) lastFocused.focus();
  }

  const next = () => group.length > 1 && show(index + 1);
  const prev = () => group.length > 1 && show(index - 1);

  items.forEach((item) => {
    const img = item.querySelector("img");
    if (!img) return;

    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    if (!item.hasAttribute("aria-label")) item.setAttribute("aria-label", img.alt || "View image");

    item.addEventListener("click", () => open(item));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open(item);
      }
    });
  });

  closeBtn.addEventListener("click", close);
  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", next);

  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) close();
  });

  document.addEventListener("keydown", (event) => {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      close();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      prev();
    } else if (event.key === "Tab") {
      // Keep focus inside the dialog (background is inert, so wrap manually).
      const focusable = [closeBtn, prevBtn, nextBtn].filter((el) => el.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!lightbox.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  // Horizontal swipe: left => next photo, right => previous.
  let touchStart = null;
  lightbox.addEventListener(
    "touchstart",
    (event) => {
      const t = event.touches[0];
      touchStart = t ? { x: t.clientX, y: t.clientY } : null;
    },
    { passive: true }
  );
  lightbox.addEventListener(
    "touchend",
    (event) => {
      const t = event.changedTouches[0];
      if (!touchStart || !t) return;
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) next();
        else prev();
      }
    },
    { passive: true }
  );
}

/* ---------- Contact form (contact.html) ---------- */
/* TEMPORARY (until M5): there is no inquiry backend. The form validates, but a
   valid attempt NEVER reports success — it tells the visitor online submission
   isn't available and points them to the real email/phone already published on
   the page. Nothing is sent, stored or logged.

   M5 REPLACEMENT POINT: set INQUIRY_BACKEND_ENABLED = true and implement
   submitInquiry() with a fetch() POST to the real endpoint (see
   docs/V1-SPEC.md F1). Success may only be shown after the server confirms the
   request was stored; add error / rate-limited states at the same time. */
const INQUIRY_BACKEND_ENABLED = false;
// OWNER-DECISION (docs/STATE.md, G8): placeholder minimum notice for a requested date.
const MIN_LEAD_DAYS = 7;

const FORM_FIELDS = ["name", "email", "sessionType", "preferredDate", "message"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function arizonaToday() {
  // YYYY-MM-DD for "today" in Arizona (no DST), regardless of the visitor's timezone.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function initContactForm() {
  const form = document.getElementById("contact-form");
  const status = document.getElementById("form-status");
  if (!form || !status) return;

  const submitBtn = form.querySelector("button[type=submit]");
  const dateInput = form.elements.preferredDate;
  const minDate = addDays(arizonaToday(), MIN_LEAD_DAYS);
  if (dateInput) dateInput.min = minDate;

  // The submit button ships disabled in the HTML so the form can't submit at
  // all without JS (there is no endpoint); enabled here once validation exists.
  if (submitBtn) submitBtn.disabled = false;

  function errorFor(name) {
    return document.getElementById(`${name}-error`);
  }

  function setError(name, message) {
    const field = form.elements[name];
    const el = errorFor(name);
    if (!field || !el) return;
    if (message) {
      el.textContent = message;
      el.hidden = false;
      field.setAttribute("aria-invalid", "true");
    } else {
      el.textContent = "";
      el.hidden = true;
      field.removeAttribute("aria-invalid");
    }
  }

  function validate() {
    const v = (name) => (form.elements[name] ? form.elements[name].value.trim() : "");
    const errors = {};
    if (!v("name")) errors.name = "Please enter your name.";
    if (!v("email")) errors.email = "Please enter your email address.";
    else if (!EMAIL_PATTERN.test(v("email"))) errors.email = "Please enter a valid email address.";
    if (!v("sessionType")) errors.sessionType = "Please choose a session type.";
    if (!v("message")) errors.message = "Please tell me a little about your session.";
    if (v("preferredDate") && v("preferredDate") < minDate) {
      errors.preferredDate = `Please choose a date at least ${MIN_LEAD_DAYS} days from today, or email or call to ask about shorter notice.`;
    }
    return errors;
  }

  function clearStatus() {
    status.textContent = "";
    status.classList.remove("is-unavailable");
  }

  function showUnavailable() {
    status.textContent = "";
    status.classList.add("is-unavailable");
    status.append("Online submission is not available yet, so nothing was sent. Your details are still in the form. Please email ");
    const mail = document.createElement("a");
    mail.href = "mailto:kaibecker13@gmail.com";
    mail.textContent = "kaibecker13@gmail.com";
    const tel = document.createElement("a");
    tel.href = "tel:+14804048969";
    tel.textContent = "(480) 404-8969";
    status.append(mail, " or call ", tel, " to request your session.");
    status.setAttribute("tabindex", "-1");
    status.focus();
  }

  // M5: replace with a real fetch() POST; resolve only after the server confirms storage.
  function submitInquiry() {
    showUnavailable();
  }

  FORM_FIELDS.forEach((name) => {
    const field = form.elements[name];
    if (!field) return;
    const clear = () => setError(name, "");
    field.addEventListener("input", clear);
    field.addEventListener("change", clear);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearStatus();

    const errors = validate();
    FORM_FIELDS.forEach((name) => setError(name, errors[name] || ""));
    const firstInvalid = FORM_FIELDS.find((name) => errors[name]);
    if (firstInvalid) {
      form.elements[firstInvalid].focus();
      return;
    }

    if (!INQUIRY_BACKEND_ENABLED) {
      showUnavailable();
      return;
    }
    submitInquiry();
  });
}

/* ---------- Boot (kept last so all module-level constants are initialised) ---------- */
// One init failing must not take the others down (e.g. the contact form
// still enables if the lightbox code throws).
[
  initNavToggle,
  initScrollLanding,
  initTransparentHeaderOnScroll,
  initTypewriterCaptions,
  initPhotoLightbox,
  initContactForm,
  initScrollReveal,
].forEach((init) => {
  try {
    init();
  } catch (err) {
    console.error(`${init.name} failed`, err);
  }
});
