// “一个任务，四个维度”：同一个任务在目录、日程、流程、步骤四个视图里被引用。
// 切换视图时，任务卡作为共享元素在视图之间移动（View Transitions）；
// 任意一处切换状态，所有引用同时更新，文件夹状态随之重新推导。

const NEXT = { todo: 'doing', doing: 'done', done: 'todo' };
const LABEL = { todo: '待开始', doing: '进行中', done: '已完成' };
const DESC = {
  tree: '文件夹可以无限嵌套，同一级里文件夹和任务并存。文件夹没有手动状态，由全部后代任务实时推导。',
  time: '同一个任务可以同时出现在多个日期，也可以挂在「额度重置后」「上线前」这样的自定义事件上。',
  flow: '把任务放进分阶段的流程看板。一个任务可以加入多个流程，在同一个流程里只出现一次。',
  steps: '在任务内部列出线性步骤，并附上 Markdown 笔记。步骤有自己的三态状态，不会自动改动任务状态。',
};
const WHERE = { tree: '/tree/发布-2.0', time: '/time/calendar', flow: '/workflows/发布-2.0', steps: 'TASK-214 · 详情' };

const focus = {
  title: '迁移脚本加回滚演练',
  ref: 'TASK-214',
  s: 'doing',
  steps: [
    ['备份生产数据库', 'done'],
    ['在副本上执行迁移', 'doing'],
    ['演练回滚并记录耗时', 'todo'],
    ['更新恢复文档', 'todo'],
  ],
};

const svg = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

function focusCard(extra = '') {
  return `<div class="tcard focus-card" data-focus ${extra}>
    <button class="status" type="button" data-focus-status data-s="${focus.s}" aria-label="切换 ${focus.ref} 的状态，当前${LABEL[focus.s]}"></button>
    <span class="tcard-body"><span class="tcard-title">${focus.title}</span>
    <span class="tcard-meta"><span class="ref">${focus.ref}</span><span class="ref" data-focus-label>${LABEL[focus.s]}</span></span></span>
    <span class="chip chip-flow">${svg('i-steps')}<span data-step-count></span></span>
  </div>`;
}

function mini(title, s, { isFocus = false, other = false } = {}) {
  if (isFocus) {
    return `<div class="mini is-focus"><button class="status" type="button" data-focus-status data-s="${focus.s}" aria-label="切换 ${focus.ref} 的状态"></button><span data-focus-title>${focus.title}</span></div>`;
  }
  return `<div class="mini${other ? ' is-other' : ''}"><span class="status" data-s="${s}"></span><span>${title}</span></div>`;
}

function days() {
  const out = [];
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  const wd = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });
  for (let i = 0; i < 4; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push({ day: d.getDate(), wd: i === 0 ? '今天' : wd.format(d) });
  }
  return out;
}

/** 文件夹状态：全部待开始＝待开始，全部完成＝已完成，其余为进行中。 */
function derive(list) {
  if (list.every((s) => s === 'todo')) return 'todo';
  if (list.every((s) => s === 'done')) return 'done';
  return 'doing';
}

function views() {
  const d = days();
  return {
    tree: `
      <div class="tree">
        <div class="tree-row is-folder">${svg('i-folder')}开发<span class="agg" data-agg="dev"></span></div>
        <div class="tree-row is-folder" style="--depth:1">${svg('i-folder')}TaskDock<span class="agg" data-agg="td"></span></div>
        <div class="tree-row is-folder" style="--depth:2">${svg('i-folder')}发布 2.0<span class="agg" data-agg="rel"></span></div>
        ${focusCard('style="--depth:3"')}
        <div class="tree-row" style="--depth:3"><span class="status" data-s="done"></span>更新部署说明</div>
        <div class="tree-row is-folder" style="--depth:2">${svg('i-folder')}Android<span class="agg" data-agg="and"></span></div>
        <div class="tree-row" style="--depth:1"><span class="status" data-s="todo"></span>整理家里 NAS 的备份</div>
        <p class="tree-note">文件夹状态由全部后代任务推导，试试把任务标记为已完成。</p>
      </div>`,
    time: `
      ${focusCard()}
      <div class="week" style="margin-top:16px">
        ${d
          .map(
            (x, i) => `<div class="day${i === 0 ? ' is-today' : ''}">
              <div class="day-head"><span>${x.wd}</span><b>${x.day}</b></div>
              ${i === 0 ? mini('', '', { isFocus: true }) + mini('回复 issue 里的同步问题', 'doing', { other: true }) : ''}
              ${i === 1 ? mini('修复 Android 冷启动读取凭据', 'todo', { other: true }) : ''}
              ${i === 2 ? mini('', '', { isFocus: true }) : ''}
              ${i === 3 ? mini('给备份脚本补一次恢复演练', 'todo', { other: true }) : ''}
            </div>`,
          )
          .join('')}
      </div>
      <div class="events-row">
        <div class="event-col"><div class="day-head"><b>额度重置后</b><span>事件</span></div>${mini('重跑 e2e 门禁', 'todo', { other: true })}</div>
        <div class="event-col"><div class="day-head"><b>上线前</b><span>事件</span></div>${mini('', '', { isFocus: true })}</div>
      </div>`,
    flow: `
      ${focusCard()}
      <div class="flow-title" style="margin-top:18px">${svg('i-flow')}<span>流程 · 发布 2.0</span><span class="chip">也在「数据库升级」流程中</span></div>
      <div class="board">
        <div class="lane"><div class="lane-head">规划<span class="n">1</span></div>${mini('梳理升级说明', 'done', { other: true })}</div>
        <div class="lane"><div class="lane-head">实现<span class="n">2</span></div>${mini('导出脚本', 'done', { other: true })}${mini('迁移幂等检查', 'doing', { other: true })}</div>
        <div class="lane"><div class="lane-head">验证<span class="n">2</span></div>${mini('', '', { isFocus: true })}${mini('三浏览器 e2e', 'todo', { other: true })}</div>
        <div class="lane"><div class="lane-head">发布<span class="n">1</span></div>${mini('更新部署说明', 'done', { other: true })}</div>
      </div>`,
    steps: `
      <div class="steps-card">
        ${focusCard()}
        <ol class="steps">
          ${focus.steps
            .map(
              ([label, s], i) => `<li><button class="status" type="button" data-step="${i}" data-s="${s}" aria-label="切换步骤「${label}」的状态"></button><span class="lbl">${label}</span><span class="st" data-step-label="${i}">${LABEL[s]}</span></li>`,
            )
            .join('')}
        </ol>
      </div>
      <div class="note-block"><span class="h">## 回滚演练</span>
- 迁移前先 <span class="c">\`pg_dump\`</span>，备份放在另一块盘
- 副本上演练：迁移 → 回滚 → 对比行数</div>`,
  };
}

