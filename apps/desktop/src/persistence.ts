import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseHubOrigin } from './hub-policy.js';

export type HubOriginFileStatus = 'configured' | 'missing' | 'invalid' | 'unreadable';

export interface HubOriginFileState {
  origin: string | null;
  status: HubOriginFileStatus;
  message?: string;
}

interface HubOriginFileValue {
  version?: unknown;
  origin?: unknown;
}

/**
 * Reads the desktop Hub setting without exposing a filesystem path to the
 * renderer. Legacy files without a version are accepted and are upgraded on
 * the next successful save.
 */
export function readHubOriginFile(filePath: string): HubOriginFileState {
  if (!existsSync(filePath)) return { origin: null, status: 'missing' };

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {
      origin: null,
      status: 'unreadable',
      message: '无法读取桌面端中枢配置，请检查应用数据目录权限。',
    };
  }

  let parsed: HubOriginFileValue;
  try {
    parsed = JSON.parse(raw) as HubOriginFileValue;
  } catch {
    return {
      origin: null,
      status: 'invalid',
      message: '桌面端中枢配置文件损坏，请重新保存中枢地址。',
    };
  }

  if (parsed.version !== undefined && parsed.version !== 1) {
    return {
      origin: null,
      status: 'invalid',
      message: '桌面端中枢配置版本不受支持，请重新保存中枢地址。',
    };
  }

  if (typeof parsed.origin !== 'string') {
    return {
      origin: null,
      status: 'invalid',
      message: '桌面端中枢配置缺少有效地址，请重新保存中枢地址。',
    };
  }

  const origin = parseHubOrigin(parsed.origin);
  if (!origin) {
    return {
      origin: null,
      status: 'invalid',
      message: '桌面端中枢配置地址无效，请重新保存中枢地址。',
    };
  }

  return { origin, status: 'configured' };
}

export function writeHubOriginFile(filePath: string, value: string): string {
  const origin = parseHubOrigin(value);
  if (!origin) throw new Error('Hub origin must be a valid HTTP or HTTPS URL without credentials');
  atomicWriteFile(filePath, `${JSON.stringify({ version: 1, origin })}\n`);
  return origin;
}

/**
 * Writes small desktop state files through a same-directory temporary file.
 * The rename prevents a process interruption from leaving a truncated JSON or
 * token file behind.
 */
export function atomicWriteFile(filePath: string, value: string | Uint8Array): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    writeFileSync(temporaryPath, value, { mode: 0o600, flag: 'wx' });
    chmodSync(temporaryPath, 0o600);
    descriptor = openSync(temporaryPath, 'r+');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A failed cleanup must not hide the original write error.
      }
    }
  }
}
