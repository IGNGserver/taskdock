const HUB_REQUEST_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

const HUB_REQUEST_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
  'idempotency-key',
  'x-client-id',
]);

const MAX_HUB_REQUEST_BODY_BYTES = 1_200_000;
const MAX_HUB_REQUEST_HEADER_VALUE_BYTES = 16_384;

export interface HubRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface ValidatedHubRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export function parseHubOrigin(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.username || parsed.password) return null;
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function validateHubRequest(
  input: unknown,
  configuredOrigin: string | null,
  allowUnconfiguredOrigin = false,
): ValidatedHubRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('invalid request');
  const candidate = input as Partial<HubRequestInput>;
  if (typeof candidate.url !== 'string') throw new Error('invalid request');

  const method = (candidate.method ?? 'GET').toUpperCase();
  if (!HUB_REQUEST_METHODS.has(method)) throw new Error('unsupported request method');
  if (candidate.body !== undefined && candidate.body !== null && typeof candidate.body !== 'string')
    throw new Error('invalid request body');
  if (typeof candidate.body === 'string') {
    const bodyBytes = new TextEncoder().encode(candidate.body).byteLength;
    if (bodyBytes > MAX_HUB_REQUEST_BODY_BYTES) throw new Error('request body is too large');
  }

  let requested: URL;
  try {
    requested = new URL(candidate.url);
  } catch {
    throw new Error('invalid request URL');
  }
  if (requested.username || requested.password) throw new Error('invalid request URL');
  const requestOrigin = parseHubOrigin(requested.origin);
  if (!requestOrigin) throw new Error('invalid request origin');
  if (!allowUnconfiguredOrigin && (!configuredOrigin || requestOrigin !== configuredOrigin))
    throw new Error('request origin does not match configured hub');
  if (!requested.pathname.startsWith('/api/v1/')) throw new Error('request path is not allowed');

  const headers: Record<string, string> = {};
  const seenHeaders = new Set<string>();
  if (candidate.headers !== undefined) {
    if (
      !candidate.headers ||
      typeof candidate.headers !== 'object' ||
      Array.isArray(candidate.headers)
    )
      throw new Error('invalid request headers');
    for (const [key, value] of Object.entries(candidate.headers)) {
      if (typeof value !== 'string') throw new Error('invalid request header');
      const lower = key.toLowerCase();
      if (!HUB_REQUEST_HEADERS.has(lower)) throw new Error('request header is not allowed');
      if (seenHeaders.has(lower)) throw new Error('duplicate request header');
      if (new TextEncoder().encode(value).byteLength > MAX_HUB_REQUEST_HEADER_VALUE_BYTES)
        throw new Error('request header is too large');
      seenHeaders.add(lower);
      headers[lower] = value;
    }
  }

  return {
    url: requested,
    method,
    headers,
    body: candidate.body ?? null,
  };
}
