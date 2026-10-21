import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';

export type ErrorFallback = (error: Error, reset: () => void) => ReactNode;

/**
 * The application is a single React root. Without a boundary at the root, any
 * render, effect or lazy-chunk error unmounts the whole page and leaves a white
 * screen. This component keeps the shell alive and exposes a recoverable error.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    fallback: ErrorFallback;
    onError?: (error: Error, info: ErrorInfo) => void;
  },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('TaskDock UI error', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset);
    return this.props.children;
  }
}

const rootStyle: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  minBlockSize: '100dvh',
  padding: '24px',
  boxSizing: 'border-box',
  background: '#f5f2f9',
  color: '#1d1b20',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const panelStyle: CSSProperties = {
  inlineSize: 'min(560px, 100%)',
  padding: '28px',
  borderRadius: '24px',
  background: '#fff',
  boxShadow: '0 8px 32px rgb(0 0 0 / 12%)',
};

/** Last-resort fallback for errors outside the authenticated workspace. */
export function RootErrorFallback({ error }: { error: Error }) {
  return (
    <main style={rootStyle}>
      <section style={panelStyle} role="alert">
        <h1 style={{ marginBlockStart: 0, fontSize: '1.5rem' }}>TaskDock 暂时无法显示</h1>
        <p>页面遇到了一个未处理的错误。已保存的数据不会因此被删除。</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBlock: '20px' }}>
          <button type="button" onClick={() => window.location.reload()}>
            重新加载应用
          </button>
          <button type="button" onClick={() => window.location.assign('/today')}>
            返回今日
          </button>
        </div>
        <details>
          <summary style={{ cursor: 'pointer' }}>错误详情</summary>
          <pre
            style={{
              overflow: 'auto',
              padding: '12px',
              borderRadius: '8px',
              background: '#f5f2f9',
              fontSize: '12px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.message}
          </pre>
        </details>
      </section>
    </main>
  );
}

/** Inline fallback that leaves the rest of the workspace usable. */
export function TaskDetailErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="workspace-task-detail" role="alert">
      <div className="workspace-detail-header">
        <span>任务详情</span>
      </div>
      <div className="workspace-detail-scroll">
        <h2>任务详情暂时无法显示</h2>
        <p>任务数据没有丢失。可以重试，或刷新页面后从列表重新打开。</p>
        <p>
          <button type="button" onClick={onRetry}>
            重试
          </button>
        </p>
        <details>
          <summary>错误详情</summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{error.message}</pre>
        </details>
      </div>
    </div>
  );
}
