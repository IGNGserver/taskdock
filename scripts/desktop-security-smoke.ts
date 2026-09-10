import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const builderConfig = await readFile(
    new URL('../apps/desktop/electron-builder.yml', import.meta.url),
    'utf8',
  );
  const source = await readFile(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');
  const preload = await readFile(
    new URL('../apps/desktop/src/preload.ts', import.meta.url),
    'utf8',
  );
  const required = [
    'nodeIntegration: false',
    'contextIsolation: true',
    'sandbox: true',
    'webSecurity: true',
    'allowRunningInsecureContent: false',
    'setWindowOpenHandler',
    'will-navigate',
    'process.resourcesPath',
    'devtodo://app/',
    'titleBarStyle',
    'titleBarOverlay',
    'nativeTheme',
    "'devtodo:theme-get'",
    "'devtodo:theme-changed'",
    "'devtodo:hub-test'",
    "'devtodo:hub-request'",
  ];
  for (const marker of required)
    if (!source.includes(marker)) throw new Error(`Electron security marker missing: ${marker}`);
  for (const marker of [
    "'devtodo:auth-login'",
    "'devtodo:auth-refresh'",
    "'devtodo:auth-logout'",
    'safeStorage.encryptString',
  ])
    if (!source.includes(marker))
      throw new Error(`Electron auth boundary marker missing: ${marker}`);
  for (const marker of ['saveRefreshToken', 'readRefreshToken', 'removeRefreshToken'])
    if (preload.includes(marker))
      throw new Error(`raw refresh-token bridge exposure detected: ${marker}`);
  for (const marker of ['getSystemTheme', 'onSystemThemeChanged'])
    if (!preload.includes(marker)) throw new Error(`theme bridge marker missing: ${marker}`);
  if (preload.includes('ipcRenderer:') || preload.includes('require('))
    throw new Error('raw renderer IPC exposure detected');
  for (const marker of ['extraResources:', 'from: ../web/dist', 'to: web'])
    if (!builderConfig.includes(marker))
      throw new Error(`Electron packaging marker missing: ${marker}`);
  console.log(
    'PASS: Electron static security smoke; node integration off, isolation/sandbox/web security on, navigation gated.',
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