export function initDimensions(lens, tabsEl) {
  if (!lens || !tabsEl) return;
  const stage = lens.querySelector('[data-lens-stage]');
  const where = lens.querySelector('[data-lens-where]');
  const desc = document.querySelector('[data-model-desc]');
  const tabs = [...tabsEl.querySelectorAll('[role="tab"]')];
  let current = 'tree';

  const caption = () => `<div class="lens-caption"><span>点任务前的圆圈：待开始 → 进行中 → 已完成</span><span class="ref" data-caption-ref>${focus.ref} · ${LABEL[focus.s]}</span></div>`;

  function sync() {
    stage.querySelectorAll('[data-focus-status]').forEach((el) => {
      el.dataset.s = focus.s;
      el.setAttribute('aria-label', `切换 ${focus.ref} 的状态，当前${LABEL[focus.s]}`);
    });
    stage.querySelectorAll('[data-focus]').forEach((el) => {
      el.dataset.s = focus.s;
    });
    stage.querySelectorAll('[data-focus-label]').forEach((el) => {
      el.textContent = LABEL[focus.s];
    });
    stage.querySelectorAll('[data-focus-title]').forEach((el) => {
      el.style.textDecoration = focus.s === 'done' ? 'line-through' : '';
      el.style.color = focus.s === 'done' ? 'var(--text-3)' : '';
    });
    const doneSteps = focus.steps.filter(([, s]) => s === 'done').length;
    stage.querySelectorAll('[data-step-count]').forEach((el) => {
      el.textContent = `步骤 ${doneSteps}/${focus.steps.length}`;
    });
    const ref = stage.querySelector('[data-caption-ref]');
    if (ref) ref.textContent = `${focus.ref} · ${LABEL[focus.s]}`;

    // 文件夹状态推导
    // 每个文件夹统计全部层级的后代任务，而不是子文件夹的状态
    const relTasks = [focus.s, 'done'];
    const andTasks = ['doing', 'todo'];
    const tdTasks = [...relTasks, ...andTasks];
    const devTasks = [...tdTasks, 'todo'];
    const aggs = { rel: derive(relTasks), and: derive(andTasks), td: derive(tdTasks), dev: derive(devTasks) };
    stage.querySelectorAll('[data-agg]').forEach((el) => {
      const s = aggs[el.dataset.agg];
      const changed = el.dataset.s && el.dataset.s !== s;
      el.dataset.s = s;
      el.innerHTML = `${LABEL[s]}`;
      el.style.color = s === 'done' ? 'var(--sage)' : s === 'doing' ? 'var(--amber)' : '';
      if (changed) el.animate([{ opacity: 0.2, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' });
    });
  }

  function render(view) {
    stage.innerHTML = views()[view] + caption();
    where.textContent = WHERE[view];
    if (desc) desc.textContent = DESC[view];
    stage.setAttribute('aria-labelledby', `tab-${view}`);
    sync();
  }

  function show(view, focusTab = false) {
    if (view === current) return;
    current = view;
    tabs.forEach((t) => {
      const on = t.dataset.view === view;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focusTab) t.focus();
    });
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.startViewTransition && !reduced) {
      // 连续快速切换时上一段过渡会被跳过，这是预期行为，不当作错误
      const vt = document.startViewTransition(() => render(view));
      vt.ready.catch(() => {});
      vt.finished.catch(() => {});
    } else {
      render(view);
    }
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => show(tab.dataset.view));
    tab.addEventListener('keydown', (e) => {
      const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const next = tabs[(i + keys[e.key] + tabs.length) % tabs.length];
      show(next.dataset.view, true);
    });
  });

  stage.addEventListener('click', (e) => {
    const fs = e.target.closest('[data-focus-status]');
    if (fs) {
      focus.s = NEXT[focus.s];
      sync();
      return;
    }
    const st = e.target.closest('[data-step]');
    if (st) {
      const i = Number(st.dataset.step);
      focus.steps[i][1] = NEXT[focus.steps[i][1]];
      st.dataset.s = focus.steps[i][1];
      const lbl = stage.querySelector(`[data-step-label="${i}"]`);
      if (lbl) lbl.textContent = LABEL[focus.steps[i][1]];
      sync();
    }
  });

  render(current);
}
