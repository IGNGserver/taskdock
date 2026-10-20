import { Component, type ReactNode } from 'react';

/** A missing/offline deployment chunk must not take the entire workspace down. */
export class LazyPageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section role="alert" className="page">
        <h2>页面暂时无法打开</h2>
        <p>可能处于离线状态或应用刚刚更新。可以切换到已缓存的页面；恢复网络后重新打开。</p>
        <p>重新加载前，请先保存其他页面尚未提交的编辑。</p>
        <button type="button" onClick={() => location.reload()}>
          重新加载应用
        </button>
      </section>
    );
  }
}
