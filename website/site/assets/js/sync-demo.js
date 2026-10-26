// 离线同步演示：浏览器先写本地，再把待同步队列按顺序推送到中枢；
// 中枢通过 WebSocket 发出“需要同步”的信号，Android 再拉取变化。
// 离线时修改留在队列里；两端改了同一个任务时，版本冲突交给用户决定。

import { flyTo } from './spring.js';

const NEXT = { todo: 'doing', doing: 'done', done: 'todo' };
const LABEL = { todo: '待开始', doing: '进行中', done: '已完成' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function initSync(root) {
  if (!root) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const grid = root.querySelector('[data-sync-grid]');
  const webEl = root.querySelector('[data-client="web"]');
  const andEl = root.querySelector('[data-client="android"]');
  const hubEl = root.querySelector('[data-hub]');
  const cursorEl = root.querySelector('[data-cursor]');
  const outboxEl = root.querySelector('[data-outbox]');
  const outboxCount = root.querySelector('[data-outbox-count]');
  const netLabel = webEl.querySelector('[data-net]');
  const toggle = root.querySelector('[data-net-toggle]');
  const toggleLabel = root.querySelector('[data-net-label]');
  const remoteBtn = root.querySelector('[data-remote-edit]');
  const log = root.querySelector('[data-sync-log]');
  const wires = root.querySelector('[data-wires]');

  const seed = [
    { id: 'a', ref: 'TASK-214', title: '迁移脚本加回滚演练', s: 'doing' },
    { id: 'b', ref: 'TASK-219', title: '整理同步冲突的复现步骤', s: 'todo' },
    { id: 'c', ref: 'TASK-188', title: '升级到 PostgreSQL 18', s: 'done' },
  ];
  const hub = {
    cursor: 1042,
    tasks: Object.fromEntries(seed.map((t) => [t.id, { s: t.s, v: 3 }])),
  };
  const web = {
    online: true,
    tasks: Object.fromEntries(seed.map((t) => [t.id, { s: t.s, v: 3 }])),
    outbox: [],
    conflict: null,
  };
  const android = { tasks: Object.fromEntries(seed.map((t) => [t.id, { s: t.s, v: 3 }])) };
  const meta = Object.fromEntries(seed.map((t) => [t.id, t]));
  let busy = false;

  const say = (html) => {
    log.innerHTML = html;
  };

  function renderList(el, state, { interactive }) {
    const list = el.querySelector('[data-list]');
    list.innerHTML = seed
      .map((t) => {
        const st = state.tasks[t.id];
        const pending = interactive && web.outbox.some((op) => op.task === t.id);
        const conflict = interactive && web.conflict && web.conflict.task === t.id;
        const status = interactive
          ? `<button class="status" type="button" data-cycle="${t.id}" data-s="${st.s}" aria-label="切换「${t.title}」的状态，当前${LABEL[st.s]}"></button>`
          : `<span class="status" data-s="${st.s}"></span>`;
        const tag = conflict
          ? '<span class="tag">冲突</span>'
          : pending
            ? '<span class="tag">待同步</span>'
            : '';
        return `<div class="mini${pending ? ' is-pending' : ''}${conflict ? ' is-conflict' : ''}" data-row="${t.id}">${status}<span>${t.title}</span>${tag}</div>`;
      })
      .join('');
  }

  function renderOutbox() {
    outboxEl.innerHTML = web.outbox
      .map(
        (op) => `<span class="op" data-op="${op.id}">${meta[op.task].ref} → ${LABEL[op.to]}</span>`,
      )
      .join('');
    outboxCount.textContent = String(web.outbox.length);
  }

  function renderConflict() {
    webEl.querySelector('.conflict')?.remove();
    if (!web.conflict) return;
    const c = web.conflict;
    const box = document.createElement('div');
    box.className = 'conflict';
    box.innerHTML = `<b>${meta[c.task].ref} 版本冲突</b><br>本地：${LABEL[c.local]} · 服务器：${LABEL[c.server]}。两份都保留着，由你决定。
      <div class="row"><button class="btn" type="button" data-resolve="local">采用本地</button><button class="btn" type="button" data-resolve="server">采用服务器</button></div>`;
    webEl.append(box);
  }

  function render() {
    renderList(webEl, web, { interactive: true });
    renderList(andEl, android, { interactive: false });
    renderOutbox();
    renderConflict();
    cursorEl.textContent = `cursor ${hub.cursor}`;
    webEl.classList.toggle('is-offline', !web.online);
    netLabel.textContent = web.online ? '在线' : '离线';
    toggle.setAttribute('aria-checked', String(web.online));
    toggleLabel.textContent = web.online ? '浏览器在线' : '浏览器离线';
    remoteBtn.disabled = web.online || busy;
    wires.querySelector('[data-wire="a"]').classList.toggle('is-down', !web.online);
  }

  function drawWires() {
    const g = grid.getBoundingClientRect();
    const w = webEl.getBoundingClientRect();
    const h = hubEl.getBoundingClientRect();
    const a = andEl.getBoundingClientRect();
    wires.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
    wires.setAttribute('width', g.width);
    wires.setAttribute('height', g.height);
    const vertical = h.top > w.bottom - 4;
    const rel = (x, y) => [x - g.left, y - g.top];
    let d1;
    let d2;
    if (vertical) {
      const [x1, y1] = rel(w.left + w.width / 2, w.bottom);
      const [x2, y2] = rel(h.left + h.width / 2, h.top);
      const [x3, y3] = rel(h.left + h.width / 2, h.bottom);
      const [x4, y4] = rel(a.left + a.width / 2, a.top);
      d1 = `M${x1},${y1} L${x2},${y2}`;
      d2 = `M${x3},${y3} L${x4},${y4}`;
    } else {
      const [x1, y1] = rel(w.right, w.top + w.height * 0.4);
      const [x2, y2] = rel(h.left, h.top + h.height / 2);
      const [x3, y3] = rel(h.right, h.top + h.height / 2);
      const [x4, y4] = rel(a.left, a.top + a.height * 0.4);
      const mx1 = (x1 + x2) / 2;
      const mx2 = (x3 + x4) / 2;
      d1 = `M${x1},${y1} C${mx1},${y1} ${mx1},${y2} ${x2},${y2}`;
      d2 = `M${x3},${y3} C${mx2},${y3} ${mx2},${y4} ${x4},${y4}`;
    }
    wires.querySelector('[data-wire="a"]').setAttribute('d', d1);
    wires.querySelector('[data-wire="b"]').setAttribute('d', d2);
  }

  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  /** 一枚小标签从 from 飞到 to（视口坐标），用于展示推送与通知。 */
  async function fly(label, fromEl, toEl, ping = false) {
    if (reduced || document.hidden) return;
    const chip = document.createElement('span');
    chip.className = `op is-flying${ping ? ' is-ping' : ''}`;
    chip.textContent = label;
    document.body.append(chip);
    const cw = chip.offsetWidth;
    const ch = chip.offsetHeight;
    const a = center(fromEl);
    const b = center(toEl);
    await flyTo(
      chip,
      { x: a.x - cw / 2, y: a.y - ch / 2 },
      { x: b.x - cw / 2, y: b.y - ch / 2 },
      { duration: 640, arc: 26 },
    ).catch(() => {});
    chip.remove();
  }

  function pulse(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  async function androidPull(ids) {
    await fly('sync.required', hubEl, andEl, true);
    for (const id of ids) android.tasks[id] = { ...hub.tasks[id] };
    render();
    ids.forEach((id) => {
      const row = andEl.querySelector(`[data-row="${id}"]`);
      if (row) pulse(row, 'is-flash');
    });
  }

  async function flush() {
    if (busy || !web.online || !web.outbox.length) return;
    busy = true;
    render();
    const changed = new Set();
    while (web.outbox.length && web.online) {
      const op = web.outbox[0];
      const opEl = outboxEl.querySelector(`[data-op="${op.id}"]`) || webEl;
      await fly(`${meta[op.task].ref} → ${LABEL[op.to]}`, opEl, hubEl);
      web.outbox.shift();
      const server = hub.tasks[op.task];
      if (op.base === server.v) {
        server.s = op.to;
        server.v += 1;
        hub.cursor += 1;
        // 同一任务后续排队的修改，以新版本为基准继续重放
        web.outbox.forEach((rest) => {
          if (rest.task === op.task) rest.base = server.v;
        });
        if (!web.outbox.some((rest) => rest.task === op.task))
          web.tasks[op.task] = { s: op.to, v: server.v };
        changed.add(op.task);
        pulse(hubEl, 'is-hit');
        say(
          `中枢已应用 <b>${meta[op.task].ref} → ${LABEL[op.to]}</b>，版本 ${server.v}，变更游标前进到 ${hub.cursor}。`,
        );
      } else {
        // 版本冲突：保留本地意图与服务器快照，不静默覆盖
        web.outbox = web.outbox.filter((rest) => rest.task !== op.task);
        web.conflict = {
          task: op.task,
          local: web.tasks[op.task].s,
          server: server.s,
          serverV: server.v,
        };
        say(
          `<b>${meta[op.task].ref}</b> 的基准版本是 ${op.base}，中枢已经是 ${server.v}：返回冲突与服务器快照，等你选择。`,
        );
      }
      render();
      await sleep(reduced ? 0 : 120);
    }
    // 拉取：浏览器离线期间其他设备的变化
    for (const id of Object.keys(hub.tasks)) {
      const local = web.tasks[id];
      const server = hub.tasks[id];
      if (server.v > local.v && !(web.conflict && web.conflict.task === id)) {
        web.tasks[id] = { ...server };
      }
    }
    render();
    if (changed.size) await androidPull([...changed]);
    busy = false;
    render();
  }

  function edit(id) {
    if (web.conflict && web.conflict.task === id) return;
    const t = web.tasks[id];
    const to = NEXT[t.s];
    // 先写本地：实体与待同步记录在同一个事务里
    const pendingBase = web.outbox.find((op) => op.task === id)?.base;
    web.outbox.push({
      id: `${Date.now()}-${Math.random()}`,
      task: id,
      to,
      base: pendingBase ?? t.v,
    });
    t.s = to;
    render();
    if (web.online) {
      say(`本地已写入 <b>${meta[id].ref} → ${LABEL[to]}</b>，正在推送……`);
      flush();
    } else {
      say(
        `离线：<b>${meta[id].ref} → ${LABEL[to]}</b> 已写入本地，排进待同步队列（${web.outbox.length}）。`,
      );
    }
  }

  root.addEventListener('click', async (e) => {
    const cycle = e.target.closest('[data-cycle]');
    if (cycle) {
      edit(cycle.dataset.cycle);
      return;
    }
    const resolve = e.target.closest('[data-resolve]');
    if (resolve && web.conflict) {
      const c = web.conflict;
      web.conflict = null;
      if (resolve.dataset.resolve === 'server') {
        web.tasks[c.task] = { ...hub.tasks[c.task] };
        say(`已采用服务器版本：<b>${meta[c.task].ref}</b> 是 ${LABEL[hub.tasks[c.task].s]}。`);
        render();
      } else {
        web.tasks[c.task] = { s: c.local, v: hub.tasks[c.task].v };
        web.outbox.push({
          id: `r-${Date.now()}`,
          task: c.task,
          to: c.local,
          base: hub.tasks[c.task].v,
        });
        say(`已采用本地版本，基于最新版本重新推送 <b>${meta[c.task].ref}</b>……`);
        render();
        flush();
      }
    }
  });

  toggle.addEventListener('click', () => {
    if (busy && web.online) return;
    web.online = !web.online;
    render();
    if (web.online) {
      say(
        web.outbox.length
          ? `重新连上中枢：按顺序推送 ${web.outbox.length} 条修改……`
          : '重新连上中枢，没有待同步的修改。',
      );
      flush();
    } else {
      say('浏览器离线了。照常改任务：界面立刻更新，修改排进待同步队列。');
    }
  });

  remoteBtn.addEventListener('click', async () => {
    if (web.online || busy) return;
    // Android 修改了浏览器离线期间也改过的任务（没有则改第一个）
    const id = web.outbox[0]?.task || 'a';
    const server = hub.tasks[id];
    // 选一个与服务器、浏览器本地都不同的状态，冲突才看得出差别
    const to =
      ['todo', 'doing', 'done'].find((x) => x !== server.s && x !== web.tasks[id].s) ||
      NEXT[server.s];
    busy = true;
    render();
    await fly(`${meta[id].ref} → ${LABEL[to]}`, andEl, hubEl);
    server.s = to;
    server.v += 1;
    hub.cursor += 1;
    android.tasks[id] = { ...server };
    pulse(hubEl, 'is-hit');
    busy = false;
    render();
    // 远端修改进行中如果浏览器已经重新上线，此刻补上推送
    if (web.online && web.outbox.length) {
      flush();
      return;
    }
    say(
      `Android 把 <b>${meta[id].ref}</b> 改成了 ${LABEL[to]}。浏览器离线，收不到通知；重新连上时会发现版本对不上。`,
    );
  });

  render();
  drawWires();
  new ResizeObserver(drawWires).observe(grid);
}
