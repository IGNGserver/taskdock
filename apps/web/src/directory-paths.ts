import type { FolderDto } from '@devtodo/contracts';

/** Resolve labels from the full hierarchy so equal folder names remain distinct. */
export function directoryEntries(folders: readonly FolderDto[]) {
  const active = folders.filter((folder) => !folder.deletedAt);
  const byId = new Map(active.map((folder) => [folder.id, folder]));
  return active.map((folder) => {
    const ancestors: string[] = [];
    const labels: string[] = [];
    const visited = new Set<string>();
    let current: FolderDto | undefined = folder;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      ancestors.unshift(current.id);
      labels.unshift(current.title);
      current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    }
    return { folder, ancestors, label: labels.join(' / ') };
  });
}

export function blockedDirectoryTargets(
  folders: readonly FolderDto[],
  folderIds: readonly string[],
) {
  const selected = new Set(folderIds);
  return new Set(
    directoryEntries(folders)
      .filter((entry) => entry.ancestors.some((id) => selected.has(id)))
      .map((entry) => entry.folder.id),
  );
}

export interface DirectoryPathSegment {
  id: string | null;
  title: string;
}

const ROOT_SEGMENT: DirectoryPathSegment = { id: null, title: '根目录' };

/**
 * Breadcrumb segments from 根目录 down to the task's own folder, so lists that
 * mix tasks from many directories can label each row. Unknown ids resolve to
 * the root segment, and cycles are cut at the first repeat.
 */
export function directoryPathSegments(
  parentFolderId: string | null | undefined,
  folders: readonly FolderDto[],
): DirectoryPathSegment[] {
  if (!parentFolderId) return [ROOT_SEGMENT];
  const active = folders.filter((folder) => !folder.deletedAt);
  const byId = new Map(active.map((folder) => [folder.id, folder]));
  const segments: DirectoryPathSegment[] = [];
  const visited = new Set<string>();
  let current = byId.get(parentFolderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    segments.unshift({ id: current.id, title: current.title });
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return [ROOT_SEGMENT, ...segments];
}

/**
 * Display label for a path. Deep hierarchies keep the first and last segment
 * and collapse the middle so the row stays one line: `根目录 / … / 当前目录`.
 */
export function formatDirectoryPath(segments: readonly DirectoryPathSegment[]): string {
  if (segments.length === 0) return ROOT_SEGMENT.title;
  if (segments.length === 1) return segments[0]?.title ?? ROOT_SEGMENT.title;
  if (segments.length <= 3) return segments.map((segment) => segment.title).join(' / ');
  const first = segments[0]?.title ?? ROOT_SEGMENT.title;
  const last = segments[segments.length - 1]?.title ?? first;
  return `${first} / … / ${last}`;
}
