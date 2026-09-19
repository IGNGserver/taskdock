/**
 * Material 3 Expressive spring tokens.
 *
 * M3E replaces the legacy "duration + easing" model with spring physics. CSS has
 * no spring primitive, so this script samples each spring into a `linear()`
 * easing function and emits the block that `packages/ui/src/tokens.css` embeds.
 *
 * Keeping the generator in the repository (instead of pasting numbers by hand)
 * is what makes the tokens auditable: `--check` fails when the committed block
 * drifts from the physics, so the values cannot be quietly hand-tuned.
 *
 * Spring specs are the documented M3E values from
 * `androidx.compose.material3.MotionScheme` (standard + expressive schemes,
 * spatial and effects families, fast/default/slow speeds). Damping ratio and
 * stiffness are the token inputs; we never invent constants per component.
 *
 * Usage:
 *   tsx scripts/motion-tokens.ts           # print the CSS custom property block
 *   tsx scripts/motion-tokens.ts --write   # regenerate the block inside tokens.css
 *   tsx scripts/motion-tokens.ts --check   # verify packages/ui/src/tokens.css matches
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokensPath = join(repoRoot, 'packages/ui/src/tokens.css');

interface SpringSpec {
  /** Damping ratio: 1.0 is critically damped, lower values overshoot. */
  damping: number;
  /** Spring stiffness (mass is normalised to 1). */
  stiffness: number;
}

interface MotionToken {
  name: string;
  scheme: 'standard' | 'expressive';
  family: 'spatial' | 'effects';
  speed: 'fast' | 'default' | 'slow';
  spec: SpringSpec;
}

/**
 * Spatial tokens are allowed to overshoot (they move position/size/shape).
 * Effects tokens are critically damped — colour and alpha must never bounce.
 */
const MOTION_TOKENS: readonly MotionToken[] = [
  // Standard scheme: high damping, minimal bounce. Default for dense productivity surfaces.
  {
    name: '--m3-spring-spatial-fast',
    scheme: 'standard',
    family: 'spatial',
    speed: 'fast',
    spec: { damping: 0.9, stiffness: 1400 },
  },
  {
    name: '--m3-spring-spatial',
    scheme: 'standard',
    family: 'spatial',
    speed: 'default',
    spec: { damping: 0.9, stiffness: 700 },
  },
  {
    name: '--m3-spring-spatial-slow',
    scheme: 'standard',
    family: 'spatial',
    speed: 'slow',
    spec: { damping: 0.9, stiffness: 300 },
  },
  {
    name: '--m3-spring-effects-fast',
    scheme: 'standard',
    family: 'effects',
    speed: 'fast',
    spec: { damping: 1, stiffness: 3800 },
  },
  {
    name: '--m3-spring-effects',
    scheme: 'standard',
    family: 'effects',
    speed: 'default',
    spec: { damping: 1, stiffness: 1600 },
  },
  {
    name: '--m3-spring-effects-slow',
    scheme: 'standard',
    family: 'effects',
    speed: 'slow',
    spec: { damping: 1, stiffness: 800 },
  },
  /*
   * Expressive scheme: damping 0.6 for spatial springs, which is a ~9.5%
   * overshoot — clearly visible, and the value the M3E expressive scheme is
   * specified with. Anything closer to critical damping (0.8) yields ~1.5%,
   * which reads as no bounce at all and makes a hero moment indistinguishable
   * from a routine transition.
   */
  {
    name: '--m3-spring-expressive-spatial-fast',
    scheme: 'expressive',
    family: 'spatial',
    speed: 'fast',
    spec: { damping: 0.6, stiffness: 800 },
  },
  {
    name: '--m3-spring-expressive-spatial',
    scheme: 'expressive',
    family: 'spatial',
    speed: 'default',
    spec: { damping: 0.6, stiffness: 380 },
  },
  {
    name: '--m3-spring-expressive-spatial-slow',
    scheme: 'expressive',
    family: 'spatial',
    speed: 'slow',
    spec: { damping: 0.6, stiffness: 200 },
  },
];

const SAMPLE_COUNT = 48;
const SETTLE_TOLERANCE = 0.001;

/** Closed-form damped-harmonic-oscillator displacement for a 0 -> 1 step. */
function displacement(spec: SpringSpec, t: number): number {
  const omega0 = Math.sqrt(spec.stiffness);
  if (spec.damping >= 1) {
    const envelope = Math.exp(-omega0 * t);
    return 1 - envelope * (1 + omega0 * t);
  }
  const omegaD = omega0 * Math.sqrt(1 - spec.damping * spec.damping);
  const envelope = Math.exp(-spec.damping * omega0 * t);
  return (
    1 -
    envelope * (Math.cos(omegaD * t) + ((spec.damping * omega0) / omegaD) * Math.sin(omegaD * t))
  );
}

