/** @file Package the canonical identity and reviewed SQL alongside the compiled cloud service. */
import { copyFile, cp, mkdir } from 'node:fs/promises';
const destination = new URL('../dist/config/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL('../../config/product.json', import.meta.url),
  new URL('product.json', destination),
);
await cp(
  new URL('../server/migrations/', import.meta.url),
  new URL('../dist/cloud/server/migrations/', import.meta.url),
  { recursive: true },
);
