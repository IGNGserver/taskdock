// 极小的弹簧积分器：半隐式欧拉 + 固定子步长，帧率波动时保持稳定。

export const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/** 二维弹簧：位置 (x, y) 与角度 r 追随各自目标。 */
export class Spring2D {
  constructor(x = 0, y = 0, r = 0) {
    this.x = x;
    this.y = y;
    this.r = r;
    this.vx = 0;
    this.vy = 0;
    this.vr = 0;
    this.tx = x;
    this.ty = y;
    this.tr = r;
    this.k = 120;
    this.c = 16;
  }

  step(dt) {
    const { k, c } = this;
    const ax = k * (this.tx - this.x) - c * this.vx;
    const ay = k * (this.ty - this.y) - c * this.vy;
    const ar = k * 0.8 * (this.tr - this.r) - c * this.vr;
    this.vx += ax * dt;
    this.vy += ay * dt;
    this.vr += ar * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.r += this.vr * dt;
  }

  settled(eps = 0.05) {
    return (
      Math.abs(this.tx - this.x) < eps &&
      Math.abs(this.ty - this.y) < eps &&
      Math.abs(this.tr - this.r) < eps &&
      Math.abs(this.vx) < eps &&
      Math.abs(this.vy) < eps &&
      Math.abs(this.vr) < eps
    );
  }

  snap() {
    this.x = this.tx;
    this.y = this.ty;
    this.r = this.tr;
    this.vx = this.vy = this.vr = 0;
  }
}

/** 统一的动画循环：只在有东西在动时运行，空闲即停。 */
export function createLoop(tick) {
  let raf = 0;
  let last = 0;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const active = tick(dt, now);
    raf = active ? requestAnimationFrame(frame) : 0;
  };
  return {
    kick() {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/** 以固定子步长推进一组弹簧。 */
export function integrate(springs, dt, sub = 1 / 240) {
  let t = dt;
  while (t > 1e-6) {
    const h = Math.min(sub, t);
    for (const s of springs) s.step(h);
    t -= h;
  }
}

/** 用 Web Animations 播放一段弹簧感的位移（用于一次性的飞行动画）。 */
export function flyTo(el, from, to, { duration = 620, arc = 0 } = {}) {
  if (prefersReducedMotion()) return Promise.resolve();
  const frames = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const e = easeInOut(t);
    const x = lerp(from.x, to.x, e);
    const y = lerp(from.y, to.y, e) - Math.sin(Math.PI * t) * arc;
    const s = 1 + Math.sin(Math.PI * t) * 0.08;
    frames.push({ transform: `translate(${x}px, ${y}px) scale(${s})` });
  }
  const anim = el.animate(frames, { duration, easing: 'linear', fill: 'forwards' });
  // 标签页在后台时动画不会推进；用定时器兜底，演示状态不会卡住
  return Promise.race([anim.finished, new Promise((r) => setTimeout(r, duration + 250))]);
}
