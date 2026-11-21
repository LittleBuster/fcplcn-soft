/** @file Build the public FCPLCn portal; all browser traffic stays on its own HTTPS origin. */
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
          .replaceAll('__PRODUCT_NAME__', product.name)
          .replaceAll('__PRODUCT_FULL_NAME__', product.fullName),
    },
  ],
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2022' },
  server: {
    host: '127.0.0.1',
    port: 5175,
    proxy: { '/api': 'http://127.0.0.1:4100', '/portal': 'http://127.0.0.1:4100' },
  },
});
