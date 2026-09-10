import { describe, expect, it } from 'vitest';

import { isHttpOrigin, normalizeHubOrigin } from '../src/hub-origin.js';

describe('hub origin validation', () => {
  it.each([
    'https://todo.example.com',
    'https://todo.example.com:8443/workspace?tab=today#top',
    'http://localhost:3000',
    'http://localhost',
    'http://127.0.0.1:3000',
    'http://127.255.255.254:3000',
    'http://[::1]:3000',
    'http://[fc00::5]:3000',
    'http://[fe80::5]:3000',
    'http://[::ffff:192.168.1.20]:3000',
    'http://10.0.0.5:3000',
    'http://172.16.0.8:3000',
    'http://172.31.255.254:3000',
    'http://192.168.1.20:3000',
    'http://todo.local:3000',
    'http://todo.lan:3000',
  ])('accepts %s', (value) => {
    expect(() => normalizeHubOrigin(value)).not.toThrow();
  });

  it.each([
    'http://example.com',
    'http://8.8.8.8',
    'http://172.15.0.1',
    'http://172.32.0.1',
    'http://192.167.1.1',
    'ftp://todo.example.com',
    'https://user:password@todo.example.com',
    'not a url',
    '',
  ])('rejects unsafe or invalid address %s', (value) => {
    expect(() => normalizeHubOrigin(value)).toThrow();
  });

  it('normalizes the saved value to an origin', () => {
    expect(normalizeHubOrigin('  https://todo.example.com:443/tasks?view=today#top  ')).toBe(
      'https://todo.example.com',
    );
    expect(normalizeHubOrigin('http://192.168.1.10:80/api')).toBe('http://192.168.1.10');
  });

  it('reports whether an origin uses HTTP without validating trust', () => {
    expect(isHttpOrigin('http://example.com')).toBe(true);
    expect(isHttpOrigin('https://example.com')).toBe(false);
    expect(isHttpOrigin('not a url')).toBe(false);
  });
});
