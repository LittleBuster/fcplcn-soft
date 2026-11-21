/** @file Bounded public failures; internal/database/provider exceptions stay out of responses. */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}
export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
export const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function label(value: unknown, maximum = 96): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    Buffer.byteLength(value) <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
export function email(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new CloudError('Укажите корректный email');
  return value.trim().toLowerCase();
}
