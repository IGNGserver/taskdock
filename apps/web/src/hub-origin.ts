export function normalizeHubOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('中枢地址不是有效 URL');
  }
  if (parsed.username || parsed.password) throw new Error('中枢地址不能包含用户名或密码');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('中枢地址必须使用 HTTP 或 HTTPS');
  if (parsed.protocol === 'http:' && !isTrustedHttpHost(parsed.hostname)) {
    throw new Error('生产环境 HTTP 仅支持可信内网地址，请改用 HTTPS');
  }
  return parsed.origin;
}

export function isHttpOrigin(value: string): boolean {
  try {
    return new URL(value).protocol === 'http:';
  } catch {
    return false;
  }
}

function isTrustedHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan')) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) return isTrustedIpv4(ipv4);

  const ipv6 = parseIpv6(host);
  if (!ipv6) return false;
  if (isIpv4MappedIpv6(ipv6)) return isTrustedIpv4(ipv6.slice(12));
  if (isLoopbackIpv6(ipv6)) return true;
  return (ipv6[0]! & 0xfe) === 0xfc || (ipv6[0] === 0xfe && (ipv6[1]! & 0xc0) === 0x80);
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

function isTrustedIpv4(ipv4: [number, number, number, number] | Uint8Array): boolean {
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
  if (!host.includes(':') || host.includes('%')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (value: string): number[] | null => {
    if (!value) return [];
    const groups: number[] = [];
    for (const part of value.split(':')) {
      if (!part) return null;
      if (part.includes('.')) {
        const ipv4 = parseIpv4(part);
        if (!ipv4) return null;
        groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };

  const left = parseGroups(halves[0]!);
  const right = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!left || !right || left.length + right.length > 8) return null;
  if (halves.length === 1 && left.length !== 8) return null;
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
