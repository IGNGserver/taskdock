import { describe, expect, it } from 'vitest';
import { assertProductionSecrets } from '../src/runtime-secrets.js';

describe('production runtime secrets', () => {
  it.each([
    ['BOOTSTRAP_TOKEN', 'replace-with-at-least-32-random-bytes'],
    ['OWNER_PASSWORD', 'replace-with-a-password-of-at-least-6-characters'],
    ['ACCESS_TOKEN_SECRET', 'replace-with-a-long-random-secret'],
    ['REFRESH_TOKEN_PEPPER', 'replace-with-a-long-random-pepper'],
  ])('rejects the public placeholder for %s', (name, value) => {
    expect(() => assertProductionSecrets({ [name]: value })).toThrow(name);
  });

  it('accepts independent non-placeholder values', () => {
    expect(() =>
      assertProductionSecrets({
        BOOTSTRAP_TOKEN: 'test-only-bootstrap-value-with-sufficient-length',
        ACCESS_TOKEN_SECRET: 'test-only-access-value-with-sufficient-length',
        REFRESH_TOKEN_PEPPER: 'test-only-refresh-value-with-sufficient-length',
      }),
    ).not.toThrow();
  });
});
