#!/usr/bin/env node
// 站点静态检查：本地与 CI 共用，零依赖（只用 Node 内置模块）。
// 检查页面元信息、站内链接与锚点、资源只来自本站、脚本语法与体积预算。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '..', 'site'));
const errors = [];
const fail = (file, msg) => errors.push(`${relative(root, file) || file}: ${msg}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

if (!existsSync(root)) {
  console.error('site/ 目录不存在');
  process.exit(1);
}

const files = walk(root);
const pages = files.filter((f) => extname(f) === '.html');
const ids = new Map();

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  ids.set(page, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  if (!/^<!doctype html>/i.test(html)) fail(page, '缺少 <!doctype html>');
  if (!/<html lang="zh-CN">/.test(html)) fail(page, '缺少 <html lang="zh-CN">');
  if (!/<meta charset="utf-8">/.test(html)) fail(page, '缺少 charset');
  if (!/<meta name="viewport"[^>]*width=device-width/.test(html)) fail(page, '缺少 viewport');
  if (!/<title>[^<]+<\/title>/.test(html)) fail(page, '缺少 <title>');
  if (!/<meta name="description" content="[^"]+">/.test(html)) fail(page, '缺少 description');
  if ((html.match(/<h1[\s>]/g) || []).length !== 1) fail(page, '每页应当恰好有一个 <h1>');

  // 外部脚本与样式：站点只加载自身资源
  for (const m of html.matchAll(/<(script|link)\b[^>]*\s(?:src|href)="(https?:)?\/\/[^"]*"/g)) {
    if (m[1] === 'script' || /rel="stylesheet"/.test(m[0])) fail(page, `引用了外部资源：${m[0]}`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html)) fail(page, '存在内联脚本（CSP 只允许站内脚本文件）');

  // 站内链接、资源与锚点
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|mailto:|data:)/.test(ref)) {
      if (/^http:\/\//.test(ref)) fail(page, `不安全的 http 链接：${ref}`);
      continue;
    }
    const [path, hash] = ref.split('#');
    let target = page;
    if (path) {
      const base = path.startsWith('/') ? join(root, path) : join(dirname(page), path);
      target = path.endsWith('/') || path === '.' || path === './' ? join(base, 'index.html') : base;
      if (!existsSync(target)) {
        fail(page, `链接目标不存在：${ref}`);
        continue;
      }
    }
    if (hash && extname(target) === '.html' && !ids.get(target)?.has(hash)) {
      fail(page, `锚点不存在：${ref}`);
    }
  }
}

// 脚本语法（ES module）
for (const js of files.filter((f) => extname(f) === '.js')) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(js) });
  if (r.status !== 0) fail(js, `语法错误\n${r.stderr.toString()}`);
}

// CSS 中引用的 url() 资源
for (const css of files.filter((f) => extname(f) === '.css')) {
  const text = readFileSync(css, 'utf8');
  for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    if (/^(data:|https?:|#)/.test(m[1])) continue;
    if (!existsSync(join(dirname(css), m[1]))) fail(css, `url() 目标不存在：${m[1]}`);
  }
  const open = (text.match(/\{/g) || []).length;
  const close = (text.match(/\}/g) || []).length;
  if (open !== close) fail(css, `花括号不配对（{ ${open} / } ${close}）`);
}

// 体积预算：整个站点不超过 1 MB
const total = files.reduce((n, f) => n + statSync(f).size, 0);
if (total > 1024 * 1024) fail(root, `站点体积 ${(total / 1024).toFixed(0)} KB 超过 1 MB 预算`);

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  console.error(`\n站点检查失败：${errors.length} 项`);
  process.exit(1);
}
console.log(`site check passed: ${pages.length} pages, ${files.length} files, ${(total / 1024).toFixed(0)} KB`);
