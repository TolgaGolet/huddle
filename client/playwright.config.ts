import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Not *.test.ts: vitest would pick those up too.
  testMatch: "*.e2e.ts",
  timeout: 90_000,
  // Real calls share one dev server and its per-IP limits.
  workers: 1,
  use: {
    baseURL: "http://localhost:4173",
    browserName: "chromium",
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: {
    command: "npm run dev",
    cwd: "..",
    url: "http://localhost:4173",
    reuseExistingServer: true,
  },
});
