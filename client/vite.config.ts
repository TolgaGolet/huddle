import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { parseIceServers } from "./src/lib/iceServers";

export default defineConfig(({ mode }) => {
  // Baked into the client, and a bad value looks just like a NAT problem at runtime.
  const iceServers = loadEnv(mode, ".", "VITE_").VITE_ICE_SERVERS;
  if (iceServers && !parseIceServers(iceServers)) {
    // The value can hold TURN credentials, so it stays out of the message.
    throw new Error('VITE_ICE_SERVERS must be a non-empty JSON array of RTCIceServer objects, each with "urls".');
  }

  return {
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
  };
});
