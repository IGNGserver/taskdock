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
  return parsed.origin;
}

export function isHttpOrigin(value: string): boolean {
  try {
    return new URL(value).protocol === 'http:';
  } catch {
    return false;
  }
}
