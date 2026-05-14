import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': 'http://localhost:1234',
      '/healthz': 'http://localhost:1234',
      '/sync': {
        target: 'ws://localhost:1234',
        ws: true
      },
      '/presence': {
        target: 'ws://localhost:1234',
        ws: true
      }
    }
  },
  preview: {
    port: 4173
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
});
