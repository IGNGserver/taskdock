import { execFileSync } from 'node:child_process';

// Public GETs only: never load credentials or print response bodies/cookies.
const origins = process.argv.slice(2).map((value) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Expected an HTTP(S) origin without credentials');
  return url.origin;
});
if (!origins.length) throw new Error('Usage: tsx scripts/loading-baseline.ts <origin> [origin]');

for (const origin of origins) {
  const html = execFileSync('curl', ['-fsS', '--max-time', '30', '--compressed', `${origin}/`], {
    encoding: 'utf8',
  });
  const assets = [...html.matchAll(/(?:src|href)="(\/(?:assets\/[^"?#]+|theme-preload\.js))"/g)]
    .map((match) => match[1]!)
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .slice(0, 12);
  for (const path of ['/', '/version', ...assets]) {
    for (let sample = 0; sample < 3; sample++) {
      const output = execFileSync(
        'curl',
        [
          '-sS',
          '--max-time',
          '30',
          '--compressed',
          '-o',
          '/dev/null',
          '-D',
          '-',
          '-w',
          '\nMETRICS:%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download}',
          `${origin}${path}`,
        ],
        { encoding: 'utf8' },
      );
      const metrics = output.split('METRICS:')[1]!.trim().split(/\s+/).map(Number);
      const headers = Object.fromEntries(
        output.split(/\r?\n/).flatMap((line) => {
          const match =
            /^(cache-control|content-encoding|cf-cache-status|server-timing|age):\s*(.*)$/i.exec(
              line,
            );
          return match ? [[match[1]!.toLowerCase(), match[2]]] : [];
        }),
      );
      console.log(
        JSON.stringify({
          origin,
          path,
          sample,
          status: metrics[0],
          dnsSeconds: metrics[1],
          connectSeconds: metrics[2],
          tlsSeconds: metrics[3],
          ttfbSeconds: metrics[4],
          totalSeconds: metrics[5],
          transferBytes: metrics[6],
          headers,
        }),
      );
      if (metrics[0]! >= 400) process.exitCode = 1;
    }
  }
}
