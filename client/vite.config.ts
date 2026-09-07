import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4173,
    proxy: {
      "/api": "http://localhost:3001",
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1500, // heic2any (~1.35 MB) is lazy-loaded and only fetched on HEIC uploads
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          socket: ["socket.io-client"],
          lucide: ["lucide-react"],
        },
      },
    },
  },
});
