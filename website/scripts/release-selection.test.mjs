import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReleaseVersion, selectLatestRelease } from '../site/assets/js/release-selection.js';

function release(
  tag,
  {
    draft = false,
    prerelease = tag.includes('-'),
    state = 'uploaded',
    size = 100,
    publishedAt = '2026-11-01T00:00:00Z',
    asset = true,
  } = {},
) {
  const version = tag.replace(/^v/, '');
  return {
    tag_name: tag,
    draft,
    prerelease,
    published_at: publishedAt,
    assets: asset ? [{ name: `TaskDock-${version}-android.apk`, state, size }] : [],
  };
}

test('release selection uses SemVer precedence rather than API list order', () => {
  const selected = selectLatestRelease([
    release('v2.0.0-rc.9'),
    release('v2.0.0'),
    release('v1.9.0', { publishedAt: '2026-11-08T00:00:00Z' }),
    release('v2.0.0-rc.10'),
  ]);
  assert.equal(selected.release.tag_name, 'v2.0.0');
  assert.equal(selected.prerelease, false);
});

test('prerelease numeric ordering and tag channel cannot be forged stable', () => {
  const selected = selectLatestRelease([
    release('v3.0.0-rc.2', { prerelease: false }),
    release('v3.0.0-rc.10'),
  ]);
  assert.equal(selected.release.tag_name, 'v3.0.0-rc.10');
  assert.equal(selected.prerelease, true);
});

test('draft, malformed, incomplete and non-uploaded releases are ignored', () => {
  assert.equal(selectLatestRelease([release('v9.0.0', { draft: true })]), null);
  assert.equal(selectLatestRelease([release('not-a-version')]), null);
  assert.equal(selectLatestRelease([release('v9.0.0', { asset: false })]), null);
  assert.equal(selectLatestRelease([release('v9.0.0', { state: 'open' })]), null);
  assert.equal(selectLatestRelease([release('v9.0.0', { size: 0 })]), null);
  assert.equal(parseReleaseVersion('v01.2.3'), null);
});
