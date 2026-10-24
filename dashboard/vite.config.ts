import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const shared = fileURLToPath(new URL("../services/src/lib", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@shared": shared } },
  server: {
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://127.0.0.1:4337",
      "/chain": { target: "http://127.0.0.1:8545", rewrite: () => "/" },
    },
  },
});
