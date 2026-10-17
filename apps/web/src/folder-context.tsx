import type { FolderDto } from '@devtodo/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { requestV2 } from './api.js';
import { useAuth } from './auth.js';

interface FolderContextValue {
  folders: readonly FolderDto[];
  /** True once a `/folders` snapshot has been read; labels are only real after that. */
  loaded: boolean;
  error: string;
  refresh: () => Promise<void>;
}

const FolderContext = createContext<FolderContextValue>({
  folders: [],
  loaded: false,
  error: '',
  refresh: async () => {},
});

/**
 * One shared folder index for every surface that labels a task with its
 * directory. The placement lists on 今日 / 事件 / 日历 mix tasks from many
 * folders, so the labels must come from a single snapshot instead of a fetch
 * per row; `devtodo:data-changed` keeps it in step with the tree.
 */
export function FolderProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++sequence.current;
    try {
      const response = await requestV2<{ items: FolderDto[] }>('/folders', { signal });
      if (signal?.aborted || current !== sequence.current) return;
      setFolders(Array.isArray(response.items) ? response.items : []);
      setLoaded(true);
      setError('');
    } catch (cause) {
      if (signal?.aborted || current !== sequence.current) return;
      setError(cause instanceof Error ? cause.message : '无法加载目录');
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') {
      sequence.current += 1;
      setFolders([]);
      setLoaded(false);
      setError('');
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    const changed = () => void load(controller.signal);
    window.addEventListener('devtodo:data-changed', changed);
    return () => {
      controller.abort();
      window.removeEventListener('devtodo:data-changed', changed);
    };
  }, [status, load]);

  const value = useMemo<FolderContextValue>(
    () => ({ folders, loaded, error, refresh: () => load() }),
    [folders, loaded, error, load],
  );

  return <FolderContext.Provider value={value}>{children}</FolderContext.Provider>;
}

export function useFolders(): FolderContextValue {
  return useContext(FolderContext);
}
