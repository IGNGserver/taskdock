// 版本信息：页面里写着最后一次核对过的版本作为兜底，
// 加载后向 GitHub 公共 API 读取最新发布；失败时保持兜底内容，不影响页面。

const REPO = 'IGNGserver/taskdock';
const RELEASE_PREFIX = `https://github.com/${REPO}/releases/`;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Only assign URLs built for this repository's Releases; never trust an API URL directly. */
function setReleaseHref(el, url) {
  if (!url || !url.startsWith(RELEASE_PREFIX)) return;
  el.href = url;
}

const FALLBACK = {
  tag: 'v2.0.0-rc.37',
  prerelease: true,
  publishedAt: '2026-10-13T15:01:42Z',
  url: `https://github.com/${REPO}/releases/tag/v2.0.0-rc.37`,
  apk: `https://github.com/${REPO}/releases/download/v2.0.0-rc.37/TaskDock-2.0.0-rc.37-android.apk`,
  apkName: 'TaskDock-2.0.0-rc.37-android.apk',
};
const CACHE_KEY = 'taskdock-release-v1';
const CACHE_MS = 30 * 60 * 1000;

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return Date.now() - data.at < CACHE_MS ? data.release : null;
  } catch {
    return null;
  }
}

function writeCache(release) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }));
  } catch {
    /* 隐私模式下忽略 */
  }
}

async function fetchLatest() {
  const cached = readCache();
  if (cached) return cached;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const list = await res.json();
    const latest = Array.isArray(list) ? list.find((r) => !r.draft) : null;
    if (!latest || typeof latest.tag_name !== 'string') return null;
    if (!SAFE_SEGMENT.test(latest.tag_name)) return null;
    const apk = (latest.assets || []).find(
      (a) => /\.apk$/i.test(a.name) && SAFE_SEGMENT.test(a.name),
    );
    const apkName = apk ? apk.name : null;
    const release = {
      tag: latest.tag_name,
      prerelease: Boolean(latest.prerelease),
      publishedAt: latest.published_at,
      url: `${RELEASE_PREFIX}tag/${encodeURIComponent(latest.tag_name)}`,
      apk: apkName
        ? `${RELEASE_PREFIX}download/${encodeURIComponent(latest.tag_name)}/${encodeURIComponent(apkName)}`
        : null,
      apkName,
    };
    writeCache(release);
    return release;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const versionOf = (tag) => tag.replace(/^v/, '');

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

function apply(release) {
  const version = versionOf(release.tag);
  const channel = release.prerelease ? '预览版' : '正式版';

  document.querySelectorAll('[data-release-badge]').forEach((el) => {
    el.textContent = `${version} · ${channel}`;
  });
  document.querySelectorAll('[data-version-text]').forEach((el) => {
    el.textContent = version;
  });
  document.querySelectorAll('[data-release-tag]').forEach((el) => {
    el.textContent = release.tag;
  });
  document.querySelectorAll('[data-release-channel]').forEach((el) => {
    el.textContent = channel;
  });
  document.querySelectorAll('[data-release-date]').forEach((el) => {
    el.textContent = formatDate(release.publishedAt);
  });
  document.querySelectorAll('[data-release-link]').forEach((el) => {
    setReleaseHref(el, release.url);
  });
  document.querySelectorAll('[data-apk-link]').forEach((el) => {
    if (release.apk) {
      setReleaseHref(el, release.apk);
      el.removeAttribute('aria-disabled');
    } else {
      setReleaseHref(el, release.url);
    }
  });
  document.querySelectorAll('[data-apk-name]').forEach((el) => {
    el.textContent = release.apkName || '见 Release 附件';
  });
  document.querySelectorAll('[data-image-text]').forEach((el) => {
    el.textContent = `ghcr.io/igngserver/taskdock:${version}`;
  });
}

export async function loadRelease() {
  apply(FALLBACK);
  const latest = await fetchLatest();
  if (latest) apply(latest);
}
