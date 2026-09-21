/* ==========================================================================
   Kaileb Becker Photography — main.js
   Vanilla JS, no dependencies. Every block below guards for the elements
   it needs, so this single file can be shared across all pages.
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  initNavToggle();
  initScrollLanding();
  initTransparentHeaderOnScroll();
  initTypewriterCaptions();
  initPhotoLightbox();
  initContactForm();
  initScrollReveal();
});

/* ---------- Fade/slide-up reveal on scroll (.reveal elements) ---------- */
function initScrollReveal() {
  const items = document.querySelectorAll(".reveal");
  if (!items.length) return;

  if (!("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }

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

  items.forEach((item) => observer.observe(item));
}

/* ---------- Mobile nav toggle ---------- */
function initNavToggle() {
  const toggle = document.getElementById("nav-toggle");
  const nav = document.getElementById("primary-nav");
  if (!toggle || !nav) return;

  toggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.setAttribute("aria-label", isOpen ? "Close navigation menu" : "Open navigation menu");
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Open navigation menu");
    });
  });
}

/* ---------- Transparent hero header: solid once scrolled past the photo ---------- */
function initTransparentHeaderOnScroll() {
  const header = document.querySelector(".site-header--transparent");
  if (!header) return;

  // collections.html's scroll-landing keeps a full-bleed photo behind the
  // header the whole time (desktop paging never reveals plain content, and
  // mobile stacks stay on darkened photo sections too), so it should keep
  // the light-text treatment throughout rather than switching to solid.
  if (document.body.classList.contains("has-scroll-landing")) return;

  const getThreshold = () => Math.max(window.innerHeight * 0.75, 120);

  function update() {
    header.classList.toggle("is-scrolled", window.scrollY > getThreshold());
  }

  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
}

/* ---------- Scroll-landing controller (collections.html) ---------- */
function initScrollLanding() {
  const landing = document.querySelector(".scroll-landing");
  const sections = document.querySelectorAll(".scroll-section");
  if (!landing || !sections.length) return;

  document.body.classList.add("has-scroll-landing");

  // Desktop pages one section at a time with the other three positioned
  // off-screen (opacity/transform only — still in the DOM). Below 769px
  // every section is stacked and visible at once instead (see the
  // max-width: 768px override in main.css), so only manage focus/AT
  // visibility for the desktop paged mode — on mobile every section should
  // stay fully reachable.
  const isDesktopPaged = window.innerWidth > 768;

  let current = 0;
  let isScrolling = false;
  sections[current].classList.add("active");

  const dots = document.querySelectorAll(".scroll-dots .dot");

  function syncDots() {
    dots.forEach((dot) => {
      dot.classList.toggle("active", Number(dot.dataset.index) === current);
    });
  }
  syncDots();

  // Off-screen sections are only opacity/transform-hidden, so without this
  // a keyboard or screen-reader user could still tab into (or hear) the
  // three sections not currently on screen.
  function syncSectionA11y() {
    if (!isDesktopPaged) return;
    sections.forEach((section, index) => {
      const isActive = index === current;
      section.setAttribute("aria-hidden", String(!isActive));
      const link = section.querySelector("a");
      if (link) link.setAttribute("tabindex", isActive ? "0" : "-1");
    });
  }
  syncSectionA11y();

  function goTo(index) {
    if (isScrolling || index === current || index < 0 || index >= sections.length) return;
    isScrolling = true;

    sections[current].classList.remove("active");
    if (index > current) sections[current].classList.add("prev");
    current = index;

    sections[current].classList.remove("prev");
    sections[current].classList.add("active");
    syncDots();
    syncSectionA11y();

    setTimeout(() => {
      isScrolling = false;
    }, 800);
  }

  // Controlled full-screen scroll paging — desktop only
  if (window.innerWidth > 768) {
    landing.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        goTo(event.deltaY > 0 ? current + 1 : current - 1);
      },
      { passive: false }
    );
  }

  dots.forEach((dot) => {
    dot.addEventListener("click", () => goTo(Number(dot.dataset.index)));
  });

  sections.forEach((section) => {
    const link = section.querySelector("a");
    if (!link) return;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const href = link.getAttribute("href");
      section.classList.add("fade-out");
      setTimeout(() => {
        window.location.href = href;
      }, 450);
    });
  });
}

/* ---------- Typewriter caption reveal (gallery.html) ---------- */
function initTypewriterCaptions() {
  const captions = document.querySelectorAll(".typewriter");
  if (!captions.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add("animate");
      });
    },
    { threshold: 0.5 }
  );

  captions.forEach((caption) => observer.observe(caption));
}

/* ---------- Simple click-to-zoom lightbox (gallery.html photo grid) ---------- */
function initPhotoLightbox() {
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");
  const closeBtn = lightbox ? lightbox.querySelector(".lightbox-close") : null;
  const items = document.querySelectorAll(".photo-item");
  if (!lightbox || !lightboxImg || !closeBtn || !items.length) return;

  let lastFocused = null;

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

  function close() {
    lightbox.classList.remove("active");
    lightboxImg.removeAttribute("src");
    setBackgroundInert(false);
    if (lastFocused) lastFocused.focus();
  }

  items.forEach((item) => {
    const img = item.querySelector("img");
    if (!img) return;

    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    if (!item.hasAttribute("aria-label")) item.setAttribute("aria-label", img.alt || "View image");

    const open = () => {
      lastFocused = item;
      lightboxImg.src = img.currentSrc || img.src;
      lightboxImg.alt = img.alt || "";
      lightbox.classList.add("active");
      setBackgroundInert(true);
      closeBtn.focus();
    };

    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });

  closeBtn.addEventListener("click", close);

  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && lightbox.classList.contains("active")) close();
  });
}

/* ---------- Contact form (contact.html) ---------- */
function initContactForm() {
  const form = document.getElementById("contact-form");
  const status = document.getElementById("form-status");
  if (!form || !status) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const data = Object.fromEntries(new FormData(form).entries());

    // --- STUB: logging only for now. ---
    // Real submission target: a server-side endpoint that forwards this
    // payload to the Wise Agent CRM webcontact API (requires an OAuth
    // Bearer token that must stay server-side). See BACKEND.md.
    //
    // Once that endpoint exists, replace this block with:
    //   fetch("/api/contact", {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json" },
    //     body: JSON.stringify(data),
    //   })
    //     .then(...)
    //     .catch(...);
    console.log("Contact form submission:", data);

    status.textContent = "Thanks, I'll be in touch!";
    status.classList.add("is-success");
    form.reset();
  });
}
