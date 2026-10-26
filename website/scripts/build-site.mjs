import { cp, readFile, rm, writeFile } from 'node:fs/promises';

const REPO = 'IGNGserver/taskdock';
const siteRoot = new URL('../site/', import.meta.url);
const outRoot = new URL('../dist/', import.meta.url);
const OLD_VERSION = '2.0.0-rc.37';
const OLD_DATE_ISO = '2026-10-13T15:01:42Z';
const OLD_DATE_ZH = '2026年10月13日';

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'taskdock-website-build',
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
  headers,
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`GitHub API ${response.status}`);
const releases = await response.json();
const latest = releases.find((release) => !release.draft);
if (!latest || typeof latest.tag_name !== 'string') throw new Error('No published release found');

const tag = latest.tag_name;
const version = tag.replace(/^v/, '');
const publishedAt = latest.published_at;
const isoDate = publishedAt.slice(0, 10);
const [year, month, day] = isoDate.split('-');
const zhDate = `${year}年${Number(month)}月${Number(day)}日`;
const channel = latest.prerelease ? '预览版' : '正式版';
const apk = (latest.assets || []).find((asset) => /\.apk$/i.test(asset.name));
const expectedApk = `TaskDock-${version}-android.apk`;
if (!apk || apk.name !== expectedApk)
  throw new Error(`Expected APK ${expectedApk}, got ${apk?.name || 'none'}`);

await rm(outRoot, { recursive: true, force: true });
await cp(siteRoot, outRoot, { recursive: true });

const replaceAll = (text, from, to, label) => {
  if (!text.includes(from)) throw new Error(`Expected ${label} (${from}) not found`);
  return text.split(from).join(to);
};

const replaceOptional = (text, from, to) => text.split(from).join(to);

for (const file of ['index.html', 'download.html', 'assets/js/release.js']) {
  let text = await readFile(new URL(file, outRoot), 'utf8');
  text = replaceAll(text, OLD_VERSION, version, 'fallback version');
  if (file === 'download.html') {
    text = replaceAll(text, OLD_DATE_ZH, zhDate, 'fallback Chinese date');
    text = replaceAll(
      text,
      '<span data-release-channel>预览版</span>',
      `<span data-release-channel>${channel}</span>`,
      'fallback channel',
    );
  }
  if (file === 'index.html') {
    text = replaceOptional(text, '2.0 预览版', `2.0 ${channel}`);
  }
  if (file === 'assets/js/release.js') {
    text = replaceAll(text, OLD_DATE_ISO, publishedAt, 'fallback ISO date');
    text = replaceAll(
      text,
      'prerelease: true,',
      `prerelease: ${latest.prerelease},`,
      'fallback prerelease flag',
    );
  }
  await writeFile(new URL(file, outRoot), text);
}

const built = await readFile(new URL('download.html', outRoot), 'utf8');
if (built.includes(OLD_VERSION)) throw new Error('Old version still present after build');
if (!built.includes(tag)) throw new Error(`Built page is missing ${tag}`);
console.log(`Built site for ${tag} (${publishedAt}, ${channel}), APK ${apk.name}`);
