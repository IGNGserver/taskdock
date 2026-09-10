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
    if (parsed.protocol === 'https:') return parsed.origin;
    if (parsed.protocol === 'http:' && isTrustedHttpHost(parsed.hostname)) return parsed.origin;
    return null;
  } catch {
    return null;
  }
}

export function isTrustedHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan')) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) return isTrustedIpv4(ipv4);

  const ipv6 = parseIpv6(host);
  if (!ipv6) return false;
  if (isIpv4MappedIpv6(ipv6)) return isTrustedIpv4(ipv6.slice(12));
  if (isLoopbackIpv6(ipv6)) return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6 addresses are
  // private network targets, just like the RFC 1918 IPv4 ranges above.
  return (ipv6[0]! & 0xfe) === 0xfc || (ipv6[0] === 0xfe && (ipv6[1]! & 0xc0) === 0x80);
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

function parseIpv4(host: string): [number, number, number, number] | null {
  const octets = host.split('.').map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return null;
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isTrustedIpv4(ipv4: readonly number[] | Uint8Array): boolean {
  const first = ipv4[0]!;
  const second = ipv4[1]!;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function parseIpv6(host: string): Uint8Array | null {
  if (!host.includes(':')) return null;
  const input = host.toLowerCase();
  if (input.includes('%')) return null;
  const halves = input.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (value: string): number[] => {
    if (!value) return [];
    const groups: number[] = [];
    for (const part of value.split(':')) {
      if (!part) return [];
      if (part.includes('.')) {
        const ipv4 = parseIpv4(part);
        if (!ipv4) return [];
        groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return [];
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const left = parseGroups(halves[0]!);
  const right = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (left.length + right.length > 8 || (halves.length === 1 && left.length !== 8)) return null;
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
      : left;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function isLoopbackIpv6(ipv6: Uint8Array): boolean {
  return ipv6.slice(0, 15).every((value) => value === 0) && ipv6[15] === 1;
}

function isIpv4MappedIpv6(ipv6: Uint8Array): boolean {
  return ipv6.slice(0, 10).every((value) => value === 0) && ipv6[10] === 0xff && ipv6[11] === 0xff;
}