/** First instant after which the spring stays within tolerance of its resting value. */
function settleSeconds(spec: SpringSpec): number {
  const step = 1 / 240;
  let settledAt = 0;
  for (let t = 0; t <= 8; t += step) {
    if (Math.abs(displacement(spec, t) - 1) <= SETTLE_TOLERANCE) {
      // Require the remainder of the window to stay inside the band as well.
      let holds = true;
      for (let probe = t; probe <= Math.min(t + 0.5, 8); probe += step) {
        if (Math.abs(displacement(spec, probe) - 1) > SETTLE_TOLERANCE) {
          holds = false;
          break;
        }
      }
      if (holds) {
        settledAt = t;
        break;
      }
    }
  }
  return settledAt === 0 ? 1 : settledAt;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatNumber(value: number): string {
  const rounded = round(value);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Emit a `linear()` easing. The final stop is pinned to exactly 1 so the
 * browser cannot leave a property fractionally off its resting value, and
 * percentages are monotonic so the interpolation stays well-defined even
 * while the spring overshoots (values above 1 are legal here).
 */
function linearEasing(spec: SpringSpec): { easing: string; durationMs: number } {
  const duration = settleSeconds(spec);
  const stops: string[] = [];
  for (let index = 0; index <= SAMPLE_COUNT; index += 1) {
    const progress = index / SAMPLE_COUNT;
    const t = progress * duration;
    const value = index === SAMPLE_COUNT ? 1 : displacement(spec, t);
    const percent = round((index / SAMPLE_COUNT) * 100, 2);
    stops.push(`${formatNumber(value)} ${formatNumber(percent)}%`);
  }
  return { easing: `linear(${stops.join(', ')})`, durationMs: Math.round(duration * 1000) };
}

export const MOTION_BLOCK_START = '  /* >>> motion-tokens: start (generated) */';
export const MOTION_BLOCK_END = '  /* <<< motion-tokens: end */';

function buildBlock(): string {
  const lines: string[] = [];
  lines.push(MOTION_BLOCK_START);
  lines.push('  /* M3E spring physics, sampled to CSS linear() easings. Do not hand-edit. */');
  for (const token of MOTION_TOKENS) {
    const { easing, durationMs } = linearEasing(token.spec);
    const label = `${token.scheme}/${token.family}/${token.speed}`;
    lines.push(
      `  /* ${label} — damping ${token.spec.damping}, stiffness ${token.spec.stiffness} */`,
    );
    lines.push(`  ${token.name}: ${easing};`);
    lines.push(`  ${token.name}-duration: ${durationMs}ms;`);
  }
  lines.push(MOTION_BLOCK_END);
  return lines.join('\n');
}

function replaceBlock(source: string, block: string): string {
  const start = source.indexOf(MOTION_BLOCK_START);
  const end = source.indexOf(MOTION_BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `packages/ui/src/tokens.css is missing the motion token markers.\nExpected:\n${MOTION_BLOCK_START}\n${MOTION_BLOCK_END}`,
    );
  }
  return `${source.slice(0, start)}${block}${source.slice(end + MOTION_BLOCK_END.length)}`;
}

function main(): number {
  const block = buildBlock();
  if (process.argv.includes('--write')) {
    const source = readFileSync(tokensPath, 'utf8');
    writeFileSync(tokensPath, replaceBlock(source, block));
    process.stdout.write(`motion tokens written (${MOTION_TOKENS.length} springs)\n`);
    return 0;
  }
  if (!process.argv.includes('--check')) {
    process.stdout.write(`${block}\n`);
    return 0;
  }

  const tokens = readFileSync(tokensPath, 'utf8');
  // Prettier re-wraps the long `linear()` values across lines and may insert a
  // space after `linear(`, so compare on a whitespace-free copy. Commas still
  // separate every stop, so the comparison stays exact.
  const compact = tokens.replace(/\s+/g, '');
  const missing = MOTION_TOKENS.filter((token) => !compact.includes(`${token.name}:`));
  if (missing.length > 0) {
    process.stderr.write(
      `motion tokens missing from packages/ui/src/tokens.css:\n${missing
        .map((token) => `  ${token.name}`)
        .join('\n')}\n\nRegenerate with:\n  tsx scripts/motion-tokens.ts --write\n`,
    );
    return 1;
  }

  const drifted = MOTION_TOKENS.filter((token) => {
    const { easing, durationMs } = linearEasing(token.spec);
    const quoted = (value: string) => value.replace(/\s+/g, '');
    return (
      !compact.includes(quoted(`${token.name}: ${easing};`)) ||
      !compact.includes(quoted(`${token.name}-duration: ${durationMs}ms;`))
    );
  });
  if (drifted.length > 0) {
    process.stderr.write(
      `motion tokens drifted from the spring physics in packages/ui/src/tokens.css:\n${drifted
        .map((token) => `  ${token.name}`)
        .join('\n')}\n\nRegenerate with:\n  tsx scripts/motion-tokens.ts --write\n`,
    );
    return 1;
  }

  process.stdout.write(`motion tokens current (${MOTION_TOKENS.length} springs)\n`);
  return 0;
}

process.exitCode = main();
