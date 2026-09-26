/**
 * "Most recently used folder" preference shared by every quick-create entry
 * point.
 *
 * Section 15.3 of the v2 spec says a new task defaults to the current folder;
 * outside the tree it falls back to the most recent valid folder, and to the
 * root only when the user's `defaultCaptureTarget` is ROOT or no folder is
 * valid. Before this module existed the localStorage key was only ever read,
 * so the fallback silently degraded to "first folder by updatedAt" and
 * ignored `defaultCaptureTarget` entirely.
 */
const LAST_FOLDER_KEY = 'taskdock.last-folder-id';

export function readLastFolderId(): string | null {
  try {
    return window.localStorage.getItem(LAST_FOLDER_KEY);
  } catch {
    return null;
  }
}

export function recordLastFolderId(folderId: string | null): void {
  try {
    if (folderId) window.localStorage.setItem(LAST_FOLDER_KEY, folderId);
    else window.localStorage.removeItem(LAST_FOLDER_KEY);
  } catch {
    /* Storage can be unavailable in private mode; the fallback still works. */
  }
}

export interface CaptureTargetFolderInput {
  /** Folder currently open in the tree, if any. */
  activeFolderId: string | null;
  /** `auth.settings?.defaultCaptureTarget`. */
  defaultCaptureTarget: 'ROOT' | 'RECENT_FOLDER' | string | undefined;
  /** Folders the client currently knows about. */
  folders: ReadonlyArray<{ id: string; deletedAt?: string | null; updatedAt?: string }>;
}

/**
 * Resolve the folder a new Task should be created in, honouring the user's
 * capture-target preference. Always returns an id that is present in `folders`
 * and not archived, or null for the root.
 */
export function resolveCaptureFolder(input: CaptureTargetFolderInput): string | null {
  const { activeFolderId, defaultCaptureTarget, folders } = input;
  const isValid = (id: string | null | undefined): id is string =>
    Boolean(id) && folders.some((folder) => folder.id === id && !folder.deletedAt);
  // The folder the user is looking at always wins, regardless of preference:
  // creating into the visible folder is the least surprising behaviour.
  if (isValid(activeFolderId)) return activeFolderId;
  if (defaultCaptureTarget === 'ROOT') return null;
  const recent = readLastFolderId();
  if (isValid(recent)) return recent;
  // No usable recent folder: fall back to the most recently updated one so the
  // user still captures into the tree instead of a silently empty root.
  const mostRecent = [...folders]
    .filter((folder) => !folder.deletedAt)
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))[0];
  return mostRecent?.id ?? null;
}

/**
 * Shell-level variant used where the folder list has not been fetched yet
 * (global quick capture). The server re-validates the parent on write, so this
 * only needs to honour the ROOT preference and the stored recent folder.
 */
export function readRecentCaptureFolder(
  defaultCaptureTarget: 'ROOT' | 'RECENT_FOLDER' | string | undefined,
): string | null {
  if (defaultCaptureTarget === 'ROOT') return null;
  return readLastFolderId();
}
