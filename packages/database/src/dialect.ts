/**
 * Dialect-sensitive parts of the SQL that both stores share.
 *
 * Source SQL keeps two PostgreSQL habits that are translated per engine:
 *
 * - `$1`-style placeholders. node-postgres understands them directly; MySQL
 *   uses `?`, so the MySQL path renumbers the parameters in appearance order.
 *   This keeps one copy of every statement even where a parameter repeats.
 * - backtick quoting for identifiers that MySQL reserves (`rank`, `cursor`).
 *   PostgreSQL sees the equivalent `"rank"`.
 *
 * MySQL also receives implicit casts: `$1::date` becomes `?`. The cast exists
 * to satisfy PostgreSQL's type inference, and MySQL rejects the syntax.
 *
 * MySQL reserves `rank` and `cursor`, which the schema uses as column names.
 * Bare occurrences in SQL are quoted automatically, so every statement can be
 * written once. PostgreSQL leaves them bare because it does not reserve them.
 */

export type DatabaseDialectName = 'postgres' | 'mysql';

export interface PreparedQuery {
  text: string;
  values: unknown[];
}

/** Types that may follow `::` in the shared SQL. */
const CAST_TYPE =
  /^(?:double\s+precision|timestamp(?:tz)?|timestamptz|bigint|integer|int|smallint|text|varchar|date|jsonb|json|numeric|decimal|boolean|bool|real|float8|float4|char|bytea|uuid)\b/i;

export function prepareQuery(
  dialect: DatabaseDialectName,
  sql: string,
  values: readonly unknown[] = [],
): PreparedQuery {
  return dialect === 'mysql' ? prepareMysql(sql, values) : preparePostgres(sql, values);
}

function preparePostgres(sql: string, values: readonly unknown[]): PreparedQuery {
  let text = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'") {
      const end = skipSingleQuoted(sql, index);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '"') {
      const end = skipDoubleQuoted(sql, index);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '`') {
      const end = skipBacktick(sql, index);
      text += toDoubleQuoted(sql.slice(index + 1, end - 1));
      index = end;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = lineCommentEnd(sql, index);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = blockCommentEnd(sql, index);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '$' && sql[index + 1] === '$') {
      const end = skipDollarQuoted(sql, index);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    text += char;
    index += 1;
  }
  return { text, values: [...values] };
}

function prepareMysql(sql: string, values: readonly unknown[]): PreparedQuery {
  let text = '';
  const params: unknown[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'") {
      const end = skipSingleQuoted(sql, index);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '"' || char === '`') {
      const end = char === '"' ? skipDoubleQuoted(sql, index) : skipBacktick(sql, index);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = lineCommentEnd(sql, index);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = blockCommentEnd(sql, index);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '$') {
      const placeholder = /^\$(\d+)/.exec(sql.slice(index));
      if (placeholder) {
        const position = Number(placeholder[1]);
        if (position < 1 || position > values.length)
          throw new Error(`SQL placeholder $${position} has no matching parameter`);
        text += '?';
        params.push(values[position - 1]);
        index += placeholder[0].length;
        index = skipCast(sql, index);
        continue;
      }
    }
    if (/[A-Za-z_]/.test(char) && !/[A-Za-z0-9_]/.test(sql[index - 1] ?? '')) {
      const reserved = /^(rank|cursor)\b/i.exec(sql.slice(index));
      if (reserved && sql[index + reserved[0].length] !== '(') {
        text += '`' + reserved[0] + '`';
        index += reserved[0].length;
        continue;
      }
    }
    if (char === 'I' || char === 'i') {
      // PostgreSQL's null-safe comparison; MySQL has the <=> operator.
      const notDistinct = /^is\s+not\s+distinct\s+from\b/i.exec(sql.slice(index));
      if (notDistinct) {
        text += '<=>';
        index += notDistinct[0].length;
        continue;
      }
    }
    if ((char === 'I' || char === 'i') && /^ilike\b/i.test(sql.slice(index))) {
      // MySQL's default collation is case-insensitive, so LIKE matches what
      // PostgreSQL's ILIKE matches; the wildcard escaping is identical.
      text += 'LIKE';
      index += 5;
      continue;
    }
    if (char === ':' && sql[index + 1] === ':') {
      const afterCast = skipCast(sql, index);
      if (afterCast > index) {
        index = afterCast;
        continue;
      }
    }
    text += char;
    index += 1;
  }
  return { text, values: params };
}

/** Consume `::type` (and an optional length) when a known type follows. */
function skipCast(sql: string, index: number): number {
  if (sql[index] !== ':' || sql[index + 1] !== ':') return index;
  let cursor = index + 2;
  while (sql[cursor] === ' ') cursor += 1;
  const match = CAST_TYPE.exec(sql.slice(cursor));
  if (!match) return index;
  cursor += match[0].length;
  if (sql[cursor] === '(') {
    const close = sql.indexOf(')', cursor);
    if (close !== -1) cursor = close + 1;
  }
  return cursor;
}

function toDoubleQuoted(identifier: string): string {
  return `"${identifier.replace(/""/g, '"').replace(/"/g, '""')}"`;
}

function skipSingleQuoted(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === "'") {
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function skipDoubleQuoted(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '"') {
      if (sql[index + 1] === '"') {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function skipBacktick(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '`') {
      if (sql[index + 1] === '`') {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function skipDollarQuoted(sql: string, start: number): number {
  const close = sql.indexOf('$$', start + 2);
  return close === -1 ? sql.length : close + 2;
}

function lineCommentEnd(sql: string, start: number): number {
  const newline = sql.indexOf('\n', start);
  return newline === -1 ? sql.length : newline;
}

function blockCommentEnd(sql: string, start: number): number {
  const close = sql.indexOf('*/', start + 2);
  return close === -1 ? sql.length : close + 2;
}

/**
 * MySQL refuses to bind a JavaScript `Date`/ISO string into `DATETIME` when it
 * carries the `Z` suffix. Values are stored as UTC and the session time zone is
 * pinned to `+00:00`, so normalising here keeps one representation everywhere.
 */
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/;

export function normaliseMysqlValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = ISO_TIMESTAMP.exec(value);
    if (match) {
      const fraction = (match[3] ?? '').padEnd(6, '0');
      return `${match[1]} ${match[2]}.${fraction}`;
    }
    return value;
  }
  if (value instanceof Date) {
    const iso = value.toISOString();
    const match = ISO_TIMESTAMP.exec(iso);
    if (match) return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`;
    return iso;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export function normaliseMysqlValues(values: readonly unknown[]): unknown[] {
  return values.map(normaliseMysqlValue);
}

/**
 * Split a migration script into single statements.
 *
 * PostgreSQL accepts a whole script in one `query()` call; MySQL rejects it
 * when multi-statement execution is off, which is the safe default. Semicolons
 * inside strings, identifiers and comments never split.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'") {
      index = skipSingleQuoted(sql, index);
      continue;
    }
    if (char === '"') {
      index = skipDoubleQuoted(sql, index);
      continue;
    }
    if (char === '`') {
      index = skipBacktick(sql, index);
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      index = lineCommentEnd(sql, index);
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      index = blockCommentEnd(sql, index);
      continue;
    }
    if (char === '$') {
      const dollar = /^\$([A-Za-z_]*)\$/.exec(sql.slice(index));
      if (dollar) {
        const close = sql.indexOf(dollar[0], index + dollar[0].length);
        index = close === -1 ? sql.length : close + dollar[0].length;
        continue;
      }
    }
    if (char === ';') {
      statements.push(sql.slice(start, index + 1).trim());
      start = index + 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements.filter((statement) => statement && statement !== ';');
}
