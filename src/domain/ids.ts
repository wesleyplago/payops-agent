import { createHash, randomUUID } from 'node:crypto';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value);
}

export function newId(): string {
  return randomUUID();
}

/** Deterministic JSON: object keys sorted recursively. Used for request hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function requestHash(tool: string, idempotencyKey: string, args: unknown) {
  return sha256(canonicalJson({ tool, idempotency_key: idempotencyKey, args }));
}
