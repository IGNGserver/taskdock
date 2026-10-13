import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const executable = join(root, 'apps', 'desktop', 'release', 'linux-unpacked', 'devtodo');
const sandboxHelper = join(root, 'apps', 'desktop', 'release', 'linux-unpacked', 'chrome-sandbox');

function commandExists(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'sh';
  const args =
    process.platform === 'win32'
      ? [command]
      : ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command];
  return spawnSync(lookup, args, { stdio: 'ignore' }).status === 0;
}

async function main(): Promise<void> {
  try {
    await access(executable);
  } catch {
    console.log('NOT RUN: Linux Electron package is missing; build it before launch smoke.');
    process.exitCode = 2;
    return;
  }

  if (process.platform === 'linux') {
    try {
      const helper = await stat(sandboxHelper);
      const mode = helper.mode & 0o7777;
      if (helper.uid !== 0 || mode !== 0o4755) {
        console.log(
          'NOT RUN: Electron chrome-sandbox requires a root-owned 4755 helper on this Linux host; refusing an unsandboxed launch.',
        );
        process.exitCode = 2;
        return;
      }
    } catch {
      /* Electron may use an alternate sandbox implementation when no helper is packaged. */
    }
  }

  const hasDisplay = Boolean(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']);
  const useXvfb = !hasDisplay && commandExists('xvfb-run');
  if (!hasDisplay && !useXvfb) {
    console.log(
      'NOT RUN: no graphical display or xvfb-run is available for Electron launch smoke.',
    );
    process.exitCode = 2;
    return;
  }

  const command = useXvfb ? 'xvfb-run' : executable;
  const args = useXvfb
    ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', executable, '--disable-gpu']
    : ['--disable-gpu'];
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, DEVTODO_DESKTOP_SMOKE: '1', ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let sawWindow = false;
  let sawRenderer = false;
  let sawBridge = false;
  let fatal = false;
  const consume = (chunk: Buffer): void => {
    const text = chunk.toString();
    output += text;
    sawWindow ||= text.includes('DEVTODO_DESKTOP_WINDOW_CREATED');
    sawRenderer ||= text.includes('DEVTODO_DESKTOP_RENDERER_READY');
    sawBridge ||= text.includes('DEVTODO_DESKTOP_BRIDGE_READY');
    fatal ||=
      /DevTodo desktop failed to start|ReferenceError:|uncaughtException|UnhandledPromiseRejection/i.test(
        text,
      );
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const deadline = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), 20_000),
  );
  const result = await Promise.race([exit, deadline]);
  if (result === 'timeout') {
    child.kill('SIGTERM');
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }
  if (fatal || !sawWindow || !sawRenderer || !sawBridge) {
    console.error('FAIL: Electron launch smoke did not reach a healthy window and renderer.');
    console.error(output);
    process.exitCode = 1;
    return;
  }
  if (result !== 'timeout') {
    console.error(
      `FAIL: Electron exited before supervisor shutdown (code=${result.code}, signal=${result.signal}).`,
    );
    console.error(output);
    process.exitCode = 1;
    return;
  }
  console.log(
    'PASS: packaged Linux Electron reached app readiness, window creation, and renderer load.',
  );
}

void main().catch((error: unknown) => {
  console.error('FAIL: Electron launch smoke crashed.');
  console.error(error);
  process.exitCode = 1;
});
