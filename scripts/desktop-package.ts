import { createHash } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const releaseDir = join(root, 'apps', 'desktop', 'release');
const linuxDir = join(releaseDir, 'linux-unpacked');

function runBuilder(target: 'linux' | 'win', format: 'dir' | 'nsis'): boolean {
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@devtodo/desktop',
      'exec',
      'electron-builder',
      '--config',
      'electron-builder.yml',
      `--${target}`,
      format,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  return result.status === 0;
}

function hasWine(): boolean {
  const result = spawnSync('wine', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

async function writeLinuxChecksums(): Promise<void> {
  const executable = join(linuxDir, 'devtodo');
  await access(executable);
  const digest = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex');
  await writeFile(join(linuxDir, 'SHA256SUMS'), `${digest}  devtodo\n`, 'utf8');
  console.log(`${digest}  ${executable}`);
}

function runLinuxLaunchSmoke(): number {
  const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/desktop-launch-smoke.ts'], {
    cwd: root,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

async function main(): Promise<void> {
  // The release directory is ignored and can contain artifacts from a former
  // product name or version. Never let stale files look like a fresh package.
  await rm(releaseDir, { recursive: true, force: true });
  if (!runBuilder('linux', 'dir')) {
    console.error('FAIL: Linux Electron directory package failed.');
    process.exitCode = 1;
    return;
  }
  await writeLinuxChecksums();
  console.log(`PASS: Linux Electron directory package is in ${linuxDir}`);
  const launchStatus = runLinuxLaunchSmoke();
  if (launchStatus !== 0 && launchStatus !== 2) {
    console.error('FAIL: packaged Electron launch smoke failed.');
    process.exitCode = 1;
    return;
  }
  if (launchStatus === 2 && process.env['REQUIRE_DESKTOP_LAUNCH'] === '1') {
    console.error('NOT RUN: packaged Electron launch is required by this release gate.');
    process.exitCode = 2;
    return;
  }

  if (process.platform !== 'win32' && !hasWine()) {
    console.log('NOT RUN: Windows NSIS packaging requires Wine or a Windows runner.');
    if (process.env['REQUIRE_WINDOWS_RELEASE'] === '1') process.exitCode = 2;
    return;
  }
  if (!runBuilder('win', 'nsis')) {
    console.error('FAIL: Windows NSIS package failed.');
    process.exitCode = 1;
    return;
  }
  console.log('PASS: Windows NSIS package generated.');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
