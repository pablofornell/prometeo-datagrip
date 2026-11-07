import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// vite-plugin-solid makes jsdom the default test environment, and jsdom is not installed
// (vitest then exits with code 1 although all tests pass). Our tests are DOM-free: use node.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { environment: "node", css: { include: [/\.css\?raw/] } }, // the colour scheme code and the token tests read CSS files with ?raw
  }),
);
