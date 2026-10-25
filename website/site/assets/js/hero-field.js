// 首屏：散落的任务卡随滚动被“磁吸”进目录面板，按状态分组归位。
// 卡片可以拖动：散落时可以随手甩开，归位后可以在组内重新排序；
// 点状态圆圈按「待开始 → 进行中 → 已完成」切换，卡片会移动到对应分组。

import { Spring2D, clamp, createLoop, easeInOut, easeOut, integrate, lerp, prefersReducedMotion } from './spring.js';

const TASKS = [
  { id: 'a', title: '迁移脚本加回滚演练', ref: 'TASK-214', s: 'doing', chip: ['flow', '验证'] },
  { id: 'b', title: '修复 Android 冷启动读取凭据', ref: 'TASK-208', s: 'doing', chip: ['date', '明天'] },
  { id: 'c', title: '整理同步冲突的复现步骤', ref: 'TASK-219', s: 'doing', chip: ['steps', '步骤 2/4'], mobile: false },
  { id: 'd', title: '额度重置后重跑 e2e 门禁', ref: 'TASK-221', s: 'todo', chip: ['event', '额度重置后'] },
  { id: 'e', title: '上线前检查 HTTPS 与 CORS', ref: 'TASK-223', s: 'todo', chip: ['event', '上线前'] },
  { id: 'f', title: '给备份脚本补一次恢复演练', ref: 'TASK-197', s: 'todo', chip: ['date', '周六'] },
  { id: 'g', title: '升级到 PostgreSQL 18', ref: 'TASK-188', s: 'done', chip: ['note', '笔记'] },
  { id: 'h', title: '统一移动端底部导航', ref: 'TASK-176', s: 'done', chip: ['flow', '发布'] },
  { id: 'i', title: '清理过期的同步游标', ref: 'TASK-181', s: 'done', chip: ['date', '周一'], mobile: false },
];

const GROUPS = ['doing', 'todo', 'done'];
const NEXT = { todo: 'doing', doing: 'done', done: 'todo' };

// 散落构图（中心点，按舞台归一化）：桌面避开左侧文案，移动端集中在下方与边缘
const SCATTER_DESKTOP = [
  [0.67, 0.2, -11, 0.86], [0.9, 0.12, 8, 0.8], [0.79, 0.37, -4, 0.9], [0.99, 0.5, 13, 0.78],
  [0.69, 0.6, 7, 0.85], [0.87, 0.73, -9, 0.9], [0.63, 0.9, 4, 0.82], [0.96, 0.92, -6, 0.8],
  [0.24, 0.95, -7, 0.78],
];
const SCATTER_MOBILE = [
  [0.22, 0.7, -9, 0.9], [0.8, 0.66, 8, 0.86], [0.5, 0.79, 3, 0.95], [0.12, 0.9, 10, 0.86],
  [0.86, 0.86, -7, 0.9], [0.45, 0.97, -4, 0.92], [1.0, 0.98, 12, 0.82],
];

const ICONS = {
  flow: '<svg aria-hidden="true"><use href="#i-flow"/></svg>',
  date: '<svg aria-hidden="true"><use href="#i-cal"/></svg>',
  event: '<svg aria-hidden="true"><use href="#i-flag"/></svg>',
  steps: '<svg aria-hidden="true"><use href="#i-steps"/></svg>',
  note: '<svg aria-hidden="true"><use href="#i-note"/></svg>',
};
const CHIP_CLASS = { flow: 'chip-flow', date: 'chip-date', event: 'chip-event', steps: '', note: '' };

function cardHTML(t) {
  const [kind, text] = t.chip;
  return `<span class="status" data-s="${t.s}"></span>
    <span class="tcard-body"><span class="tcard-title">${t.title}</span>
    <span class="tcard-meta"><span class="ref">${t.ref}</span></span></span>
    <span class="chip ${CHIP_CLASS[kind]}">${ICONS[kind]}${text}</span>`;
}

