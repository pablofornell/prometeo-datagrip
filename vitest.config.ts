import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// vite-plugin-solid makes jsdom the default test environment, and jsdom is not installed
// (vitest then exits with code 1 although all tests pass). Our tests are DOM-free: use node.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "node", // the colour scheme code and the token tests read CSS files with ?raw
      css: { include: [/\.css\?raw/] },
      // Vitest 4 also fakes process.hrtime by default. Its own hook timing then runs on the fake clock, so any test
      // that advances timers is reported as "Hook timed out in 10000ms". Fake everything else (performance.now is
      // needed by the output clock test), but keep hrtime real.
      fakeTimers: {
        toFake: [
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "setImmediate",
          "clearImmediate",
          "Date",
          "performance",
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "requestIdleCallback",
          "cancelIdleCallback",
          "Intl",
        ],
      },
    },
  }),
);
