// 下载页的部署步骤：随滚动点亮步骤编号，左侧轨道按进度填充。

export function initRail(rail) {
  if (!rail) return;
  const fill = rail.querySelector('[data-rail-fill]');
  const steps = [...rail.querySelectorAll('.rail-step')];
  let raf = 0;

  const update = () => {
    raf = 0;
    const r = rail.getBoundingClientRect();
    const mark = window.innerHeight * 0.55;
    const p = Math.min(1, Math.max(0, (mark - r.top) / r.height));
    fill.style.setProperty('--p', p.toFixed(4));
    for (const step of steps) {
      const num = step.querySelector('.num').getBoundingClientRect();
      step.classList.toggle('is-reached', num.top + num.height / 2 < mark);
    }
  };

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();
}
