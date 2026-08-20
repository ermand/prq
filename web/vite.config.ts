import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Pinned to this file's directory rather than left to default to `process.cwd()`.
  // `prq web` is launched from wherever the user happens to be standing, and a
  // root that moved with the caller would look for routes in the wrong tree.
  root: import.meta.dirname,
  server: { port: 4177 },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    // Start's plugin must come first; react's must come after it.
    viteReact(),
  ],
});
