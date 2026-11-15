import { describe, expect, it } from 'vitest';
import { prepareQuery } from '../src/dialect.js';

describe('SQL preparation', () => {
  it('keeps PostgreSQL placeholders and converts backticks to quoted identifiers', () => {
    const prepared = prepareQuery('postgres', 'SELECT `rank`, id FROM tasks WHERE owner_id = $1', [
      'owner',
    ]);
    expect(prepared.text).toBe('SELECT "rank", id FROM tasks WHERE owner_id = $1');
    expect(prepared.values).toEqual(['owner']);
  });

  it('leaves literals and comments alone', () => {
    const sql = "SELECT '`rank` $1' AS literal, id FROM tasks -- `rank` $2\n WHERE id = $1";
    const prepared = prepareQuery('postgres', sql, ['abc']);
    expect(prepared.text).toBe(
      "SELECT '`rank` $1' AS literal, id FROM tasks -- `rank` $2\n WHERE id = $1",
    );
  });

  it('renumbers MySQL placeholders in appearance order, including repeats', () => {
    const prepared = prepareQuery(
      'mysql',
      'INSERT INTO tasks (id, owner_id) VALUES ($1, $2) ON DUPLICATE KEY UPDATE id = $1, owner_id = $2',
      ['a', 'b'],
    );
    expect(prepared.text).toBe(
      'INSERT INTO tasks (id, owner_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = ?, owner_id = ?',
    );
    expect(prepared.values).toEqual(['a', 'b', 'a', 'b']);
  });

  it('drops PostgreSQL type casts for MySQL', () => {
    const prepared = prepareQuery(
      'mysql',
      'SELECT COUNT(*)::int AS n, $1::date AS day, $2::jsonb AS payload, $3::double precision AS f',
      ['2026-11-15', '{}', 1.5],
    );
    expect(prepared.text).toBe('SELECT COUNT(*) AS n, ? AS day, ? AS payload, ? AS f');
    expect(prepared.values).toEqual(['2026-11-15', '{}', 1.5]);
  });

  it('keeps MySQL backtick quoting and single-quoted content intact', () => {
    const prepared = prepareQuery(
      'mysql',
      "SELECT `rank` FROM tasks WHERE title LIKE '%rank%' AND id = $1",
      ['x'],
    );
    expect(prepared.text).toBe("SELECT `rank` FROM tasks WHERE title LIKE '%rank%' AND id = ?");
    expect(prepared.values).toEqual(['x']);
  });

  it('rejects a placeholder without a value', () => {
    expect(() => prepareQuery('mysql', 'SELECT $2', ['only-one'])).toThrow(/\$2/);
  });

  it('normalises ISO timestamps and booleans for MySQL parameters', async () => {
    const { normaliseMysqlValues } = await import('../src/dialect.js');
    expect(normaliseMysqlValues(['2026-11-15T08:07:24.123Z', true, 42])).toEqual([
      '2026-11-15 08:07:24.123000',
      1,
      42,
    ]);
    expect(normaliseMysqlValues(['2026-11-15'])).toEqual(['2026-11-15']);
  });
});
