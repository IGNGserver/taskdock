// 时间轴演示：拖动（或点选）任务到日期 / 事件列，生成一条“安排”。
// 安排只是引用：在任一处切换状态，所有安排同时变化；
// 顺延只复制仍未完成的安排到次日，并且可以撤销；事件到达不改变任务。

const NEXT = { todo: 'doing', doing: 'done', done: 'todo' };
const LABEL = { todo: '待开始', doing: '进行中', done: '已完成' };

const tasks = {
  t1: { title: '迁移脚本加回滚演练', s: 'doing' },
  t2: { title: '整理同步冲突的复现步骤', s: 'todo' },
  t3: { title: '升级到 PostgreSQL 18', s: 'done' },
  t4: { title: '写目录树的迁移笔记', s: 'todo' },
};

let uid = 0;
const P = (task, col) => ({ id: `p${++uid}`, task, col });

export function initTimeline(root) {
  if (!root) return;
  const tray = root.querySelector('[data-tray]');
  const colsEl = root.querySelector('[data-tl-cols]');
  const msg = root.querySelector('[data-tl-msg]');
  const undoBtn = root.querySelector('[data-tl-undo]');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 列：今天起 5 天 + 2 个自定义事件
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  const wd = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' });
  const md = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });
  const cols = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    cols.push({ id: `d${i}`, kind: 'date', title: i === 0 ? '今天' : i === 1 ? '明天' : wd.format(d), sub: md.format(d) });
  }
  cols.push({ id: 'e1', kind: 'event', title: '额度重置后', sub: '自定义事件', arrived: false });
  cols.push({ id: 'e2', kind: 'event', title: '上线前', sub: '自定义事件', arrived: false });
  const colById = Object.fromEntries(cols.map((c) => [c.id, c]));

  let placements = [P('t1', 'd0'), P('t3', 'd0'), P('t2', 'd0'), P('t1', 'd2'), P('t4', 'e2')];
  let lastRollover = null;
  let selected = null;
  let freshIds = new Set();

  const say = (text) => {
    msg.textContent = text;
    msg.classList.remove('is-fresh');
    void msg.offsetWidth;
    msg.classList.add('is-fresh');
    clearTimeout(say.t);
    say.t = setTimeout(() => msg.classList.remove('is-fresh'), 1800);
  };

  function renderTray() {
    tray.innerHTML = ['t1', 't2', 't4']
      .map(
        (id) => `<button class="pill-task" type="button" data-task="${id}" aria-pressed="${selected === id}">
          <span class="status" data-s="${tasks[id].s}"></span>${tasks[id].title}</button>`,
      )
      .join('');
  }

  function renderCols() {
    colsEl.innerHTML = cols
      .map((c, i) => {
        const items = placements
          .filter((p) => p.col === c.id)
          .map((p) => {
            const t = tasks[p.task];
            const done = t.s === 'done';
            return `<div class="mini${freshIds.has(p.id) ? ' is-new' : ''}" data-placement="${p.id}">
              <button class="status" type="button" data-cycle="${p.task}" data-s="${t.s}" aria-label="切换「${t.title}」的状态，当前${LABEL[t.s]}"></button>
              <span style="${done ? 'text-decoration:line-through;color:var(--text-3)' : ''}">${t.title}</span></div>`;
          })
          .join('');
        const divider = i === 5 ? '<div class="tl-divider" aria-hidden="true"></div>' : '';
        const action =
          c.id === 'd0'
            ? `<div class="tl-actions"><button class="btn btn-small" type="button" data-rollover>顺延未完成到明天</button></div>`
            : c.kind === 'event'
              ? `<div class="tl-actions"><button class="btn btn-small" type="button" data-arrive="${c.id}">${c.arrived ? '撤回到达' : '标记已到达'}</button></div>`
              : '';
        return `${divider}<div class="tl-col${c.id === 'd0' ? ' is-today' : ''}${c.kind === 'event' ? ' is-event' : ''}${c.arrived ? ' has-arrived' : ''}${selected ? ' is-target' : ''}" data-col="${c.id}" role="group" aria-label="${c.title} ${c.sub}">
          <div class="tl-head"><b>${c.title}</b><span>${c.kind === 'date' ? c.sub : ''}</span></div>
          <div class="tl-kind">${c.kind === 'date' ? '日期' : '事件 · 无固定日期'}</div>
          <div class="tl-items">${items}</div>
          ${selected ? `<button class="tl-drop" type="button" data-drop="${c.id}">放到这里</button>` : '<div class="tl-drop" aria-hidden="true">拖到这里</div>'}
          ${action}
        </div>`;
      })
      .join('');
  }

  function render() {
    const scroll = colsEl.scrollLeft;
    renderTray();
    renderCols();
    colsEl.scrollLeft = scroll;
    freshIds = new Set();
  }

  function place(taskId, colId) {
    const col = colById[colId];
    const t = tasks[taskId];
    if (placements.some((p) => p.task === taskId && p.col === colId)) {
      say(`「${t.title}」已经安排在${col.title}了——重复安排不会产生第二条。`);
      return;
    }
    const p = P(taskId, colId);
    placements.push(p);
    freshIds.add(p.id);
    const count = placements.filter((x) => x.task === taskId).length;
    say(`「${t.title}」现在出现在 ${count} 处安排里，它们引用的是同一个任务。`);
    render();
  }

  function move(pid, colId) {
    const p = placements.find((x) => x.id === pid);
    if (!p || p.col === colId) return;
    const t = tasks[p.task];
    if (placements.some((x) => x.task === p.task && x.col === colId)) {
      say(`「${t.title}」在${colById[colId].title}已经有一条安排了。`);
      return;
    }
    const from = colById[p.col].title;
    p.col = colId;
    freshIds.add(p.id);
    say(`「${t.title}」从${from}移到了${colById[colId].title}：移动的是安排，任务本身没变。`);
    render();
  }

  // —— 点击：选择 / 放置 / 切换状态 / 顺延 / 事件到达 ——
  root.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const cycle = e.target.closest('[data-cycle]');
    if (cycle) {
      const t = tasks[cycle.dataset.cycle];
      t.s = NEXT[t.s];
      const n = placements.filter((p) => p.task === cycle.dataset.cycle).length;
      say(`「${t.title}」→ ${LABEL[t.s]}。${n > 1 ? `${n} 处安排同时更新。` : ''}`);
      render();
      return;
    }
    const pill = e.target.closest('[data-task]');
    if (pill) {
      selected = selected === pill.dataset.task ? null : pill.dataset.task;
      if (selected) say(`已选中「${tasks[selected].title}」，点一个日期或事件放进去。按 Esc 取消。`);
      render();
      return;
    }
    const drop = e.target.closest('[data-drop]');
    if (drop && selected) {
      const id = selected;
      selected = null;
      place(id, drop.dataset.drop);
      return;
    }
    if (e.target.closest('[data-rollover]')) {
      const created = [];
      const skipped = [];
      placements
        .filter((p) => p.col === 'd0')
        .forEach((p) => {
          const t = tasks[p.task];
          if (t.s === 'done') {
            skipped.push(t.title);
            return;
          }
          if (placements.some((x) => x.task === p.task && x.col === 'd1')) return;
          const np = P(p.task, 'd1');
          created.push(np);
        });
      placements.push(...created);
      created.forEach((p) => freshIds.add(p.id));
      lastRollover = created.map((p) => p.id);
      undoBtn.hidden = created.length === 0;
      say(
        created.length
          ? `已顺延 ${created.length} 个安排到明天${skipped.length ? `，跳过 ${skipped.length} 个已完成任务` : ''}。今天的安排保持不变。`
          : `没有需要顺延的安排${skipped.length ? `（已完成的任务会被跳过）` : ''}。`,
      );
      render();
      return;
    }
    const arrive = e.target.closest('[data-arrive]');
    if (arrive) {
      const c = colById[arrive.dataset.arrive];
      c.arrived = !c.arrived;
      const inside = placements.filter((p) => p.col === c.id).map((p) => tasks[p.task]);
      say(
        c.arrived
          ? `「${c.title}」已到达。${inside.length ? `里面的任务仍然是${inside.map((t) => LABEL[t.s]).join('、')}——事件到达不改动任务。` : '事件到达只改变事件本身。'}`
          : `已撤回「${c.title}」的到达状态。`,
      );
      render();
    }
  });

  undoBtn.addEventListener('click', () => {
    if (!lastRollover) return;
    placements = placements.filter((p) => !lastRollover.includes(p.id));
    say(`已撤销刚才的顺延，删除 ${lastRollover.length} 条新建的安排。`);
    lastRollover = null;
    undoBtn.hidden = true;
    render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected) {
      selected = null;
      render();
    }
  });

  // —— 拖放：托盘里的任务（新增安排）/ 列里的安排（移动，仅鼠标与触控笔） ——
  let drag = null;
  let suppressClick = false;

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.status')) return;
    const pill = e.target.closest('[data-task]');
    const mini = e.target.closest('[data-placement]');
    if (!pill && !(mini && e.pointerType !== 'touch')) return;
    const src = pill || mini;
    const rect = src.getBoundingClientRect();
    drag = {
      src,
      pid: mini ? mini.dataset.placement : null,
      task: pill ? pill.dataset.task : placements.find((p) => p.id === mini.dataset.placement)?.task,
      sx: e.clientX,
      sy: e.clientY,
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
      w: rect.width,
      ghost: null,
      over: null,
      x: rect.left,
      y: rect.top,
      vx: 0,
      lastX: e.clientX,
    };
    src.setPointerCapture(e.pointerId);
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
      const g = drag.src.cloneNode(true);
      g.classList.add('pill-ghost');
      if (g.classList.contains('mini')) g.style.width = `${drag.w}px`;
      g.removeAttribute('data-task');
      g.removeAttribute('data-placement');
      document.body.append(g);
      drag.ghost = g;
      drag.src.style.opacity = '0.4';
    }
    // 跟手 + 按水平速度倾斜，像被提起来的纸片
    drag.vx = drag.vx * 0.7 + (e.clientX - drag.lastX) * 0.3;
    drag.lastX = e.clientX;
    const tilt = reduced ? 0 : Math.max(-10, Math.min(10, drag.vx * 0.6));
    drag.x = e.clientX - drag.ox;
    drag.y = e.clientY - drag.oy;
    drag.ghost.style.transform = `translate(${drag.x}px, ${drag.y}px) rotate(${tilt}deg) scale(1.04)`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const col = under ? under.closest('[data-col]') : null;
    if (drag.over && drag.over !== col) drag.over.classList.remove('is-over');
    if (col) col.classList.add('is-over');
    drag.over = col;
  });

  const finish = async (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.src.style.opacity = '';
    if (!d.ghost) return;
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
    const col = e.type === 'pointerup' ? d.over : null;
    if (d.over) d.over.classList.remove('is-over');
    if (col) {
      // 先让幽灵卡片“吸”到列里，再更新数据
      const items = col.querySelector('.tl-items');
      const r = items.getBoundingClientRect();
      const toY = r.top + items.scrollHeight;
      if (!reduced) {
        await d.ghost
          .animate(
            [
              { transform: d.ghost.style.transform, opacity: 1 },
              { transform: `translate(${r.left}px, ${toY}px) rotate(0deg) scale(0.92)`, opacity: 0.2 },
            ],
            { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' },
          )
          .finished.catch(() => {});
      }
      d.ghost.remove();
      if (d.pid) move(d.pid, col.dataset.col);
      else place(d.task, col.dataset.col);
    } else {
      // 没放进任何一列：弹回原处
      const r = d.src.getBoundingClientRect();
      if (!reduced) {
        await d.ghost
          .animate(
            [{ transform: d.ghost.style.transform }, { transform: `translate(${r.left}px, ${r.top}px) rotate(0deg) scale(1)` }],
            { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'forwards' },
          )
          .finished.catch(() => {});
      }
      d.ghost.remove();
    }
  };
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', finish);

  render();
}
