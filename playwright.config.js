// Lightweight regression suite for the static site. `npm test` starts a local
// static server automatically. Desktop + mobile projects; mobile uses a
// touch / coarse-pointer device profile.
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "npx http-server . -p 4173 -c-1 --silent",
    url: "http://localhost:4173/index.html",
    reuseExistingServer: true,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
});
