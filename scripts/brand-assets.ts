import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const brandingDir = join(rootDir, 'assets', 'branding');
const masterPng = join(brandingDir, 'taskdock-icon.png');

interface Raster {
  width: number;
  height: number;
  rgba: Buffer;
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function decodePng(bytes: Buffer): Raster {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('品牌母版不是有效 PNG');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlaceMethod = data[12]!;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height || bitDepth !== 8 || ![2, 6].includes(colorType) || interlaceMethod !== 0) {
    throw new Error('品牌母版 PNG 必须是 8-bit、非隔行 RGB/RGBA 图像');
  }

  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(rowBytes);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++]!;
    const filtered = inflated.subarray(inputOffset, inputOffset + rowBytes);
    inputOffset += rowBytes;
    const row = Buffer.alloc(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= channels ? row[index - channels]! : 0;
      const up = previous[index]!;
      const upperLeft = index >= channels ? previous[index - channels]! : 0;
      const value = filtered[index]!;
      row[index] =
        filter === 0
          ? value
          : filter === 1
            ? (value + left) & 0xff
            : filter === 2
              ? (value + up) & 0xff
              : filter === 3
                ? (value + Math.floor((left + up) / 2)) & 0xff
                : filter === 4
                  ? (value + paethPredictor(left, up, upperLeft)) & 0xff
                  : (() => {
                      throw new Error(`PNG 使用了不支持的 filter 类型：${filter}`);
                    })();
    }
    for (let x = 0; x < width; x += 1) {
      const sourceOffset = x * channels;
      const targetOffset = (y * width + x) * 4;
      rgba[targetOffset] = row[sourceOffset]!;
      rgba[targetOffset + 1] = row[sourceOffset + 1]!;
      rgba[targetOffset + 2] = row[sourceOffset + 2]!;
      rgba[targetOffset + 3] = channels === 4 ? row[sourceOffset + 3]! : 255;
    }
    previous = row;
  }
  return { width, height, rgba };
}

function resizeCover(source: Raster, width: number, height: number): Buffer {
  const scale = Math.max(width / source.width, height / source.height);
  const visibleWidth = width / scale;
  const visibleHeight = height / scale;
  const cropX = (source.width - visibleWidth) / 2;
  const cropY = (source.height - visibleHeight) / 2;
  const result = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(source.width - 1, cropX + (x + 0.5) / scale - 0.5));
      const sourceY = Math.max(0, Math.min(source.height - 1, cropY + (y + 0.5) / scale - 0.5));
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const y1 = Math.min(source.height - 1, y0 + 1);
      const xWeight = sourceX - x0;
      const yWeight = sourceY - y0;
      const targetOffset = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const topLeft = source.rgba[(y0 * source.width + x0) * 4 + channel]!;
        const topRight = source.rgba[(y0 * source.width + x1) * 4 + channel]!;
        const bottomLeft = source.rgba[(y1 * source.width + x0) * 4 + channel]!;
        const bottomRight = source.rgba[(y1 * source.width + x1) * 4 + channel]!;
        const top = topLeft + (topRight - topLeft) * xWeight;
        const bottom = bottomLeft + (bottomRight - bottomLeft) * xWeight;
        result[targetOffset + channel] = Math.round(top + (bottom - top) * yWeight);
      }
    }
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  payload.copy(output, 4);
  output.writeUInt32BE(crc32(payload), 8 + data.length);
  return output;
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (1 + width * 4);
    scanlines[rowOffset] = 0;
    rgba.copy(scanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function icoFromPng(png: Buffer): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 0;
  header[7] = 0;
  header[8] = 0;
  header[9] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

async function writeBinary(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let existing: Buffer | null = null;
  try {
    existing = await readFile(path);
  } catch {
    /* The generated asset does not exist yet. */
  }
  if (!existing || !existing.equals(data)) await writeFile(path, data);
}

async function copyExact(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function main(): Promise<void> {
  const sourceBytes = await readFile(masterPng);
  const source = decodePng(sourceBytes);
  const resized = (width: number, height: number) =>
    encodePng(width, height, resizeCover(source, width, height));
  const webPublic = join(rootDir, 'apps', 'web', 'public');

  await writeBinary(join(webPublic, 'favicon.png'), resized(64, 64));
  await writeBinary(join(webPublic, 'pwa-180.png'), resized(180, 180));
  await writeBinary(join(webPublic, 'pwa-192.png'), resized(192, 192));
  await writeBinary(join(webPublic, 'pwa-512.png'), resized(512, 512));
  await writeBinary(join(webPublic, 'brand', 'taskdock-icon.png'), resized(512, 512));

  const desktopIcons = join(rootDir, 'apps', 'desktop', 'resources', 'icons');
  await copyExact(masterPng, join(desktopIcons, 'taskdock-icon.png'));
  await writeBinary(join(desktopIcons, 'icon.ico'), icoFromPng(resized(256, 256)));

  const androidRes = join(rootDir, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res');
  await copyExact(masterPng, join(androidRes, 'drawable-nodpi', 'taskdock_icon.png'));
  const launcherSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 } as const;
  for (const [density, size] of Object.entries(launcherSizes)) {
    await writeBinary(
      join(androidRes, `mipmap-${density}`, 'ic_launcher.png'),
      resized(size, size),
    );
    await writeBinary(
      join(androidRes, `mipmap-${density}`, 'ic_launcher_round.png'),
      resized(size, size),
    );
    await writeBinary(
      join(androidRes, `mipmap-${density}`, 'ic_launcher_foreground.png'),
      resized(size, size),
    );
  }

  const splashSizes = {
    drawable: [480, 320],
    'drawable-land-mdpi': [480, 320],
    'drawable-land-hdpi': [800, 480],
    'drawable-land-xhdpi': [1280, 720],
    'drawable-land-xxhdpi': [1600, 960],
    'drawable-land-xxxhdpi': [1920, 1280],
    'drawable-port-mdpi': [320, 480],
    'drawable-port-hdpi': [480, 800],
    'drawable-port-xhdpi': [720, 1280],
    'drawable-port-xxhdpi': [960, 1600],
    'drawable-port-xxxhdpi': [1280, 1920],
  } as const;
  for (const [directory, [width, height]] of Object.entries(splashSizes)) {
    await writeBinary(join(androidRes, directory, 'splash.png'), resized(width, height));
  }

  console.log('PASS: exact selected ImageGen PNG synced to all brand surfaces.');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