export function initHero(track) {
  if (!track) return;
  const stage = track.querySelector('.hero-stage');
  const field = track.querySelector('[data-field]');
  const copy = track.querySelector('.hero-copy');
  const panel = track.querySelector('[data-panel]');
  const countEl = track.querySelector('[data-count]');
  const meter = track.querySelector('[data-meter]');
  const meterLabel = track.querySelector('[data-meter-label]');
  const resetBtn = track.querySelector('[data-hero-reset]');
  const labels = Object.fromEntries(
    GROUPS.map((g) => [g, track.querySelector(`[data-group="${g}"]`)]),
  );
  const reduced = prefersReducedMotion();

  let mobile = window.innerWidth < 760;
  let tasks = [];
  let cards = [];
  let order = {};
  let geo = null;
  let progress = 0;
  let pointer = null;
  let drag = null;
  let visible = true;
  let interacted = false;
  const panelSpring = new Spring2D();
  panelSpring.k = 170;
  panelSpring.c = 22;
  const labelSprings = Object.fromEntries(GROUPS.map((g) => [g, new Spring2D()]));
  Object.values(labelSprings).forEach((s) => {
    s.k = 170;
    s.c = 22;
  });

  // —— 标题里“散落的”三个字随进度归正 ——
  const scatterLine = track.querySelector('[data-scatter]');
  let glyphs = [];
  if (scatterLine) {
    const text = scatterLine.textContent;
    scatterLine.setAttribute('aria-label', text);
    scatterLine.textContent = '';
    const jitter = [
      [0, 0, 0], [-4, -10, -12], [6, 8, 10], [-3, -6, -8], [0, 0, 0], [0, 0, 0],
    ];
    [...text].forEach((ch, i) => {
      const span = document.createElement('span');
      span.className = 'scatter';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = ch;
      scatterLine.append(span);
      glyphs.push({ el: span, j: jitter[i] || [0, 0, 0] });
    });
  }

  function build() {
    field.querySelectorAll('.tcard').forEach((el) => el.remove());
    const pick = TASKS.filter((t) => !mobile || t.mobile !== false);
    const scatter = mobile ? SCATTER_MOBILE : SCATTER_DESKTOP;
    tasks = pick.map((t, i) => ({ ...t, anchor: scatter[i % scatter.length].slice(), custom: null }));
    order = Object.fromEntries(GROUPS.map((g) => [g, tasks.filter((t) => t.s === g).map((t) => t.id)]));
    // 归位顺序打散一点，看起来像被一张张吸过去，而不是排队
    const settleOrder = [2, 0, 4, 1, 6, 3, 8, 5, 7];
    cards = tasks.map((t, i) => {
      const el = document.createElement('div');
      el.className = 'tcard';
      el.dataset.s = t.s;
      el.innerHTML = cardHTML(t);
      field.append(el);
      const sp = new Spring2D();
      const rank = settleOrder.indexOf(i) >= 0 ? settleOrder.indexOf(i) : i;
      return {
        t,
        el,
        sp,
        start: 0.06 + (rank / tasks.length) * 0.34,
        phase: Math.random() * Math.PI * 2,
        docked: false,
        e: 0,
      };
    });
    attachCardEvents();
  }

  function measure() {
    const W = field.clientWidth;
    const H = field.clientHeight;
    const headerH = mobile ? 58 : 64;
    const rowH = cards[0]?.el.offsetHeight || 58;
    const m = { head: 50, label: 28, row: rowH, gap: 7, groupGap: 8, pad: 14 };
    const n = tasks.length;
    const tall = m.head + 3 * m.label + n * (m.row + m.gap) + 2 * m.groupGap + m.pad;
    let px;
    let pw;
    let top;
    let avail;
    if (mobile) {
      const g = Math.max(16, Math.min(40, W * 0.04));
      px = g;
      pw = W - g * 2;
      top = headerH + 14;
      avail = H - top - 56;
    } else {
      const cr = copy.getBoundingClientRect();
      const fr = field.getBoundingClientRect();
      const g = Math.max(16, Math.min(40, W * 0.04));
      px = Math.max(cr.right - fr.left + 56, W * 0.5);
      pw = Math.min(460, W - px - Math.max(g, (W - 1200) / 2));
      top = headerH + 24;
      avail = H - top - 64;
    }
    const s = clamp(avail / tall, 0.62, 1);
    const ph = tall * s;
    const py = mobile ? top : Math.max(top, top + (avail - ph) / 2);
    geo = { W, H, px, pw, py, s, m, fs: scatterLine ? parseFloat(getComputedStyle(scatterLine).fontSize) / 90 : 1 };
    const cw = (pw - 28) / s;
    field.style.setProperty('--card-w', `${cw}px`);
    geo.cw = cw;
    geo.ch = rowH;
  }

  /** 根据当前分组顺序计算每张卡的槽位与分组标题的位置。 */
  function slots() {
    const { px, py, pw, s, m } = geo;
    const out = {};
    const labelY = {};
    let y = py + m.head * s;
    GROUPS.forEach((g, gi) => {
      labelY[g] = y + (m.label * s) / 2;
      y += m.label * s;
      order[g].forEach((id) => {
        out[id] = { x: px + pw / 2, y: y + (m.row * s) / 2, s };
        y += (m.row + m.gap) * s;
      });
      if (gi < GROUPS.length - 1) y += m.groupGap * s;
    });
    return { out, labelY, height: y - py + m.pad * s };
  }

  function scatterPos(c, time) {
    const { W, H, s } = geo;
    const a = c.t.custom || c.t.anchor;
    const drift = reduced ? 0 : 1;
    const x = a[0] * W + Math.sin(time * 0.00042 + c.phase) * 9 * drift;
    const y = a[1] * H + Math.cos(time * 0.00037 + c.phase * 1.3) * 8 * drift;
    const r = a[2] + Math.sin(time * 0.0003 + c.phase) * 1.4 * drift;
    let px = x;
    let py = y;
    // 指针附近的卡片会被轻轻吸向指针
    if (pointer && !mobile) {
      const dx = pointer.x - x;
      const dy = pointer.y - y;
      const d = Math.hypot(dx, dy);
      const R = 200;
      if (d < R) {
        const f = (1 - d / R) * 0.16;
        px += dx * f;
        py += dy * f;
      }
    }
    return { x: px, y: py, r, s: (a[3] || 1) * s };
  }

  function readProgress() {
    const rect = track.getBoundingClientRect();
    const span = rect.height - window.innerHeight;
    return span > 0 ? clamp(-rect.top / span, 0, 1) : 1;
  }

  let lastLayout = null;
  function tick(dt, now) {
    if (!geo) return false;
    progress = reduced ? 1 : readProgress();
    const layout = slots();
    lastLayout = layout;
    let docked = 0;
    let moving = false;
    let avgE = 0;

    for (const c of cards) {
      const raw = clamp((progress - c.start) / 0.3, 0, 1);
      c.e = easeInOut(raw);
      avgE += c.e / cards.length;
      const sp = c.sp;
      if (drag && drag.card === c) {
        sp.tx = drag.x;
        sp.ty = drag.y;
        sp.tr = 0;
        sp.k = 700;
        sp.c = 46;
      } else {
        const a = scatterPos(c, now);
        const b = layout.out[c.t.id];
        sp.tx = lerp(a.x, b.x, c.e);
        sp.ty = lerp(a.y, b.y, c.e);
        sp.tr = lerp(a.r, 0, c.e);
        c.scale = lerp(a.s, b.s, c.e);
        sp.k = lerp(46, 210, c.e);
        sp.c = lerp(9, 24, c.e);
      }
      if (c.e > 0.96 && !(drag && drag.card === c)) {
        docked += 1;
        if (!c.docked) {
          c.docked = true;
          if (!reduced) {
            c.el.classList.remove('just-docked');
            void c.el.offsetWidth;
            c.el.classList.add('just-docked');
          }
        }
      } else if (c.e < 0.5) {
        c.docked = false;
      }
    }

    if (reduced) {
      cards.forEach((c) => c.sp.snap());
    } else {
      integrate(cards.map((c) => c.sp), dt);
    }

    const { cw, ch } = geo;
    for (const c of cards) {
      const sp = c.sp;
      const sc = drag && drag.card === c ? (c.scale || 1) * 1.04 : c.scale || 1;
      c.el.style.transform = `translate3d(${(sp.x - cw / 2).toFixed(2)}px, ${(sp.y - ch / 2).toFixed(2)}px, 0) rotate(${sp.r.toFixed(2)}deg) scale(${sc.toFixed(4)})`;
      c.el.style.zIndex = drag && drag.card === c ? 20 : String(5 + Math.round(c.e * 4));
      c.el.style.opacity = String(lerp(0.88, 1, c.e));
      if (!sp.settled(0.08)) moving = true;
    }

    // 面板与分组标题
    const po = easeOut(clamp((progress - 0.08) / 0.32, 0, 1));
    panelSpring.tx = layout.height;
    for (const g of GROUPS) labelSprings[g].ty = layout.labelY[g];
    if (reduced || !panelSpring.inited) {
      panelSpring.snap();
      GROUPS.forEach((g) => labelSprings[g].snap());
      panelSpring.inited = true;
    } else {
      integrate([panelSpring, ...Object.values(labelSprings)], dt);
    }
    panel.style.left = `${geo.px}px`;
    panel.style.top = `${geo.py}px`;
    panel.style.width = `${geo.pw}px`;
    panel.style.height = `${panelSpring.x}px`;
    panel.style.opacity = String(po);
    panel.style.transform = `translateY(${((1 - po) * 24).toFixed(1)}px) scale(${(0.97 + 0.03 * po).toFixed(4)})`;
    for (const g of GROUPS) {
      const el = labels[g];
      el.style.transform = `translate3d(${geo.px + 20}px, ${(labelSprings[g].y - 9).toFixed(1)}px, 0) scale(${geo.s})`;
      el.style.transformOrigin = '0 50%';
      el.style.opacity = String(clamp((avgE - 0.55) / 0.35, 0, 1));
      el.querySelector('.n').textContent = String(order[g].length);
      if (!labelSprings[g].settled(0.1)) moving = true;
    }
    if (!panelSpring.settled(0.1)) moving = true;

    countEl.textContent = `已归位 ${docked}/${cards.length}`;
    meter.style.setProperty('--p', avgE.toFixed(3));
    meterLabel.textContent = avgE < 0.08 ? '散落' : avgE < 0.97 ? '归位中' : '已归位';

    // 标题字形
    const ge = 1 - easeInOut(clamp((progress - 0.02) / 0.4, 0, 1));
    // 抖动幅度按字号缩放：小屏上不压到下一行
    const fs = geo.fs;
    for (const gl of glyphs) {
      const [dx, dy, dr] = gl.j.map((v, i) => (i < 2 ? v * fs : v));
      gl.el.style.transform = ge > 0.001 ? `translate(${dx * ge}px, ${dy * ge}px) rotate(${dr * ge}deg)` : '';
    }

    // 移动端：文案让出舞台给面板
    if (mobile) {
      const fade = easeInOut(clamp((progress - 0.06) / 0.2, 0, 1));
      copy.style.opacity = String(1 - fade);
      copy.style.transform = `translateY(${-fade * 48}px)`;
      copy.style.visibility = fade > 0.98 ? 'hidden' : '';
    } else {
      copy.style.opacity = '';
      copy.style.transform = '';
      copy.style.visibility = '';
    }

    resetBtn.classList.toggle('is-visible', interacted && avgE > 0.9);

    // 有漂移时需要持续动画；看不见就停
    const drifting = !reduced && avgE < 0.999;
    return visible && (moving || drifting || Boolean(drag));
  }

  const loop = createLoop(tick);

  // —— 交互 ——
  function toField(e) {
    const r = field.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function cycleStatus(c) {
    const next = NEXT[c.t.s];
    c.t.s = next;
    c.el.dataset.s = next;
    c.el.querySelector('.status').dataset.s = next;
    interacted = true;
    clearTimeout(c.regroupTimer);
    c.regroupTimer = setTimeout(() => {
      for (const g of GROUPS) order[g] = order[g].filter((id) => id !== c.t.id);
      if (next === 'done') order[next].unshift(c.t.id);
      else order[next].push(c.t.id);
      loop.kick();
    }, 420);
    loop.kick();
  }

  function attachCardEvents() {
    for (const c of cards) {
      c.el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const p = toField(e);
        drag = {
          card: c,
          id: e.pointerId,
          ox: c.sp.x - p.x,
          oy: c.sp.y - p.y,
          x: c.sp.x,
          y: c.sp.y,
          sx: p.x,
          sy: p.y,
          t0: performance.now(),
          moved: false,
          onStatus: Boolean(e.target.closest('.status')),
          hist: [{ x: p.x, y: p.y, t: performance.now() }],
        };
        c.el.setPointerCapture(e.pointerId);
        loop.kick();
      });
      c.el.addEventListener('pointermove', (e) => {
        if (!drag || drag.card !== c || drag.id !== e.pointerId) return;
        const p = toField(e);
        if (!drag.moved && Math.hypot(p.x - drag.sx, p.y - drag.sy) > 4) {
          drag.moved = true;
          c.el.classList.add('is-dragging');
        }
        if (!drag.moved) return;
        drag.x = p.x + drag.ox;
        drag.y = p.y + drag.oy;
        drag.hist.push({ x: p.x, y: p.y, t: performance.now() });
        if (drag.hist.length > 6) drag.hist.shift();
        if (c.e > 0.5) reorderWhileDragging(c, drag.y);
        loop.kick();
      });
      const end = (e) => {
        if (!drag || drag.card !== c || drag.id !== e.pointerId) return;
        const d = drag;
        drag = null;
        c.el.classList.remove('is-dragging');
        if (!d.moved) {
          if (d.onStatus && e.type === 'pointerup') cycleStatus(c);
          loop.kick();
          return;
        }
        interacted = true;
        if (c.e <= 0.5 && geo) {
          // 散落状态：带着速度甩出去，停在新的位置继续漂浮
          const h = d.hist;
          const a = h[0];
          const b = h[h.length - 1];
          const dt = Math.max(16, b.t - a.t) / 1000;
          const vx = (b.x - a.x) / dt;
          const vy = (b.y - a.y) / dt;
          const nx = clamp(d.x + vx * 0.16, 30, geo.W - 30);
          const ny = clamp(d.y + vy * 0.16, 80, geo.H - 30);
          c.sp.vx = vx * 0.4;
          c.sp.vy = vy * 0.4;
          c.t.custom = [nx / geo.W, ny / geo.H, (Math.random() - 0.5) * 18, c.t.anchor[3]];
        }
        loop.kick();
      };
      c.el.addEventListener('pointerup', end);
      c.el.addEventListener('pointercancel', end);
    }
  }

  function reorderWhileDragging(c, y) {
    const g = c.t.s;
    const list = order[g];
    if (!lastLayout || !list.includes(c.t.id)) return;
    const { s, m } = geo;
    const others = list.filter((id) => id !== c.t.id);
    const first = lastLayout.labelY[g] + (m.label * s) / 2 + (m.row * s) / 2;
    const step = (m.row + m.gap) * s;
    const idx = clamp(Math.round((y - first) / step), 0, others.length);
    const next = [...others.slice(0, idx), c.t.id, ...others.slice(idx)];
    if (next.join() !== list.join()) order[g] = next;
  }

  resetBtn.addEventListener('click', () => {
    const fresh = TASKS.filter((t) => !mobile || t.mobile !== false);
    for (const c of cards) {
      const orig = fresh.find((t) => t.id === c.t.id);
      c.t.s = orig.s;
      c.t.custom = null;
      c.el.dataset.s = orig.s;
      c.el.querySelector('.status').dataset.s = orig.s;
    }
    order = Object.fromEntries(GROUPS.map((g) => [g, fresh.filter((t) => t.s === g).map((t) => t.id)]));
    interacted = false;
    loop.kick();
  });

  field.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer = toField(e);
    loop.kick();
  });
  field.addEventListener('pointerleave', () => {
    pointer = null;
  });
  stage.addEventListener('pointerleave', () => {
    pointer = null;
  });

  // 首屏文案下方也能感应指针（文案层在卡片之上）
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer = toField(e);
    loop.kick();
  });

  window.addEventListener('scroll', () => loop.kick(), { passive: true });

  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const nowMobile = window.innerWidth < 760;
      if (nowMobile !== mobile) {
        mobile = nowMobile;
        build();
      }
      measure();
      cards.forEach((c) => c.sp.snap());
      loop.kick();
    }, 120);
  });

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) loop.kick();
  }).observe(track);

  if (reduced) {
    track.classList.add('is-static');
    // 减弱动效 + 小屏：只保留文案，不叠放面板
    if (mobile) {
      field.hidden = true;
      track.querySelector('.hero-hint').hidden = true;
      return;
    }
  }

  build();
  measure();
  // 首帧直接放到散落位置，避免从左上角飞入
  const now = performance.now();
  progress = reduced ? 1 : readProgress();
  for (const c of cards) {
    const a = scatterPos(c, now);
    const b = slots().out[c.t.id];
    const e = easeInOut(clamp((progress - c.start) / 0.3, 0, 1));
    c.sp.x = c.sp.tx = lerp(a.x, b.x, e);
    c.sp.y = c.sp.ty = lerp(a.y, b.y, e);
    c.sp.r = c.sp.tr = lerp(a.r, 0, e);
    c.scale = lerp(a.s, b.s, e);
  }
  // 入场：卡片从更远处轻轻飘进来
  if (!reduced && progress < 0.05) {
    cards.forEach((c, i) => {
      const dir = c.sp.x > geo.W * 0.5 ? 1 : -1;
      c.sp.x += dir * (80 + i * 14);
      c.sp.y += 60 + (i % 3) * 30;
      c.sp.r += dir * 10;
    });
  }
  loop.kick();
}
