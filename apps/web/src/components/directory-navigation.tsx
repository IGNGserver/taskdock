import type { FolderDto } from '@devtodo/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { requestV2 } from '../api.js';
import { directoryEntries } from '../directory-paths.js';
import { Button, IconButton } from './m3e/index.js';

export function DirectoryNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const activeId = location.pathname.startsWith('/tree/')
    ? location.pathname.split('/')[2]
    : undefined;
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setCollapsed(new Set());
  }, [activeId]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const current = ++sequence.current;
    try {
      const response = await requestV2<{ items: FolderDto[] }>('/folders', { signal });
      if (!Array.isArray(response.items)) throw new Error('无法加载目录');
      if (!signal?.aborted && current === sequence.current) {
        setFolders(response.items);
        setError('');
      }
    } catch {
      if (!signal?.aborted && current === sequence.current) setError('无法加载目录');
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    const changed = () => void reload(controller.signal);
    window.addEventListener('devtodo:data-changed', changed);
    return () => {
      controller.abort();
      window.removeEventListener('devtodo:data-changed', changed);
    };
  }, [reload]);
  const entries = useMemo(() => directoryEntries(folders), [folders]);
  const ancestors = useMemo(
    () => new Set(entries.find((entry) => entry.folder.id === activeId)?.ancestors.slice(0, -1)),
    [activeId, entries],
  );
  const children = useMemo(() => {
    const groups = new Map<string | null, FolderDto[]>();
    const ids = new Set(folders.filter((folder) => !folder.deletedAt).map((folder) => folder.id));
    for (const folder of folders.filter((item) => !item.deletedAt)) {
      const parent =
        folder.parentFolderId && ids.has(folder.parentFolderId) ? folder.parentFolderId : null;
      groups.set(parent, [...(groups.get(parent) ?? []), folder]);
    }
    for (const group of groups.values())
      group.sort((left, right) =>
        BigInt(left.rank) < BigInt(right.rank)
          ? -1
          : BigInt(left.rank) > BigInt(right.rank)
            ? 1
            : left.title.localeCompare(right.title),
      );
    return groups;
  }, [folders]);
  const renderFolders = (parent: string | null, visited: Set<string>, depth = 0) => (
    <ul>
      {(children.get(parent) ?? [])
        .filter((folder) => !visited.has(folder.id))
        .map((folder) => {
          const open =
            expanded.has(folder.id) || (ancestors.has(folder.id) && !collapsed.has(folder.id));
          const hasChildren = Boolean(children.get(folder.id)?.length);
          return (
            <li key={folder.id}>
              <div
                className="directory-navigation-row"
                style={{ paddingInlineStart: `${Math.min(depth, 8) * 12}px` }}
              >
                {hasChildren ? (
                  <IconButton
                    size="xs"
                    label={`${open ? '收起' : '展开'} ${folder.title}`}
                    aria-expanded={open}
                    onClick={() => {
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (open) next.delete(folder.id);
                        else next.add(folder.id);
                        return next;
                      });
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (open) next.add(folder.id);
                        else next.delete(folder.id);
                        return next;
                      });
                    }}
                  >
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </IconButton>
                ) : (
                  <span className="directory-navigation-spacer" />
                )}
                <NavLink
                  to={`/tree/${folder.id}`}
                  end
                  onClick={onNavigate}
                  className="directory-navigation-link"
                >
                  {activeId === folder.id ? <FolderOpen size={16} /> : <Folder size={16} />}
                  <span>{folder.title}</span>
                </NavLink>
              </div>
              {hasChildren &&
                open &&
                renderFolders(folder.id, new Set([...visited, folder.id]), depth + 1)}
            </li>
          );
        })}
    </ul>
  );
  return (
    <nav className="directory-navigation" aria-label="目录树">
      <span className="directory-navigation-heading">文件夹</span>
      <NavLink
        to="/tree"
        end
        onClick={onNavigate}
        className="directory-navigation-link directory-navigation-root"
      >
        <Folder size={16} />
        <span>根目录</span>
      </NavLink>
      {error ? (
        <div role="alert">
          {error}
          <Button variant="text" size="s" onClick={() => void reload()}>
            重新加载
          </Button>
        </div>
      ) : (
        renderFolders(null, new Set())
      )}
    </nav>
  );
}
