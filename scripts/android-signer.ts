import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Locate build-tools without interpolating SDK paths into a shell command. */
export async function findApkSigner(sdkRoot: string): Promise<string | null> {
  const buildToolsRoot = join(sdkRoot, 'build-tools');
  let entries;
  try {
    entries = await readdir(buildToolsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
  for (const version of versions) {
    const candidate = join(buildToolsRoot, version, 'apksigner');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed build-tools version.
    }
  }
  return null;
}
