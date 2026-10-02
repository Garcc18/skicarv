import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run dev:https` (mode "https") sirve con un certificado autofirmado para probar
// Web Bluetooth desde otro dispositivo de la red local. Para el iPhone se usa el despliegue
// en GitHub Pages / Cloudflare Pages (ver README).
export default defineConfig(({ mode }) => ({
  // Rutas relativas: la misma build funciona en la raíz de un dominio y en /<repo>/ de GitHub Pages
  base: "./",
  plugins: [preact(), ...(mode === "https" ? [basicSsl()] : [])],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        bgtest: resolve(import.meta.dirname, "bgtest.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tools/**/*.test.ts"],
  },
}));
