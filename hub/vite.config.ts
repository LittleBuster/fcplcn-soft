/** @file Build the local hub panel with no third-party browser requests. */
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import product from '../config/product.json' with { type: 'json' };

export default defineConfig({
  root: 'web',
  plugins: [
    preact(),
    {
      name: 'fcplcn-product-title',
      transformIndexHtml: (html) =>
        html
          .replace('__PRODUCT_NAME__', product.name)
          .replace('__PRODUCT_FULL_NAME__', product.fullName),
    },
  ],
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2022' },
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: { '/api': 'http://127.0.0.1:3000', '/health': 'http://127.0.0.1:3000' },
  },
});
