/**
 * Enforce the M3 Expressive page boundary.
 *
 * Business pages compose the shared M3E primitives and are allowed to own only
 * information architecture and content layout. Native interactive elements,
 * hand-built activation semantics and M3E-internal styling belong exclusively
 * to apps/web/src/components/m3e.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';

const repoRoot = resolve(import.meta.dirname, '..');
const sourceRoot = join(repoRoot, 'apps', 'web', 'src');
const m3eRoot = join(sourceRoot, 'components', 'm3e');
const forbiddenIntrinsicTags = new Set([
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'details',
  'summary',
]);
const forbiddenRouterTags = new Set(['Link', 'NavLink']);
const businessStyleFiles = [
  join(sourceRoot, 'styles', 'base.css'),
  join(sourceRoot, 'styles', 'tasks.css'),
  join(sourceRoot, 'styles', 'pages.css'),
  join(sourceRoot, 'styles', 'motion.css'),
  join(sourceRoot, 'styles', 'responsive.css'),
];
const componentStyleFiles = readdirSync(m3eRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
  .map((entry) => join(m3eRoot, entry.name));
const nativeSelector =
  /(^|[\s>+~,(])(?:a|button|input|textarea|select|details|summary)(?=$|[\s>+~,.#[:])/i;
const m3eClassToken = /\.m3e-[A-Za-z0-9_-]+/g;
const activationKeys = new Set(['Enter', ' ', 'Spacebar']);

type Finding = {
  file: string;
  line: number;
  column: number;
  reason: string;
};

function collectTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTsxFiles(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): Pick<Finding, 'line' | 'column'> {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function isForbiddenJsxTag(node: ts.JsxOpeningLikeElement): string | null {
  if (!ts.isIdentifier(node.tagName)) return null;
  if (forbiddenIntrinsicTags.has(node.tagName.text) || forbiddenRouterTags.has(node.tagName.text)) {
    return node.tagName.text;
  }
  return null;
}

function isIntrinsicElement(node: ts.JsxOpeningLikeElement): boolean {
  return ts.isIdentifier(node.tagName) && /^[a-z]/.test(node.tagName.text);
}

function jsxAttribute(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === name,
  );
}

function stringAttributeValue(attribute: ts.JsxAttribute | undefined): string | undefined {
  if (!attribute?.initializer || !ts.isStringLiteral(attribute.initializer)) return undefined;
  return attribute.initializer.text;
}

function isWindowConfirmCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression) && node.expression.text === 'confirm') return true;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  return (
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'window' &&
    node.expression.name.text === 'confirm'
  );
}

function isKeyboardActivationComparison(node: ts.BinaryExpression): boolean {
  if (
    node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken &&
    node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return false;
  }

  const isKeyAccess = (candidate: ts.Expression) =>
    ts.isPropertyAccessExpression(candidate) && candidate.name.text === 'key';
  const isActivationKey = (candidate: ts.Expression) =>
    ts.isStringLiteral(candidate) && activationKeys.has(candidate.text);

  return (
    (isKeyAccess(node.left) && isActivationKey(node.right)) ||
    (isActivationKey(node.left) && isKeyAccess(node.right))
  );
}

function scanTsxFile(file: string): Finding[] {
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings: Finding[] = [];

  for (const diagnostic of (
    sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics) {
    const start = diagnostic.start ?? 0;
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    findings.push({
      file: relative(repoRoot, file),
      line: position.line + 1,
      column: position.character + 1,
      reason: `无法解析 TSX：${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    });
  }

  const report = (node: ts.Node, reason: string) => {
    const location = locationOf(sourceFile, node);
    findings.push({ file: relative(repoRoot, file), ...location, reason });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const forbiddenTag = isForbiddenJsxTag(node);
      if (forbiddenTag) {
        const routeReason = forbiddenRouterTags.has(forbiddenTag)
          ? `业务页面不得直接渲染 <${forbiddenTag}>；请使用 M3E 的 RouterLinkAdapter、NavigationCard 或导航组件。`
          : `业务页面不得直接渲染 <${forbiddenTag}>；请使用 apps/web/src/components/m3e 中的 M3E 组件。`;
        report(node.tagName, routeReason);
      }

      const style = jsxAttribute(node, 'style');
      if (style) {
        report(
          style.name,
          '业务页面不得使用 JSX inline style；请将组合布局样式放入页面 CSS，控件状态样式放入 M3E 组件。',
        );
      }

      if (isIntrinsicElement(node)) {
        const onClick = jsxAttribute(node, 'onClick');
        if (onClick) {
          report(
            onClick.name,
            '原生 DOM 元素不得自行承载 onClick；请使用一个具有语义的 M3E 交互组件。',
          );
        }

        const tabIndex = jsxAttribute(node, 'tabIndex');
        if (tabIndex) {
          report(
            tabIndex.name,
            '业务页面不得在原生 DOM 元素上手写 tabIndex；焦点模型应由 M3E 组件管理。',
          );
        }

        const role = jsxAttribute(node, 'role');
        if (stringAttributeValue(role) === 'button') {
          report(
            role!.name,
            '业务页面不得用 role="button" 模拟控件；请使用一个 M3E 按钮或操作组件。',
          );
        }
      }
    }

    if (ts.isCallExpression(node) && isWindowConfirmCall(node)) {
      report(node.expression, '业务页面不得调用浏览器 confirm；请使用 M3E ConfirmDialog。');
    }

    if (ts.isBinaryExpression(node) && isKeyboardActivationComparison(node)) {
      report(
        node,
        '业务页面不得手写 Enter/Space 激活逻辑；请使用具有原生键盘语义的 M3E 交互组件。',
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

/**
 * Remove comments and quoted strings while preserving all indices/newlines.
 * It is deliberately small because this gate only needs selector preludes;
 * adding a full CSS dependency would make the safety boundary less portable.
 */
