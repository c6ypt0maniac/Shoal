import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), app: resolve(__dirname, 'app.html') } },
  },
  // Proxy API calls to the Shoal server (npm start in server/, port 4000).
  server: { proxy: { '/api': 'http://localhost:4000' } },
});
