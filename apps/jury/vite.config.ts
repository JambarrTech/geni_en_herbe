import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'url';

// Doit rester aligné sur CONFIG.PORT_DEFAULT (backend/src/config.ts).
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

export default defineConfig({
  // En production le backend sert cette app sous /jury (VITE_BASE_PATH=/jury/ au build).
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.tsx', '.jsx', '.json'],
    alias: {
      '@shared': fileURLToPath(new URL('../../shared/', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        timeout: 30_000,
        proxyTimeout: 30_000,
      },
      '/ws': {
        target: BACKEND_URL.replace(/^http/, 'ws'),
        ws: true,
        timeout: 30_000,
        proxyTimeout: 30_000,
      },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Découpage explicite : l'app jury (419 Ko en un seul chunk) embarquait
        // React et tout lucide-react dans le payload initial.
        manualChunks: {
          react: ['react', 'react-dom'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
