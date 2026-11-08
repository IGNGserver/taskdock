import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findApkSigner } from './android-signer.js';

describe('Android signer discovery', () => {
  it('selects the newest installed build-tools binary without a shell', async () => {
    const sdk = await mkdtemp(join(tmpdir(), 'taskdock-sdk-";printf-not-executed-'));
    try {
      for (const version of ['9.9.0', '10.0.0']) {
        const directory = join(sdk, 'build-tools', version);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'apksigner'), 'test-only');
      }
      expect(await findApkSigner(sdk)).toBe(join(sdk, 'build-tools', '10.0.0', 'apksigner'));
    } finally {
      await rm(sdk, { recursive: true, force: true });
    }
  });

  it('returns null when build-tools or apksigner is absent', async () => {
    const sdk = await mkdtemp(join(tmpdir(), 'taskdock-empty-sdk-'));
    try {
      expect(await findApkSigner(sdk)).toBeNull();
    } finally {
      await rm(sdk, { recursive: true, force: true });
    }
  });
});
