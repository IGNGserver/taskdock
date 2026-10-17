import type { TreeTaskDto } from '@devtodo/contracts';
import { useMemo, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Folder } from 'lucide-react';
import { useFolders } from '../folder-context.js';
import { directoryPathSegments, formatDirectoryPath } from '../directory-paths.js';

/**
 * Clickable directory path for a task. Lists that mix tasks from many folders
 * (事件 / 今日 / 日历) render this under the title so equal task names stay
 * distinguishable and the owning folder is one click away.
 */
export function TaskFolderBreadcrumb({
  task,
  className,
}: {
  task: Pick<TreeTaskDto, 'id' | 'parentFolderId'>;
  className?: string;
}) {
  const navigate = useNavigate();
  const { folders, loaded } = useFolders();
  const segments = useMemo(
    () => directoryPathSegments(task.parentFolderId, folders),
    [task.parentFolderId, folders],
  );
  const fullPath = useMemo(() => segments.map((segment) => segment.title).join(' / '), [segments]);
  const displayPath = useMemo(() => formatDirectoryPath(segments), [segments]);

  /* Until the shared folder index resolves, "根目录" would be a lie for nested
     tasks; render nothing rather than a wrong label. */
  if (!loaded) return null;

  const target = segments[segments.length - 1] ?? { id: null, title: '根目录' };
  const openFolder = (event: MouseEvent<HTMLButtonElement>) => {
    /* The row owns the task-open action; the breadcrumb must not also fire it. */
    event.stopPropagation();
    navigate(target.id ? `/tree/${target.id}?focusTask=${task.id}` : `/tree?focusTask=${task.id}`);
  };
  return (
    <button
      type="button"
      className={`task-folder-link${className ? ` ${className}` : ''}`}
      onClick={openFolder}
      title={`在目录中显示：${fullPath}`}
      aria-label={`所属目录 ${fullPath}，在目录中显示`}
    >
      <Folder className="task-folder-link__icon" size={13} aria-hidden="true" />
      <span className="task-folder-link__label">{displayPath}</span>
    </button>
  );
}
