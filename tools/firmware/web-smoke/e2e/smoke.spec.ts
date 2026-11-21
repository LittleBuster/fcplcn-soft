import { expect, test } from '@playwright/test';
import product from '../../../../config/product.json' with { type: 'json' };

test('serves the production bundle and runs Preact in Chromium', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await expect(page).toHaveTitle(`${product.name} — ${product.fullName}`);
  await expect(page.getByRole('heading', { name: product.name, exact: true })).toBeVisible();
  await expect(page.getByText(product.fullName, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run browser check' }).click();
  await expect(page.getByRole('status')).toHaveText('Browser check passed');
  expect(errors).toEqual([]);
});
