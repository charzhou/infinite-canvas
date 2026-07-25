import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const webDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: { alias: { "@": resolve(webDir, "src") } },
    test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"] },
});
