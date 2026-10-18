import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base: `dist/` runs anywhere static (Pages, Netlify, file preview).
  base: './',
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        mixing: resolve(__dirname, 'mixing.html'),
      },
    },
  },
});
