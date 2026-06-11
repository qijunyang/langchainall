import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies /api to the chat API (src/server.ts), so the browser
// sees one origin — no CORS, and the X-Thread-Id response header is readable.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3100",
    },
  },
});
