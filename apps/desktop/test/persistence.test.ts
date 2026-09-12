import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHubOriginFile, writeHubOriginFile } from '../src/persistence.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'taskdock-persistence-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, 'nested'));
  return join(directory, 'nested', 'hub-origin.json');
}

describe('desktop Hub origin persistence', () => {
  it('reports a missing setting without treating it as a valid origin', () => {
    expect(readHubOriginFile(createPath())).toEqual({ origin: null, status: 'missing' });
  });

  it('writes a versioned setting atomically and reads it back', () => {
    const filePath = createPath();
    expect(writeHubOriginFile(filePath, 'https://todo.example.com/path/')).toBe(
      'https://todo.example.com',
    );
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      version: 1,
      origin: 'https://todo.example.com',
    });
    expect(readHubOriginFile(filePath)).toEqual({
      origin: 'https://todo.example.com',
      status: 'configured',
    });
  });

  it('accepts legacy unversioned settings for migration on the next save', () => {
    const filePath = createPath();
    writeFileSync(filePath, JSON.stringify({ origin: 'http://127.0.0.1:3333' }));
    expect(readHubOriginFile(filePath)).toEqual({
      origin: 'http://127.0.0.1:3333',
      status: 'configured',
    });
  });

  it('reports malformed settings instead of silently returning an empty address', () => {
    const filePath = createPath();
    writeFileSync(filePath, '{broken');
    expect(readHubOriginFile(filePath)).toMatchObject({ origin: null, status: 'invalid' });
  });
});
