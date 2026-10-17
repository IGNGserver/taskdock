import type { FolderDto } from '@devtodo/contracts';
import { describe, expect, it } from 'vitest';
import {
  blockedDirectoryTargets,
  directoryEntries,
  directoryPathSegments,
  formatDirectoryPath,
} from '../src/directory-paths.js';

function folder(id: string, title: string, parentFolderId: string | null = null): FolderDto {
  return { id, title, parentFolderId, version: 1, rank: '1024', createdAt: '', updatedAt: '' };
}
describe('directory destinations', () => {
  const folders = [
    folder('work', '工作'),
    folder('personal', '个人'),
    folder('release-a', '发布', 'work'),
    folder('release-b', '发布', 'personal'),
    folder('docs', '文档', 'release-a'),
  ];
  it('distinguishes duplicate names with their complete paths', () => {
    expect(directoryEntries(folders).map((entry) => entry.label)).toEqual([
      '工作',
      '个人',
      '工作 / 发布',
      '个人 / 发布',
      '工作 / 发布 / 文档',
    ]);
  });
  it('excludes the moved folders and every descendant while leaving siblings available', () => {
    expect([...blockedDirectoryTargets(folders, ['release-a'])]).toEqual(['release-a', 'docs']);
    expect([...blockedDirectoryTargets(folders, ['work', 'personal'])]).toEqual(
      folders.map((item) => item.id),
    );
  });
  it('terminates with corrupt cycles and ignores deleted parents', () => {
    const corrupt = [
      folder('a', 'A', 'b'),
      folder('b', 'B', 'a'),
      { ...folder('deleted', '删除'), deletedAt: '2026-10-02' },
      folder('orphan', '孤立', 'deleted'),
    ];
    expect(directoryEntries(corrupt)).toHaveLength(3);
    expect(directoryEntries(corrupt).find((entry) => entry.folder.id === 'a')?.ancestors).toEqual([
      'b',
      'a',
    ]);
    expect(directoryEntries(corrupt).find((entry) => entry.folder.id === 'orphan')?.label).toBe(
      '孤立',
    );
  });
  it('resolves breadcrumb segments correctly from root to deepest folder', () => {
    expect(directoryPathSegments(null, folders)).toEqual([{ id: null, title: '根目录' }]);
    expect(directoryPathSegments('work', folders)).toEqual([
      { id: null, title: '根目录' },
      { id: 'work', title: '工作' },
    ]);
    expect(directoryPathSegments('docs', folders)).toEqual([
      { id: null, title: '根目录' },
      { id: 'work', title: '工作' },
      { id: 'release-a', title: '发布' },
      { id: 'docs', title: '文档' },
    ]);
  });
  it('formats directory path string with collapsing for deep hierarchies', () => {
    const rootOnly = [{ id: null, title: '根目录' }];
    const twoLevels = [
      { id: null, title: '根目录' },
      { id: 'work', title: '工作' },
    ];
    const threeLevels = [
      { id: null, title: '根目录' },
      { id: 'work', title: '工作' },
      { id: 'release-a', title: '发布' },
    ];
    const fourLevels = [
      { id: null, title: '根目录' },
      { id: 'work', title: '工作' },
      { id: 'release-a', title: '发布' },
      { id: 'docs', title: '文档' },
    ];
    expect(formatDirectoryPath(rootOnly)).toBe('根目录');
    expect(formatDirectoryPath(twoLevels)).toBe('根目录 / 工作');
    expect(formatDirectoryPath(threeLevels)).toBe('根目录 / 工作 / 发布');
    expect(formatDirectoryPath(fourLevels)).toBe('根目录 / … / 文档');
  });
});
