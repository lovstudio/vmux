import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { lovinspPlugin } from "lovinsp";

export default defineConfig({
  plugins: [lovinspPlugin({ bundler: "vite" }), react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 4167,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
