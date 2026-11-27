/** @file Copy product identity and server rendering assets into the self-contained build. */
import { copyFile, cp, mkdir } from 'node:fs/promises';
const destination = new URL('../dist/config/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL('../../config/product.json', import.meta.url),
  new URL('product.json', destination),
);
await cp(
  new URL('../server/assets/', import.meta.url),
  new URL('../dist/server/assets/', import.meta.url),
  { recursive: true },
);
await cp(
  new URL('../server/migrations/', import.meta.url),
  new URL('../dist/server/migrations/', import.meta.url),
  { recursive: true },
);
