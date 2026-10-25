import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: { input: { main: resolve(__dirname, 'index.html'), app: resolve(__dirname, 'app.html') } },
    },
    server: { proxy: { '/api': env.SHOAL_DEV_API_URL || 'http://localhost:4000' } },
  };
});
