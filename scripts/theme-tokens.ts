/**
 * Keeps every surface that duplicates the theme aligned with the canonical M3
 * Expressive tokens, including the TypeScript token constants that
 * `@devtodo/ui` re-exports for consumers that cannot read CSS.
 *
 * The palette used to live in six places (HTML meta, theme-preload, theme.ts,
 * the PWA manifest, the Electron main process and the Android resources) and
 * nothing tied them together. This script reads `packages/ui/src/tokens.css`,
 * derives the exact text each surface must contain, and either rewrites it
 * (`--write`) or asserts it matches (the default).
 *
 * Usage:
 *   tsx scripts/theme-tokens.ts           # verify all surfaces match tokens.css
 *   tsx scripts/theme-tokens.ts --write   # rewrite the derived values
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokensPath = join(repoRoot, 'packages/ui/src/tokens.css');

/** Roles every derived surface is generated from. */
const ROLES = {
  lightCanvas: '--m3-canvas',
  darkCanvas: '--m3-canvas',
} as const;

function parseScheme(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector ${selector} not found in tokens.css`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  const body = css.slice(open + 1, close);
  const values: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    values[match[1]!] = match[2]!.trim();
  }
  return values;
}

/** Resolve a token through `var()` chains to its literal value. */
function resolveLiteral(
  role: string,
  scheme: Record<string, string>,
  seen: Set<string> = new Set(),
): string {
  if (seen.has(role)) throw new Error(`cyclic token reference at ${role}`);
  seen.add(role);
  const value = scheme[role];
  if (value === undefined) throw new Error(`token ${role} is not defined`);
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (reference) return resolveLiteral(reference[1]!, scheme, seen);
  return value;
}

/** Resolve a colour role to a literal hex, following `var()` chains. */
function resolveHex(role: string, scheme: Record<string, string>): string {
  const resolved = resolveLiteral(role, scheme);
  if (/^#[0-9a-fA-F]{6}$/.test(resolved)) return resolved;
  throw new Error(`token ${role} does not resolve to a hex value (got "${resolved}")`);
}

/** Android resources use uppercase hex; the web surfaces use lowercase. */
function formatFor(path: string, value: string): string {
  return path.endsWith('.xml') ? value.toUpperCase() : value.toLowerCase();
}

interface Surface {
  path: string;
  description: string;
  /** Matches the complete text that must equal the expected value. */
  pattern: RegExp;
  /** Builds the expected text for this surface from the resolved palette. */
  expected: (palette: { light: string; dark: string }) => string;
}

function surfaces(): Surface[] {
  const list: Surface[] = [];
  const add = (
    path: string,
    description: string,
    pattern: RegExp,
    render: (palette: { light: string; dark: string }) => string,
  ) => {
    list.push({
      path,
      description,
      pattern,
      expected: (palette) =>
        render({
          light: formatFor(path, palette.light),
          dark: formatFor(path, palette.dark),
        }),
    });
  };

  add(
    'apps/web/index.html',
    'HTML theme-color meta',
    /(<meta name="theme-color" content=")(#[0-9a-fA-F]{6})(")/,
    ({ light }) => `<meta name="theme-color" content="${light}"`,
  );

  add(
    'apps/web/public/theme-preload.js',
    'pre-React theme script',
    /theme === 'dark' \? '#[0-9a-fA-F]{6}' : '#[0-9a-fA-F]{6}'/,
    ({ light, dark }) => `theme === 'dark' ? '${dark}' : '${light}'`,
  );

  add(
    'apps/web/src/theme.ts',
    'runtime theme controller',
    /const themeColor = theme === 'dark' \? '(#[0-9a-fA-F]{6})' : '(#[0-9a-fA-F]{6})';/,
    ({ light, dark }) => `const themeColor = theme === 'dark' ? '${dark}' : '${light}';`,
  );

  add(
    'apps/web/vite.config.ts',
    'PWA manifest theme colour',
    /(theme_color: ')(#[0-9a-fA-F]{6})(')/,
    ({ light }) => `theme_color: '${light}'`,
  );

  add(
    'apps/web/vite.config.ts',
    'PWA manifest background colour',
    /(background_color: ')(#[0-9a-fA-F]{6})(')/,
    ({ light }) => `background_color: '${light}'`,
  );

  add(
    'apps/desktop/src/main.ts',
    'Electron window background',
    /return theme === 'dark' \? '#[0-9a-fA-F]{6}' : '#[0-9a-fA-F]{6}';/,
    ({ light, dark }) => `return theme === 'dark' ? '${dark}' : '${light}';`,
  );

  add(
    'apps/mobile/android/app/src/main/res/values/colors.xml',
    'Android light background',
    /(<color name="taskdock_background">)(#[0-9a-fA-F]{6})(<\/color>)/,
    ({ light }) => `<color name="taskdock_background">${light}</color>`,
  );

  add(
    'apps/mobile/android/app/src/main/res/values-night/colors.xml',
    'Android dark background',
    /(<color name="taskdock_background">)(#[0-9a-fA-F]{6})(<\/color>)/,
    ({ dark }) => `<color name="taskdock_background">${dark}</color>`,
  );

  return list;
}

/** Roles mirrored into the TypeScript constant object (colours and shapes). */
const TS_ROLES: ReadonlyArray<{ key: string; role: string }> = [
  { key: 'primary', role: '--m3-primary' },
  { key: 'onPrimary', role: '--m3-on-primary' },
  { key: 'primaryContainer', role: '--m3-primary-container' },
  { key: 'onPrimaryContainer', role: '--m3-on-primary-container' },
  { key: 'secondaryContainer', role: '--m3-secondary-container' },
  { key: 'tertiaryContainer', role: '--m3-tertiary-container' },
  { key: 'surface', role: '--m3-surface' },
  { key: 'surfaceContainer', role: '--m3-surface-container' },
  { key: 'surfaceContainerLowest', role: '--m3-surface-container-lowest' },
  { key: 'canvas', role: '--m3-canvas' },
  { key: 'onSurface', role: '--m3-on-surface' },
  { key: 'onSurfaceVariant', role: '--m3-on-surface-variant' },
  { key: 'outline', role: '--m3-outline' },
  { key: 'outlineVariant', role: '--m3-outline-variant' },
  { key: 'radius', role: '--m3-shape-lg' },
  { key: 'radiusSmall', role: '--m3-shape-md' },
];

const TS_TOKENS_PATH = 'packages/ui/src/index.ts';

/**
 * `@devtodo/ui` exports a typed mirror of the tokens for consumers that cannot
 * read a CSS custom property. It is generated so the constants cannot drift
 * from the stylesheet they describe.
 */
function renderTokenModule(light: Record<string, string>): string {
  // Colours and shapes both resolve to literal text here; only the markup
  // surfaces require a hex value.
  const entries = TS_ROLES.map(
    ({ key, role }) => `  ${key}: '${resolveLiteral(role, light)}',`,
  ).join('\n');
  return `/*
 * Generated by scripts/theme-tokens.ts — do not hand-edit.
 * The canonical values live in packages/ui/src/tokens.css.
 */

export const designTokens = {
${entries}
} as const;

export type DesignTokenName = keyof typeof designTokens;
`;
}

function main(): number {
  const write = process.argv.includes('--write');
  const css = readFileSync(tokensPath, 'utf8');
  const lightScheme = parseScheme(css, ':root {');
  const palette = {
    light: resolveHex(ROLES.lightCanvas, lightScheme),
    dark: resolveHex(ROLES.darkCanvas, parseScheme(css, "[data-theme='dark'] {")),
  };

  const pending = new Map<string, string>();
  const failures: string[] = [];

  for (const surface of surfaces()) {
    const absolute = join(repoRoot, surface.path);
    const source = pending.get(absolute) ?? readFileSync(absolute, 'utf8');
    const match = surface.pattern.exec(source);
    if (!match) {
      failures.push(`${surface.path}: could not locate ${surface.description}`);
      continue;
    }
    const wanted = surface.expected(palette);
    if (match[0] === wanted) continue;
    if (write) {
      pending.set(absolute, source.replace(match[0], wanted));
      continue;
    }
    failures.push(
      `${surface.path}: ${surface.description}\n      found:    ${match[0]}\n      expected: ${wanted}`,
    );
  }

  // The TypeScript mirror is checked and written alongside the markup surfaces.
  const tsAbsolute = join(repoRoot, TS_TOKENS_PATH);
  const expectedTs = renderTokenModule(lightScheme);
  const currentTs = readFileSync(tsAbsolute, 'utf8');

  if (write) {
    for (const [absolute, source] of pending) writeFileSync(absolute, source);
    if (currentTs !== expectedTs) writeFileSync(tsAbsolute, expectedTs);
    process.stdout.write(
      `theme tokens written to ${pending.size + (currentTs === expectedTs ? 0 : 1)} file(s)\n`,
    );
    return 0;
  }

  if (currentTs !== expectedTs) {
    failures.push(`${TS_TOKENS_PATH}: token constants drifted from tokens.css`);
  }

  if (failures.length > 0) {
    process.stderr.write(
      `theme colours drifted from packages/ui/src/tokens.css:\n${failures
        .map((failure) => `  ${failure}`)
        .join('\n')}\n\nRegenerate with:\n  tsx scripts/theme-tokens.ts --write\n`,
    );
    return 1;
  }

  process.stdout.write('theme tokens current across all derived surfaces\n');
  return 0;
}

process.exitCode = main();
