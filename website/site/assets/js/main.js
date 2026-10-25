// 全站入口：顶栏、滚动入场、复制按钮、版本信息，并按页面按需加载交互模块。

import { loadRelease } from './release.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

function initHeader() {
  const header = $('[data-header]');
  if (!header) return;
  const toggle = $('[data-menu-toggle]', header);
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const setOpen = (open) => {
    header.classList.toggle('is-open', open);
    toggle?.setAttribute('aria-expanded', String(open));
    toggle?.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  };
  toggle?.addEventListener('click', () => setOpen(!header.classList.contains('is-open')));
  $$('.site-nav a', header).forEach((a) => a.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  // 首页内锚点：滚动到当前章节时点亮导航
  const links = $$('.site-nav a[href^="#"]', header);
  if (links.length) {
    const map = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const link = map.get(entry.target.id);
          if (!link) continue;
          if (entry.isIntersecting) {
            links.forEach((l) => l.removeAttribute('aria-current'));
            link.setAttribute('aria-current', 'true');
          }
        }
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    map.forEach((_, id) => {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    });
  }
}

function initReveal() {
  const els = $$('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
  );
  els.forEach((el) => io.observe(el));

  const finale = $('[data-finale]');
  if (finale) {
    const fio = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          finale.classList.add('is-in');
          fio.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    fio.observe(finale);
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function flashCopied(btn, ok) {
  const label = btn.querySelector('span');
  const prev = label ? label.textContent : '';
  btn.classList.toggle('is-done', ok);
  if (label) label.textContent = ok ? '已复制' : '复制失败';
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.classList.remove('is-done');
    if (label) label.textContent = prev || '复制';
  }, 1600);
}

/** 终端里的命令：只复制 `$ ` 开头的行，去掉提示符与注释。 */
function commandsOf(pre) {
  return pre.innerText
    .split('\n')
    .filter((line) => line.trim().startsWith('$ '))
    .map((line) => line.trim().slice(2))
    .join('\n');
}

function initTerminals() {
  $$('[data-term]').forEach((term) => {
    const tabs = $$('[role="tab"]', term);
    const select = (tab, focus = false) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        select(next, true);
      });
    });
    const copy = $('[data-copy-term]', term);
    copy?.addEventListener('click', async () => {
      const pre = $$('pre', term).find((p) => !p.hidden);
      if (pre) flashCopied(copy, await copyText(commandsOf(pre)));
    });
  });

  $$('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.dataset.copy);
      const text = target ? target.innerText.trim() : btn.dataset.copyText || '';
      flashCopied(btn, await copyText(text));
    });
  });
}

function initYear() {
  $$('[data-year]').forEach((el) => {
    el.textContent = String(new Date().getFullYear());
  });
}

async function boot() {
  initHeader();
  initReveal();
  initTerminals();
  initYear();
  loadRelease();

  const page = document.body.dataset.page;
  if (page === 'home') {
    const [{ initHero }, { initDimensions }, { initTimeline }, { initSync }] = await Promise.all([
      import('./hero-field.js'),
      import('./dimensions.js'),
      import('./timeline.js'),
      import('./sync-demo.js'),
    ]);
    initHero($('[data-hero]'));
    initDimensions($('[data-lens]'), $('[data-model-tabs]'));
    initTimeline($('[data-timeline]'));
    initSync($('[data-sync]'));
  } else if (page === 'download') {
    const { initRail } = await import('./rail.js');
    initRail($('[data-rail]'));
  } else if (page === 'lost') {
    const { initLost } = await import('./lost.js');
    initLost($('[data-lost]'));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