function maskCssNonCode(source: string): string {
  const output = source.split('');
  let index = 0;
  while (index < source.length) {
    if (source[index] === '/' && source[index + 1] === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') output[index] = ' ';
        index += 1;
      }
      if (index < source.length) {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 2;
      }
      continue;
    }

    if (source[index] === '"' || source[index] === "'") {
      const quote = source[index];
      output[index] = ' ';
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          if (source[index] !== '\n') output[index] = ' ';
          index += 1;
          if (index < source.length && source[index] !== '\n') output[index] = ' ';
          index += 1;
          continue;
        }
        const isClosingQuote = source[index] === quote;
        if (source[index] !== '\n') output[index] = ' ';
        index += 1;
        if (isClosingQuote) break;
      }
      continue;
    }

    index += 1;
  }
  return output.join('');
}

function isM3EInternalSelector(selector: string): boolean {
  return selector.split(',').some((part) => {
    const normalized = part.trim();
    if (!normalized) return false;
    // Slot classes and descendant selectors belong to the component stylesheet.
    if (/\.m3e-[A-Za-z0-9_-]*__/.test(normalized)) return true;
    if (/\.m3e-[A-Za-z0-9_-]+\s+[.#[:*A-Za-z]/.test(normalized)) return true;
    if (/\.m3e-[A-Za-z0-9_-]+\s*[>+~]/.test(normalized)) return true;
    return false;
  });
}

function componentCssClasses(): Set<string> {
  const classes = new Set<string>();
  for (const file of componentStyleFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(m3eClassToken)) classes.add(match[0].slice(1));
  }
  return classes;
}

function scanStaticM3EClasses(file: string, knownClasses: Set<string>): Finding[] {
  const source = readFileSync(file, 'utf8');
  const findings: Finding[] = [];
  const classNamePattern = /className\s*=\s*"([^"]*m3e-[^"]*)"/g;
  for (const match of source.matchAll(classNamePattern)) {
    const value = match[1] ?? '';
    const offset = match.index ?? 0;
    for (const token of value.split(/\s+/).filter(Boolean)) {
      if (!/^m3e-[A-Za-z0-9_-]+$/.test(token)) continue;
      if (knownClasses.has(token)) continue;
      const position = cssLocation(source, offset);
      findings.push({
        file: relative(repoRoot, file),
        ...position,
        reason: `业务页面使用了未声明的 M3E class ".${token}"；请在对应组件样式中定义 modifier 或 slot。`,
      });
    }
  }
  return findings;
}

function cssLocation(source: string, offset: number): Pick<Finding, 'line' | 'column'> {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const previousNewline = before.lastIndexOf('\n');
  return { line, column: offset - previousNewline };
}

function scanCssFile(file: string): Finding[] {
  const source = readFileSync(file, 'utf8');
  const masked = maskCssNonCode(source);
  const findings: Finding[] = [];
  let preludeStart = 0;

  const report = (offset: number, reason: string) => {
    const location = cssLocation(source, offset);
    findings.push({ file: relative(repoRoot, file), ...location, reason });
  };

  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === '{') {
      const prelude = masked.slice(preludeStart, index);
      const selector = prelude.trim();
      const selectorOffset = preludeStart + prelude.search(/\S/);
      if (selector && !selector.startsWith('@') && selector !== 'from' && selector !== 'to') {
        if (nativeSelector.test(selector)) {
          report(
            selectorOffset,
            '业务 CSS 不得重绘原生交互控件；请把该规则迁到 apps/web/src/components/m3e 的组件样式。',
          );
        }
        if (isM3EInternalSelector(selector)) {
          report(
            selectorOffset,
            '业务 CSS 不得选择或重绘 .m3e-* 内部节点；请把该规则迁到对应 M3E 组件样式。',
          );
        }
      }
      preludeStart = index + 1;
    } else if (character === '}') {
      preludeStart = index + 1;
    }
  }

  return findings;
}

const knownM3EClasses = componentCssClasses();

const findings = [
  ...collectTsxFiles(sourceRoot)
    .filter((file) => !file.startsWith(`${m3eRoot}/`))
    .sort()
    .flatMap(scanTsxFile),
  ...businessStyleFiles.flatMap(scanCssFile),
  ...collectTsxFiles(sourceRoot)
    .filter((file) => !file.startsWith(`${m3eRoot}/`))
    .flatMap((file) => scanStaticM3EClasses(file, knownM3EClasses)),
].sort((left, right) =>
  left.file === right.file
    ? left.line === right.line
      ? left.column - right.column
      : left.line - right.line
    : left.file.localeCompare(right.file),
);

if (findings.length) {
  console.error('FAIL: M3 Expressive web guard found page-level boundary violations.');
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}:${finding.column} — ${finding.reason}`);
  }
  process.exitCode = 1;
} else {
  console.log('PASS: M3 Expressive web guard found no page-level UI boundary violations.');
}
