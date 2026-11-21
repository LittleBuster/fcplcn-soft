import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import product from '../../../config/product.json' with { type: 'json' };

const pageTitle = `${product.name} — ${product.fullName}`
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

export default defineConfig({
  plugins: [
    preact(),
    {
      name: 'product-title',
      transformIndexHtml: (html) => html.replace('__PRODUCT_TITLE__', pageTitle),
    },
  ],
  build: {
    target: 'es2020',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.tsx'],
  },
});
