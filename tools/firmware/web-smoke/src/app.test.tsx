import { renderToString } from 'preact-render-to-string';
import { expect, test } from 'vitest';
import { App } from './app';
import product from '../../../../config/product.json';

test('renders a TypeScript Preact component with the installed SSR renderer', () => {
  const html = renderToString(<App />);
  expect(html).toContain(`<h1>${product.name}</h1>`);
  expect(html).toContain(product.fullName);
  expect(html).toContain('Run browser check');
  expect(html).toContain('Ready to check');
});
