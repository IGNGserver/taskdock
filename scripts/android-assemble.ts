import { createHash } from 'node:crypto';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function findApkSigner(sdkRoot: string): string | null {
  const buildToolsRoot = join(sdkRoot, 'build-tools');
  const result = spawnSync(
    'bash',
    ['-lc', `find "${buildToolsRoot}" -type f -name apksigner -print | sort -V | tail -1`],
    {
      encoding: 'utf8',
    },
  );
  const path = result.status === 0 ? result.stdout.trim() : '';
  return path || null;
}

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
  const apksigner = findApkSigner(sdkRoot);
  if (!apksigner) {
    throw new Error(`Android SDK build-tools 中未找到 apksigner：${sdkRoot}`);
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
  const files = (await readdir(outputDir))
    .filter((file) => file.endsWith('.apk') && !file.endsWith('-unsigned.apk'))
    .sort();
  if (!files.length) {
    throw new Error('assembleRelease 未生成已签名 APK；请检查 Release 签名配置。');
  }
  const apkPaths = files.map((file) => join(outputDir, file));
  for (const apkPath of apkPaths) {
    const verify = spawnSync(apksigner, ['verify', '--verbose', apkPath], { encoding: 'utf8' });
    if (verify.status !== 0) {
      throw new Error(`APK 签名验证失败：${apkPath}\n${verify.stdout}\n${verify.stderr}`);
    }
  }
  const manifest = files.map(async (file) => {
    const bytes = await readFile(join(outputDir, file));
    const digest = createHash('sha256').update(bytes).digest('hex');
    return `${digest}  ${file}`;
  });
  const lines = await Promise.all(manifest);
  await writeFile(join(outputDir, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
  console.log(`PASS: Android signed release assembled and verified in ${outputDir}`);
  console.log(lines.join('\n'));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
