import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'url';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  // En production le backend sert les apps sous des chemins dédiés :
  // build avec VITE_BASE_PATH=/jury/ (jury) ou /admin/ (admin). Le live reste à la racine.
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.tsx', '.jsx', '.json'],
    alias: {
      // Code mutualisé entre les trois apps (racine du dépôt)
      '@shared': fileURLToPath(new URL('../../shared/', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Le backend peut être déporté (BACKEND_URL), par ex. http://localhost:3001
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
        // L'écran live ne dépend ni de Firebase ni d'un gros jeu d'icônes :
        // on ne découpe que React, et on isole canvas-confetti.
        manualChunks: {
          react: ['react', 'react-dom'],
          confetti: ['canvas-confetti'],
        },
      },
    },
  },
});
