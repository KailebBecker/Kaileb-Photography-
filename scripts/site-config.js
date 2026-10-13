// Per-environment runtime configuration (loaded by contact.html before main.js).
// Committed values are deliberately EMPTY: with no inquiryApiUrl the form stays in
// its truthful "online submission not available" mode. The staging deploy workflow
// fills these in from GitHub repository variables; production will set its own.
// Nothing secret belongs here (this file is public).
window.SITE_CONFIG = {
  inquiryApiUrl: "", // e.g. "https://api.example.com/api/inquiries"
  turnstileSiteKey: "", // public Cloudflare Turnstile site key (optional)
};
