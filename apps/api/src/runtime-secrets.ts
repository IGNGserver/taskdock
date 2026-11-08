const INSECURE_MARKERS = [
  'change-me',
  'local-access-secret',
  'local-refresh-pepper',
  'replace-with-',
] as const;

/** Reject public example credentials before a production process opens a port or initializes an Owner. */
export function assertProductionSecrets(secrets: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(secrets)) {
    if (value && INSECURE_MARKERS.some((marker) => value.includes(marker)))
      throw new Error(
        `${name} must not use a public placeholder or development secret in production`,
      );
  }
}
