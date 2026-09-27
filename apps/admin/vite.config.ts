import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'url';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

export default defineConfig({
  // En production le backend sert cette app sous /admin (VITE_BASE_PATH=/admin/ au build).
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.tsx', '.jsx', '.json'],
    alias: {
      '@shared': fileURLToPath(new URL('../../shared/', import.meta.url)),
    },
  },
  server: {
    port: 5175,
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
        // Découpage explicite : sans cela Vite emitait un seul chunk de 455 Ko
        // contenant tout le tableau de bord, la banque de questions avec les
        // réponses officielles et le SDK Firebase — le tout chargé avant même
        // que le formulaire de connexion ne soit utilisable.
        manualChunks: {
          react: ['react', 'react-dom'],
          firebase: ['firebase/app', 'firebase/auth'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
