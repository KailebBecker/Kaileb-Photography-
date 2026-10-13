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

  // The lightbox has its own <picture>. For each photo we hand it the grid
  // item's AVIF/WebP srcsets (which include the larger widths) with a `sizes`
  // that matches the dialog's real display box, so it loads a bigger
  // derivative than the grid did, but not the biggest one on a phone.
  const lightboxSources = Array.from(lightbox.querySelectorAll("picture source"));

  function lightboxSizes(aspect) {
    const a = aspect.toFixed(4);
    return `(max-width: 600px) min(96vw, calc((100vh - 170px) * ${a})), min(90vw, calc(90vh * ${a}))`;
  }

  function clearLightboxSources() {
    lightboxSources.forEach((source) => {
      source.removeAttribute("srcset");
      source.removeAttribute("sizes");
    });
  }

  function show(i) {
    index = (i + group.length) % group.length;
    const item = group[index];
    const img = item.querySelector("img");
    const picture = item.querySelector("picture");
    const width = Number(img.getAttribute("width"));
    const height = Number(img.getAttribute("height"));

    clearLightboxSources();
    if (picture && width && height) {
      lightboxSources.forEach((source) => {
        const from = picture.querySelector(`source[type="${source.type}"]`);
        if (!from) return;
        source.setAttribute("srcset", from.getAttribute("srcset"));
        source.setAttribute("sizes", lightboxSizes(width / height));
      });
    }
    // The <img> src is the JPEG/SVG fallback; picture sources take priority when supported.
    lightboxImg.src = img.getAttribute("src");
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
    clearLightboxSources();
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
/* Two modes, chosen by window.SITE_CONFIG.inquiryApiUrl (scripts/site-config.js,
   injected per environment — never hard-coded to one host):

   - NOT configured (no backend reachable): the M1 behaviour. Validate, then say
     plainly that online submission is not available, send/log/store nothing, and
     point to the published email/phone.
   - Configured: validate, POST JSON to the inquiry API, and show success ONLY when the
     server answers that it durably stored the inquiry (HTTP 200/201 with ok:true).
     Anything else (network error, timeout, 5xx, bad response) is reported as "not
     confirmed as received" with the input preserved, the email/phone fallback shown,
     and a safe retry: the same idempotency key is reused while the content is
     unchanged, so a retry can never create a duplicate inquiry.
   Client validation is a convenience; the server re-validates everything. */
// OWNER-DECISION (docs/STATE.md, G8): placeholder minimum notice for a requested date.
const MIN_LEAD_DAYS = 7;
const REQUEST_TIMEOUT_MS = 15000;

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

function newRequestKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function initContactForm() {
  const form = document.getElementById("contact-form");
  const status = document.getElementById("form-status");
  if (!form || !status) return;

  const config = window.SITE_CONFIG || {};
  const configuredUrl = typeof config.inquiryApiUrl === "string" ? config.inquiryApiUrl.trim() : "";
  // Only ever talk to an https API (plain http is allowed solely for local development).
  const apiUrl = /^https:\/\//i.test(configuredUrl) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(configuredUrl) ? configuredUrl : "";
  const live = apiUrl !== "";
  const notice = document.getElementById("form-notice");
  const success = document.getElementById("inquiry-success");
  const submitBtn = form.querySelector("button[type=submit]");
  const dateInput = form.elements.preferredDate;
  const minDate = addDays(arizonaToday(), MIN_LEAD_DAYS);
  if (dateInput) dateInput.min = minDate;

  function setSubmitLabel(text) {
    if (!submitBtn) return;
    submitBtn.textContent = `${text} `;
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";
    submitBtn.append(arrow);
  }

  if (live) {
    // The static "not available yet" notice only applies when there is no backend.
    if (notice) notice.hidden = true;
    setSubmitLabel("Send Inquiry");
  }
  // The submit button ships disabled in the HTML so the form can't submit at all
  // without JS; enabled here once validation exists.
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
    status.className = "form-status";
    status.removeAttribute("tabindex");
  }

  /** Message + the real email/phone, focused so screen readers announce it. */
  function showStatus(kind, lead, tail) {
    status.textContent = "";
    status.className = `form-status is-${kind}`;
    status.append(lead);
    const mail = document.createElement("a");
    mail.href = "mailto:kaibecker13@gmail.com";
    mail.textContent = "kaibecker13@gmail.com";
    const tel = document.createElement("a");
    tel.href = "tel:+14804048969";
    tel.textContent = "(480) 404-8969";
    status.append(mail, " or call ", tel, tail);
    status.setAttribute("tabindex", "-1");
    status.focus();
  }

  const showUnavailable = () =>
    showStatus("unavailable", "Online submission is not available yet, so nothing was sent. Your details are still in the form. Please email ", " to request your session.");

  FORM_FIELDS.forEach((name) => {
    const field = form.elements[name];
    if (!field) return;
    const clear = () => setError(name, "");
    field.addEventListener("input", clear);
    field.addEventListener("change", clear);
  });

  /* ----- optional bot check (Cloudflare Turnstile; works on any host) ----- */
  let turnstileToken = "";
  let turnstileWidget = null;
  const widgetEl = document.getElementById("turnstile-widget");
  if (live && config.turnstileSiteKey && widgetEl) {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => {
      turnstileWidget = window.turnstile.render(widgetEl, {
        sitekey: config.turnstileSiteKey,
        callback: (token) => (turnstileToken = token),
        "expired-callback": () => (turnstileToken = ""),
        "error-callback": () => (turnstileToken = ""),
      });
    };
    document.head.append(script);
  }
  function resetBotCheck() {
    turnstileToken = "";
    if (turnstileWidget !== null && window.turnstile) window.turnstile.reset(turnstileWidget);
  }

  /* ----- submission ----- */
  let busy = false;
  let attempt = { signature: null, key: null };

  function collect() {
    const v = (name) => (form.elements[name] ? form.elements[name].value.trim() : "");
    return {
      name: v("name"),
      email: v("email"),
      phone: v("phone"),
      sessionType: v("sessionType"),
      preferredDate: v("preferredDate"),
      location: v("location"),
      message: v("message"),
      discountCode: v("discountCode"),
      website: form.elements.website ? form.elements.website.value : "", // honeypot: humans leave it empty
    };
  }

  function setBusy(on) {
    busy = on;
    if (submitBtn) submitBtn.disabled = on;
    form.setAttribute("aria-busy", String(on));
    if (live) setSubmitLabel(on ? "Sending…" : "Send Inquiry");
  }

  function showSuccess(id, email) {
    form.reset();
    FORM_FIELDS.forEach((name) => setError(name, ""));
    clearStatus();
    if (!success) {
      showStatus("success", "Your inquiry was received. I'll follow up by email. If you don't hear back, reach me at ", ".");
      return;
    }
    success.querySelector("[data-ref]").textContent = id;
    success.querySelector("[data-email]").textContent = email;
    form.hidden = true;
    success.hidden = false;
    success.setAttribute("tabindex", "-1");
    success.focus();
  }

  async function submitInquiry() {
    const data = collect();
    // Same content => same key, so retrying after a lost response can't duplicate the inquiry.
    const signature = JSON.stringify(data);
    if (attempt.signature !== signature) attempt = { signature, key: newRequestKey() };
    const body = { ...data, idempotencyKey: attempt.key };
    if (config.turnstileSiteKey) {
      if (!turnstileToken) {
        showStatus("error", "Please complete the verification above, then send again. Or email ", " instead.");
        return;
      }
      body.turnstileToken = turnstileToken;
    }

    setBusy(true);
    clearStatus();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        json = null;
      }

      if ((res.status === 201 || res.status === 200) && json && json.ok === true && typeof json.id === "string") {
        attempt = { signature: null, key: null };
        showSuccess(json.id, data.email);
        return;
      }
      if (res.status === 400 && json && json.error === "validation" && json.fields) {
        const unmapped = [];
        Object.keys(json.fields).forEach((name) => (FORM_FIELDS.includes(name) ? setError(name, String(json.fields[name])) : unmapped.push(name)));
        const first = FORM_FIELDS.find((name) => json.fields[name]);
        if (first) form.elements[first].focus();
        else showStatus("error", "Some details couldn't be accepted. Nothing was sent. Please check the form, or email ", " instead.");
        return;
      }
      if (res.status === 429) {
        showStatus("error", "Too many attempts right now, and your inquiry was not sent. Please try again in a few minutes, or email ", " instead.");
        return;
      }
      if (res.status === 400 && json && json.error === "bot_check_failed") {
        showStatus("error", "The verification didn't pass, so nothing was sent. Please try again, or email ", " instead.");
        return;
      }
      throw new Error("not confirmed");
    } catch (err) {
      showStatus("error", "We couldn't confirm that your inquiry was received, so please don't assume it went through. Your details are still in the form. Press Send Inquiry to try again, or email ", " instead.");
    } finally {
      clearTimeout(timer);
      resetBotCheck();
      setBusy(false);
    }
  }

  if (success) {
    const again = success.querySelector("[data-again]");
    if (again) {
      again.addEventListener("click", () => {
        success.hidden = true;
        form.hidden = false;
        form.elements.name.focus();
      });
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return; // ignore double taps while a request is in flight
    clearStatus();

    const errors = validate();
    FORM_FIELDS.forEach((name) => setError(name, errors[name] || ""));
    const firstInvalid = FORM_FIELDS.find((name) => errors[name]);
    if (firstInvalid) {
      form.elements[firstInvalid].focus();
      return;
    }

    if (!live) {
      showUnavailable();
      return;
    }
    submitInquiry();
  });
}

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
