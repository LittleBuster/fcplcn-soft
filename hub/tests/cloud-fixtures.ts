/** @file Deterministic ESP image fixture; full end-to-end checks also use the actual IDF artifact. */
import { createHash } from 'node:crypto';
export function cloudAppImage(payload = 16384): Buffer {
  const end = 32 + payload + (15 - ((32 + payload) % 16));
  const image = Buffer.alloc(end + 33);
  image[0] = 0xe9;
  image[1] = 1;
  image[23] = 1;
  image.writeUInt32LE(0x40378000, 4);
  image.writeUInt16LE(9, 12);
  image.writeUInt32LE(0x3c000020, 24);
  image.writeUInt32LE(payload, 28);
  image.writeUInt32LE(0xabcd5432, 32);
  image.write('1.0.0-cloud-test', 48);
  image.write('FCPLCn', 80);
  createHash('sha256')
    .update('FCPLCn cloud fixture ' + payload)
    .digest()
    .copy(image, 176);
  let checksum = 0xef;
  for (const byte of image.subarray(32, 32 + payload)) checksum ^= byte;
  image[end] = checksum;
  createHash('sha256')
    .update(image.subarray(0, end + 1))
    .digest()
    .copy(image, end + 1);
  return image;
}
