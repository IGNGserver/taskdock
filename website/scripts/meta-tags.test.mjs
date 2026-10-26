import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readMetaTags } from './meta-tags.mjs';

const checker = fileURLToPath(new URL('./check-site.mjs', import.meta.url));
const plain =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="description" content="TaskDock task workspace">';
const formatted = `<meta charset="utf-8" />
<meta content="width=device-width, initial-scale=1" name="viewport" />
<meta
  content="TaskDock task workspace"
  name="description"
/>`;

function check(metadata) {
  const root = mkdtempSync(join(tmpdir(), 'taskdock-meta-check-'));
  try {
    writeFileSync(
      join(root, 'index.html'),
      `<!doctype html><html lang="zh-CN"><head><title>TaskDock</title>${metadata}</head><body><h1>TaskDock</h1></body></html>`,
    );
    return spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('metadata checks accept both compact and Prettier-formatted HTML', () => {
  for (const metadata of [plain, formatted]) {
    const result = check(metadata);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('meta attributes support legal quote styles, case, order and quoted >', () => {
  const tags = readMetaTags(
    `<META CHARSET='UTF-8' /><meta content="Task's > list" NAME='description'>`,
  );
  assert.equal(tags[0].get('charset'), 'UTF-8');
  assert.equal(tags[1].get('name'), 'description');
  assert.equal(tags[1].get('content'), "Task's > list");
  assert.equal(readMetaTags('<meta charset=utf-8>')[0].get('charset'), 'utf-8');
});

test('commented metadata is not accepted as an actual page declaration', () => {
  const result = check(`<!--${plain}-->`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /缺少 charset/);
  assert.match(result.stderr, /缺少 description/);
});

for (const [label, metadata] of [
  ['missing charset', plain.replace('<meta charset="utf-8">', '')],
  ['empty charset', plain.replace('charset="utf-8"', 'charset=""')],
  ['wrong charset', plain.replace('charset="utf-8"', 'charset="iso-8859-1"')],
  [
    'missing description',
    plain.replace('<meta name="description" content="TaskDock task workspace">', ''),
  ],
  ['empty description', plain.replace('content="TaskDock task workspace"', 'content=""')],
  [
    'whitespace-only description',
    plain.replace('content="TaskDock task workspace"', 'content="  \n  "'),
  ],
]) {
  test(`metadata checker still rejects ${label}`, () => {
    const result = check(metadata);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, label.includes('charset') ? /缺少 charset/ : /缺少 description/);
  });
}
