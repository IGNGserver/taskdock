import { describe, expect, it } from 'vitest';

import { isTrustedHttpHost, parseHubOrigin, validateHubRequest } from '../src/hub-policy.js';

describe('desktop hub policy', () => {
  it.each([
    ['https://todo.example.com/path', 'https://todo.example.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://10.0.0.5:3000/tasks', 'http://10.0.0.5:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    ['http://[fc00::5]:3000', 'http://[fc00::5]:3000'],
    ['http://[fe80::5]:3000', 'http://[fe80::5]:3000'],
    ['http://[::ffff:192.168.1.20]:3000', 'http://[::ffff:c0a8:114]:3000'],
  ])('normalizes trusted origin %s', (value, expected) => {
    expect(parseHubOrigin(value)).toBe(expected);
  });

  it.each([
    'http://example.com',
    'http://8.8.8.8',
    'http://172.15.0.1',
    'http://172.32.0.1',
    'http://192.167.1.1',
    'http://[2001:db8::5]',
    'https://user:password@todo.example.com',
    'ftp://todo.example.com',
    'not a url',
  ])('rejects unsafe or invalid hub origin %s', (value) => {
    expect(parseHubOrigin(value)).toBeNull();
  });

  it('accepts only the explicitly trusted private host ranges for HTTP', () => {
    expect(isTrustedHttpHost('127.0.0.1')).toBe(true);
    expect(isTrustedHttpHost('192.168.1.20')).toBe(true);
    expect(isTrustedHttpHost('172.31.255.254')).toBe(true);
    expect(isTrustedHttpHost('172.32.0.1')).toBe(false);
    expect(isTrustedHttpHost('2001:db8::5')).toBe(false);
  });

  it('validates a same-origin API request and keeps only allowed headers', () => {
    const request = validateHubRequest(
      {
        url: 'https://todo.example.com/api/v1/tasks?limit=10',
        method: 'post',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'mutation-1',
          'X-Client-Id': 'client-1',
        },
        body: '{}',
      },
      'https://todo.example.com',
    );

    expect(request.url.toString()).toBe('https://todo.example.com/api/v1/tasks?limit=10');
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer access-token',
      'content-type': 'application/json',
      'idempotency-key': 'mutation-1',
      'x-client-id': 'client-1',
    });
    expect(request.body).toBe('{}');
  });

  it('rejects requests outside the configured Hub and API path', () => {
    expect(() =>
      validateHubRequest(
        { url: 'https://other.example.com/api/v1/me' },
        'https://todo.example.com',
      ),
    ).toThrow('request origin does not match configured hub');
    expect(() =>
      validateHubRequest({ url: 'https://todo.example.com/login' }, 'https://todo.example.com'),
    ).toThrow('request path is not allowed');
    expect(() =>
      validateHubRequest({ url: 'https://todo.example.com/api/v1' }, 'https://todo.example.com'),
    ).toThrow('request path is not allowed');
    expect(() => validateHubRequest({ url: 'https://todo.example.com/api/v1/me' }, null)).toThrow(
      'request origin does not match configured hub',
    );
  });

  it('rejects unsupported methods, forbidden headers, malformed bodies, and oversized bodies', () => {
    expect(() =>
      validateHubRequest(
        { url: 'https://todo.example.com/api/v1/me', method: 'TRACE' },
        'https://todo.example.com',
      ),
    ).toThrow('unsupported request method');
    expect(() =>
      validateHubRequest(
        {
          url: 'https://todo.example.com/api/v1/me',
          headers: { Origin: 'https://evil.example' },
        },
        'https://todo.example.com',
      ),
    ).toThrow('request header is not allowed');
    expect(() =>
      validateHubRequest(
        { url: 'https://todo.example.com/api/v1/me', body: { malicious: true } },
        'https://todo.example.com',
      ),
    ).toThrow('invalid request body');
    expect(() =>
      validateHubRequest(
        { url: 'https://todo.example.com/api/v1/me', body: 'x'.repeat(1_200_001) },
        'https://todo.example.com',
      ),
    ).toThrow('request body is too large');
  });
});
