/** @file Copy canonical product identity into the self-contained server build. */
import { copyFile, mkdir } from 'node:fs/promises';
const destination = new URL('../dist/config/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL('../../config/product.json', import.meta.url),
  new URL('product.json', destination),
);
