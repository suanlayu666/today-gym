import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'web', cacheDir:'../.runtime/vite-cache', plugins: [react()],
  server: { proxy: { '/api/research':'http://127.0.0.1:'+(process.env.RESEARCH_PORT||3002),'/api': 'http://127.0.0.1:'+(process.env.API_PORT||3001) } },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
