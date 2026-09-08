import { createHash } from 'node:crypto';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

async function main(): Promise<void> {
  const androidDir = fileURLToPath(new URL('../apps/mobile/android/', import.meta.url));
  const gradlew = join(androidDir, 'gradlew');
  try {
    await access(gradlew);
  } catch {
    console.log(
      'NOT RUN: apps/mobile/android is not generated; Android SDK/Gradle/signing material is unavailable.',
    );
    process.exitCode = 2;
    return;
  }
  const sdkRoot = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
  if (!sdkRoot) {
    console.log('NOT RUN: ANDROID_HOME/ANDROID_SDK_ROOT is not configured.');
    process.exitCode = 2;
    return;
  }
  try {
    await access(join(sdkRoot, 'platforms'));
  } catch {
    console.log(`NOT RUN: Android SDK was not found at ${sdkRoot}.`);
    process.exitCode = 2;
    return;
  }
  const result = spawnSync('bash', [gradlew, '--no-daemon', 'assembleRelease'], {
    cwd: androidDir,
    env: { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  const outputDir = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release');
  const files = (await readdir(outputDir)).filter((file) => file.endsWith('.apk')).sort();
  if (!files.length) throw new Error('assembleRelease completed without an APK');
  const manifest = files.map(async (file) => {
    const bytes = await readFile(join(outputDir, file));
    const digest = createHash('sha256').update(bytes).digest('hex');
    return `${digest}  ${file}`;
  });
  const lines = await Promise.all(manifest);
  await writeFile(join(outputDir, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
  console.log(`PASS: Android release variant assembled in ${outputDir}`);
  console.log(lines.join('\n'));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
