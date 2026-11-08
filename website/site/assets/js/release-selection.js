const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const CHANNEL_RANK = { alpha: 0, beta: 1, rc: 2 };

export function parseReleaseVersion(tag) {
  const match = typeof tag === 'string' ? VERSION.exec(tag) : null;
  if (!match) return null;
  return {
    version: tag.replace(/^v/, ''),
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    channel: match[4] || null,
    sequence: match[5] === undefined ? 0 : Number(match[5]),
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return right.parts[index] - left.parts[index];
  }
  if (left.channel !== right.channel) {
    if (!left.channel) return -1;
    if (!right.channel) return 1;
    return CHANNEL_RANK[right.channel] - CHANNEL_RANK[left.channel];
  }
  return right.sequence - left.sequence;
}

/** Select by SemVer, not API creation order; incomplete releases are not downloadable. */
export function selectLatestRelease(releases) {
  if (!Array.isArray(releases)) return null;
  return (
    releases
      .filter((release) => release && !release.draft)
      .map((release) => {
        const parsed = parseReleaseVersion(release.tag_name);
        if (
          !parsed ||
          typeof release.published_at !== 'string' ||
          Number.isNaN(Date.parse(release.published_at))
        )
          return null;
        const expectedName = `TaskDock-${parsed.version}-android.apk`;
        const apk = Array.isArray(release.assets)
          ? release.assets.find(
              (asset) =>
                asset?.name === expectedName && asset.state === 'uploaded' && asset.size > 0,
            )
          : null;
        if (!apk) return null;
        return {
          release,
          parsed,
          apk,
          prerelease: Boolean(release.prerelease || parsed.channel),
        };
      })
      .filter(Boolean)
      .sort(
        (left, right) =>
          compareVersions(left.parsed, right.parsed) ||
          Date.parse(right.release.published_at) - Date.parse(left.release.published_at),
      )[0] || null
  );
}
