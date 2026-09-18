import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readLastFolderId,
  readRecentCaptureFolder,
  recordLastFolderId,
  resolveCaptureFolder,
} from '../src/folder-preference.js';

/**
 * The "most recent valid folder" contract (v2 spec 15.3) was previously broken
 * because the localStorage key was only ever read. These tests pin the
 * resolution order and the ROOT preference.
 */
const folders = [
  { id: 'folder-recent', archivedAt: null, updatedAt: '2026-09-10T00:00:00.000Z' },
  { id: 'folder-newer', archivedAt: null, updatedAt: '2026-09-20T00:00:00.000Z' },
  {
    id: 'folder-archived',
    archivedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
  },
];

function stubStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
}

describe('capture folder preference', () => {
  beforeEach(() => {
    stubStorage();
  });

  it('round-trips the last visited folder', () => {
    expect(readLastFolderId()).toBeNull();
    recordLastFolderId('folder-recent');
    expect(readLastFolderId()).toBe('folder-recent');
    recordLastFolderId(null);
    expect(readLastFolderId()).toBeNull();
  });

  it('prefers the folder the user is currently browsing', () => {
    recordLastFolderId('folder-recent');
    expect(
      resolveCaptureFolder({
        activeFolderId: 'folder-newer',
        defaultCaptureTarget: 'RECENT_FOLDER',
        folders,
      }),
    ).toBe('folder-newer');
  });

  it('ignores an archived active folder and falls back to the recent one', () => {
    recordLastFolderId('folder-recent');
    expect(
      resolveCaptureFolder({
        activeFolderId: 'folder-archived',
        defaultCaptureTarget: 'RECENT_FOLDER',
        folders,
      }),
    ).toBe('folder-recent');
  });

  it('honours the ROOT capture target over a stored recent folder', () => {
    recordLastFolderId('folder-recent');
    expect(
      resolveCaptureFolder({
        activeFolderId: null,
        defaultCaptureTarget: 'ROOT',
        folders,
      }),
    ).toBeNull();
  });

  it('falls back to the most recently updated folder when nothing is remembered', () => {
    expect(
      resolveCaptureFolder({
        activeFolderId: null,
        defaultCaptureTarget: 'RECENT_FOLDER',
        folders,
      }),
    ).toBe('folder-newer');
  });

  it('never resolves to an archived folder when falling back', () => {
    recordLastFolderId('folder-archived');
    expect(
      resolveCaptureFolder({
        activeFolderId: null,
        defaultCaptureTarget: 'RECENT_FOLDER',
        folders: folders.filter((folder) => folder.id !== 'folder-newer'),
      }),
    ).toBe('folder-recent');
  });

  it('exposes the shell-level variant used before folders are loaded', () => {
    recordLastFolderId('folder-recent');
    expect(readRecentCaptureFolder('RECENT_FOLDER')).toBe('folder-recent');
    expect(readRecentCaptureFolder('ROOT')).toBeNull();
  });
});
