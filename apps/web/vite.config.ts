import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 开发环境代理到后端
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      // WebSocket 代理
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
