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
