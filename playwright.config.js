// Lightweight regression suite for the static site. `npm test` starts a local
// static server automatically. Desktop + mobile projects; mobile uses a
// touch / coarse-pointer device profile.
//
// Run against a deployed site (e.g. GitHub Pages staging) instead:
//   BASE_URL=https://<user>.github.io/<repo>/ npx playwright test
// Tests use paths relative to the base URL (no leading slash), so a repository
// sub-path works. Static file checks in tests/images.spec.js still read the repo.
const { defineConfig, devices } = require("@playwright/test");

const remote = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/?$/, "/") : null;

module.exports = defineConfig({
  testDir: "tests",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: remote || "http://localhost:4173/" },
  webServer: remote
    ? undefined
    : {
        command: "npx http-server . -p 4173 -c-1 --silent",
        url: "http://localhost:4173/index.html",
        reuseExistingServer: true,
      },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
});
