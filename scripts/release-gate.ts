import { spawnSync } from 'node:child_process';
import { createPool } from '../packages/database/src/index.js';

type GateStatus = 'PASS' | 'FAIL' | 'NOT RUN';
type GateResult = { name: string; status: GateStatus; exitCode: number };

const checks = [
  ['format', ['format:check']],
  ['lint', ['lint']],
  ['typecheck', ['typecheck']],
  ['unit', ['test']],
  ['openapi', ['openapi:check']],
  ['integration-postgres', ['test:integration']],
  // Keep the destructive, large-fixture benchmark before browser E2E.  The
  // real E2E server bootstraps a test Owner and must not make the later
  // capacity fixture fail with BOOTSTRAP_ALREADY_COMPLETED when both checks
  // intentionally share one DATABASE_URL in a local release run.
  ['capacity-postgres', ['perf:capacity']],
  ['build', ['build']],
  ['built-server-process', ['server:smoke']],
  ['browser-e2e', ['test:e2e']],
  ['browser-a11y', ['a11y']],
  ['compose-restart-backup', ['compose:smoke']],
  ['desktop-security', ['desktop:test']],
  ['desktop-package-and-launch', ['desktop:package']],
  ['android-release', ['android:assembleRelease']],
] as const;

function runCheck(
  name: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): GateResult {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync('pnpm', args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv,
      REQUIRE_DESKTOP_LAUNCH: '1',
      REQUIRE_WINDOWS_RELEASE: '1',
    },
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`FAIL: could not start pnpm for ${name}: ${String(result.error)}`);
    return { name, status: 'FAIL', exitCode: 1 };
  }
  const exitCode = result.status ?? 1;
  if (exitCode === 0) return { name, status: 'PASS', exitCode };
  if (exitCode === 2) {
    console.error(`NOT RUN: ${name} returned the unavailable-environment exit code 2.`);
    return { name, status: 'NOT RUN', exitCode };
  }
  return { name, status: 'FAIL', exitCode };
}

async function cleanupBrowserFixture(username: string): Promise<GateResult | undefined> {
  if (process.env['E2E_REAL'] !== '1') return undefined;
  const databaseUrl = process.env['E2E_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!databaseUrl) return undefined;

  const pool = createPool(databaseUrl);
  try {
    const result = await pool.query('DELETE FROM users WHERE username = $1 RETURNING id', [
      username,
    ]);
    console.log(
      `PASS: browser E2E fixture cleanup removed ${result.rowCount ?? 0} test Owner record(s).`,
    );
    return undefined;
  } catch (error) {
    console.error(`FAIL: browser E2E fixture cleanup failed: ${String(error)}`);
    return { name: 'browser-e2e-fixture-cleanup', status: 'FAIL', exitCode: 1 };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const browserE2EUsername = `e2e-release-${process.pid}-${Date.now()}`;
  const results: GateResult[] = [];
  for (const [name, args] of checks) {
    const extraEnv: NodeJS.ProcessEnv =
      name === 'browser-e2e'
        ? {
            E2E_USERNAME: browserE2EUsername,
            ...(process.env['E2E_REAL'] === '1' &&
            !process.env['E2E_DATABASE_URL'] &&
            process.env['DATABASE_URL']
              ? { E2E_DATABASE_URL: process.env['DATABASE_URL'] }
              : {}),
          }
        : {};
    const result = runCheck(name, args, extraEnv);
    results.push(result);
    if (name === 'browser-e2e') {
      const cleanupFailure = await cleanupBrowserFixture(browserE2EUsername);
      if (cleanupFailure) results.push(cleanupFailure);
    }
  }
  console.log('\n=== release gate summary ===');
  for (const result of results)
    console.log(`${result.status.padEnd(8)} ${result.name} (exit ${result.exitCode})`);
  const blocked = results.filter((result) => result.status !== 'PASS');
  if (blocked.length) {
    console.error(
      `FAIL: release gate blocked by ${blocked.map((result) => `${result.name}:${result.status}`).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('PASS: every required release gate executed and passed.');
}

void main().catch((error: unknown) => {
  console.error('FAIL: release gate crashed.');
  console.error(error);
  process.exitCode = 1;
});
