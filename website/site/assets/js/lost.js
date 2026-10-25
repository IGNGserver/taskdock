// 404：一张走丢的卡片，拖回虚线框就会被磁吸归位。

import { Spring2D, createLoop, integrate, prefersReducedMotion } from './spring.js';

export function initLost(root) {
  const slot = root?.querySelector('[data-slot]');
  const card = root?.querySelector('[data-card]');
  if (!slot || !card) return;
  const sp = new Spring2D(90, -40, -14);
  sp.k = 60;
  sp.c = 7;
  sp.tx = 70;
  sp.ty = -30;
  sp.tr = -10;
  let docked = false;
  let drag = null;
  const reduced = prefersReducedMotion();

  const loop = createLoop((dt, now) => {
    if (!docked && !drag) {
      sp.tx = 70 + Math.sin(now / 900) * 8;
      sp.ty = -30 + Math.cos(now / 1100) * 6;
      sp.tr = -10 + Math.sin(now / 1300) * 2;
    }
    if (reduced) sp.snap();
    else integrate([sp], dt);
    card.style.transform = `translate(${sp.x}px, ${sp.y}px) rotate(${sp.r}deg)`;
    return Boolean(drag) || !docked || !sp.settled(0.05);
  });

  card.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, sx: e.clientX - sp.x, sy: e.clientY - sp.y };
    card.setPointerCapture(e.pointerId);
    card.style.cursor = 'grabbing';
    docked = false;
    sp.k = 500;
    sp.c = 40;
    loop.kick();
  });
  card.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    sp.tx = e.clientX - drag.sx;
    sp.ty = e.clientY - drag.sy;
    sp.tr = 0;
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    card.style.cursor = '';
    const near = Math.hypot(sp.x, sp.y) < 90;
    if (near) {
      docked = true;
      sp.k = 260;
      sp.c = 18;
      sp.tx = 0;
      sp.ty = 0;
      sp.tr = 0;
      card.querySelector('.status').dataset.s = 'done';
      card.dataset.s = 'done';
      card.classList.add('just-docked');
    } else {
      sp.k = 60;
      sp.c = 7;
    }
    loop.kick();
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
  loop.kick();
}
