/**
 * MySQL 8.4 compatibility probe.
 *
 * Every query shape the TaskDock PostgreSQL adapter depends on is executed
 * against a real MySQL server here, so the MySQL port is built on observed
 * behaviour instead of assumptions. Each case records what actually happened;
 * a case whose observation disagrees with the expectation fails the run.
 *
 * Usage:
 *   TASKDOCK_MYSQL_TEST_URL=mysql://root@127.0.0.1:13306 pnpm test:mysql-compat
 *
 * The URL must point at a throwaway server: the script creates and drops the
 * `taskdock_compat` database.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import mysql from 'mysql2/promise';

const BASE_URL = process.env['TASKDOCK_MYSQL_TEST_URL']?.trim();
if (!BASE_URL) {
  console.error('TASKDOCK_MYSQL_TEST_URL is not set; refusing to guess a server.');
  process.exit(2);
}

const DATABASE = 'taskdock_compat';
const OWNER = '00000000-0000-7000-8000-000000000001';
const CREATED_AT = '2026-11-15 08:07:24.123456';

type CaseResult = { name: string; observation: string; passed: boolean };
const results: CaseResult[] = [];

function serverUrl(): string {
  const url = new URL(BASE_URL!);
  url.protocol = 'mysql:';
  url.pathname = '/';
  return url.toString();
}

async function connect(database?: string): Promise<mysql.Connection> {
  return mysql.createConnection({
    uri: serverUrl(),
    database,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: false,
    timezone: 'Z',
    dateStrings: false,
  });
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function describeError(error: unknown): string {
  const err = error as { code?: string; errno?: number; sqlMessage?: string; message?: string };
  const code = err.code ?? (err.errno !== undefined ? String(err.errno) : 'ERROR');
  return `${code} ${err.sqlMessage ?? err.message ?? ''}`.trim().slice(0, 170);
}

function record(name: string, observation: string, passed: boolean): void {
  results.push({ name, observation, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}  ·  ${observation}`);
}

async function probe(
  name: string,
  fn: () => Promise<{ ok: boolean; observation: string }>,
): Promise<void> {
  try {
    const value = await fn();
    record(name, value.observation, value.ok);
  } catch (error) {
    record(name, `threw ${describeError(error)}`, false);
  }
}

async function expectRejected(
  name: string,
  allowed: string[],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    record(name, 'statement unexpectedly succeeded', false);
  } catch (error) {
    const code = errorCode(error);
    record(name, describeError(error), allowed.includes(code));
  }
}

function id(): string {
  const random = createHash('sha256').update(`${process.hrtime.bigint()}`).digest('hex');
  const time = Date.now().toString(16).padStart(12, '0');
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-8${random.slice(3, 6)}-${random.slice(6, 18)}`;
}

async function bootstrap(): Promise<void> {
  const admin = await connect();
  await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
  await admin.query(
    `CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  await admin.end();

  const db = await connect(DATABASE);
  await db.query(`
    CREATE TABLE probes (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      slot VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      title VARCHAR(160) NOT NULL DEFAULT '',
      status VARCHAR(16) NOT NULL DEFAULT 'TODO',
      sort_rank BIGINT NOT NULL DEFAULT 1024,
      payload JSON NULL,
      deleted_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      INDEX probes_owner_slot_idx (owner_id, slot)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.query(`
    CREATE TABLE slot_unique (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      slot VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      title VARCHAR(64) NOT NULL DEFAULT '',
      deleted_at DATETIME(6) NULL,
      active TINYINT(1) AS (IF(deleted_at IS NULL, 1, NULL)) STORED,
      UNIQUE KEY slot_unique_active_uq (owner_id, slot, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.query(
    'CREATE TABLE seq_probe (seq BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, owner CHAR(36) NOT NULL) ENGINE=InnoDB',
  );
  await db.query(
    'CREATE TABLE big_probe (id INT PRIMARY KEY AUTO_INCREMENT, v BIGINT NOT NULL) ENGINE=InnoDB',
  );
  await db.query(
    'CREATE TABLE keyword_probe (`rank` BIGINT NOT NULL DEFAULT 1, `cursor` BIGINT NOT NULL DEFAULT 0) ENGINE=InnoDB',
  );
  await db.query(`
    CREATE TABLE checks_probe (
      id INT PRIMARY KEY AUTO_INCREMENT,
      prefix VARCHAR(10) NOT NULL,
      title VARCHAR(160) NOT NULL,
      CONSTRAINT prefix_ck CHECK (REGEXP_LIKE(prefix, '^[A-Z][A-Z0-9]{1,9}$', 'c')),
      CONSTRAINT title_ck CHECK (CHAR_LENGTH(TRIM(title)) > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.query(
    'CREATE TABLE case_probe (id INT PRIMARY KEY AUTO_INCREMENT, title VARCHAR(64) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
  );
  await db.query("INSERT INTO case_probe (title) VALUES ('Alice')");
  await db.end();
}

async function cases(): Promise<void> {
  const db = await connect(DATABASE);

  await expectRejected('RETURNING 语法', ['ER_PARSE_ERROR'], () =>
    db.query("INSERT INTO probes (id, owner_id, slot) VALUES (?, ?, 'r') RETURNING id", [
      id(),
      OWNER,
    ]),
  );

  await probe('ON DUPLICATE KEY UPDATE 行别名', async () => {
    await db.query('INSERT INTO slot_unique (id, owner_id, slot, title) VALUES (?, ?, ?, ?)', [
      id(),
      OWNER,
      'upsert',
      'v1',
    ]);
    const second = await db.query(
      'INSERT INTO slot_unique (id, owner_id, slot, title) VALUES (?, ?, ?, ?) AS new ON DUPLICATE KEY UPDATE title = new.title',
      [id(), OWNER, 'upsert', 'v2'],
    );
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM slot_unique WHERE owner_id = ? AND slot = ?',
      [OWNER, 'upsert'],
    );
    const affected = (second[0] as mysql.ResultSetHeader).affectedRows;
    return {
      ok: affected === 2 && Number(rows[0]!['n']) === 1,
      observation: `affected=${affected} rows=${String(rows[0]!['n'])}`,
    };
  });

  await probe('生成列模拟部分唯一索引', async () => {
    for (let i = 0; i < 2; i += 1) {
      await db.query(
        'INSERT INTO slot_unique (id, owner_id, slot, deleted_at) VALUES (?, ?, ?, ?)',
        [id(), OWNER, 'tombstone', CREATED_AT],
      );
    }
    let liveDuplicateRejected = false;
    try {
      for (let i = 0; i < 2; i += 1) {
        await db.query('INSERT INTO slot_unique (id, owner_id, slot) VALUES (?, ?, ?)', [
          id(),
          OWNER,
          'live',
        ]);
      }
    } catch (error) {
      liveDuplicateRejected = errorCode(error) === 'ER_DUP_ENTRY';
    }
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM slot_unique WHERE slot = 'tombstone'",
    );
    return {
      ok: Number(rows[0]!['n']) === 2 && liveDuplicateRejected,
      observation: `tombstones=${String(rows[0]!['n'])} liveDuplicateRejected=${liveDuplicateRejected}`,
    };
  });

  await probe('多行 VALUES 批量写', async () => {
    const ids = Array.from({ length: 200 }, () => id());
    const columns = 9;
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const rowId of ids) {
      tuples.push(`(${new Array(columns).fill('?').join(',')})`);
      values.push(rowId, OWNER, 'batch', '初始标题', 'TODO', 1024, null, null, CREATED_AT);
    }
    const started = performance.now();
    await db.query(
      `INSERT INTO probes (id, owner_id, slot, title, status, sort_rank, payload, deleted_at, created_at) VALUES ${tuples.join(',')}`,
      values,
    );
    const elapsed = Math.round(performance.now() - started);

    const revalues: unknown[] = [];
    const retuples: string[] = [];
    for (const rowId of ids) {
      retuples.push(`(${new Array(6).fill('?').join(',')})`);
      revalues.push(rowId, OWNER, 'batch', '更新标题', 'TODO', 2048);
    }
    await db.query(
      `INSERT INTO probes (id, owner_id, slot, title, status, sort_rank) VALUES ${retuples.join(',')} AS new
       ON DUPLICATE KEY UPDATE title = new.title, sort_rank = new.sort_rank`,
      revalues,
    );
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n, SUM(title = '更新标题') AS updated FROM probes WHERE slot = 'batch'",
    );
    return {
      ok: Number(rows[0]!['n']) === 200 && Number(rows[0]!['updated']) === 200,
      observation: `rows=${String(rows[0]!['n'])} updated=${String(rows[0]!['updated'])} params=${values.length} insert=${elapsed}ms`,
    };
  });

  await probe('JSON_TABLE 展开数组', async () => {
    const payload = JSON.stringify([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ]);
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      `SELECT jt.id, jt.n FROM JSON_TABLE(?, '$[*]' COLUMNS (id CHAR(8) PATH '$.id', n INT PATH '$.n')) AS jt`,
      [payload],
    );
    return {
      ok: rows.length === 2 && Number(rows[1]!['n']) === 2,
      observation: `rows=${JSON.stringify(rows.map((row) => [row['id'], row['n']]))}`,
    };
  });

  await probe('JSON_ARRAYAGG 快照', async () => {
    for (const rank of [30, 10, 20]) {
      await db.query(
        'INSERT INTO probes (id, owner_id, slot, title, sort_rank) VALUES (?, ?, ?, ?, ?)',
        [id(), OWNER, 'agg', `r${rank}`, rank],
      );
    }
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      `SELECT JSON_ARRAYAGG(JSON_OBJECT('id', x.id, 'rank', x.sort_rank)) AS payload
       FROM (SELECT id, sort_rank FROM probes WHERE owner_id = ? AND slot = ? ORDER BY sort_rank, id) AS x`,
      [OWNER, 'agg'],
    );
    const rawPayload = rows[0]!['payload'];
    const parsed = (typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload) as Array<{
      rank: unknown;
    }>;
    const ranks = parsed.map((entry) => Number(entry.rank));
    // JSON_ARRAYAGG 不保证派生表的 ORDER BY，顺序必须在应用层补齐。
    const sorted = [...ranks].sort((left, right) => left - right);
    return {
      ok: parsed.length === 3 && sorted.join(',') === '10,20,30',
      observation: `aggregated=${ranks.join(',')} sorted=${sorted.join(',')} (顺序不稳定，需应用层排序)`,
    };
  });

  await probe('行值 keyset 比较', async () => {
    const [anchor] = await db.query<mysql.RowDataPacket[]>(
      "SELECT id FROM probes WHERE slot = 'agg' ORDER BY sort_rank LIMIT 1",
    );
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      'SELECT sort_rank FROM probes WHERE owner_id = ? AND slot = ? AND (sort_rank, id) > (?, ?) ORDER BY sort_rank, id LIMIT 3',
      [OWNER, 'agg', 10, String(anchor[0]!['id'])],
    );
    const ranks = rows.map((row) => Number(row['sort_rank']));
    return { ok: ranks.join(',') === '20,30', observation: `ranks=${ranks.join(',')}` };
  });

  await probe('FOR UPDATE SKIP LOCKED', async () => {
    const connA = await connect(DATABASE);
    const connB = await connect(DATABASE);
    try {
      await connA.beginTransaction();
      const [rowsA] = await connA.query<mysql.RowDataPacket[]>(
        "SELECT id FROM probes WHERE slot = 'agg' ORDER BY sort_rank LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      await connB.beginTransaction();
      const [rowsB] = await connB.query<mysql.RowDataPacket[]>(
        "SELECT id FROM probes WHERE slot = 'agg' ORDER BY sort_rank LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      await connB.rollback();
      await connA.rollback();
      return {
        ok: true,
        observation: `firstLocked=${rowsA.length} secondGot=${rowsB.length}; InnoDB 会在 LIMIT 前扫描并加锁，SKIP LOCKED 可能拿不到行`,
      };
    } finally {
      await connA.end();
      await connB.end();
    }
  });

  await expectRejected('DELETE 同表子查询', ['ER_UPDATE_TABLE_USED'], () =>
    db.query("DELETE FROM probes WHERE id IN (SELECT id FROM probes WHERE slot = 'agg')"),
  );

  await expectRejected('DELETE 同表子查询 + LIMIT', ['ER_NOT_SUPPORTED_YET'], () =>
    db.query("DELETE FROM probes WHERE id IN (SELECT id FROM probes WHERE slot = 'agg' LIMIT 1)"),
  );

  await probe('DELETE ORDER BY LIMIT', async () => {
    for (let i = 0; i < 5; i += 1) {
      await db.query('INSERT INTO probes (id, owner_id, slot, created_at) VALUES (?, ?, ?, ?)', [
        id(),
        OWNER,
        'purge',
        '2020-01-01 00:00:00.000000',
      ]);
    }
    const [result] = await db.query(
      'DELETE FROM probes WHERE slot = ? AND created_at < ? ORDER BY created_at LIMIT 3',
      ['purge', CREATED_AT],
    );
    const deleted = (result as mysql.ResultSetHeader).affectedRows;
    return { ok: deleted === 3, observation: `deleted=${deleted}` };
  });

  await probe('SAVEPOINT', async () => {
    await db.beginTransaction();
    try {
      await db.query('SAVEPOINT sp1');
      await db.query('INSERT INTO probes (id, owner_id, slot) VALUES (?, ?, ?)', [
        id(),
        OWNER,
        'savepoint',
      ]);
      await db.query('ROLLBACK TO SAVEPOINT sp1');
      await db.query('RELEASE SAVEPOINT sp1');
      const [rows] = await db.query<mysql.RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM probes WHERE slot = 'savepoint'",
      );
      await db.commit();
      return {
        ok: Number(rows[0]!['n']) === 0,
        observation: `afterRollback=${String(rows[0]!['n'])}`,
      };
    } catch (error) {
      await db.rollback();
      throw error;
    }
  });

  await probe('AUTO_INCREMENT 批次连续', async () => {
    const [inserted] = await db.query(
      'INSERT INTO seq_probe (owner) VALUES (?), (?), (?), (?), (?)',
      [OWNER, OWNER, OWNER, OWNER, OWNER],
    );
    const header = inserted as mysql.ResultSetHeader;
    const [rows] = await db.query<mysql.RowDataPacket[]>('SELECT MAX(seq) AS max FROM seq_probe');
    const expected = BigInt(header.insertId) + BigInt(header.affectedRows) - 1n;
    return {
      ok: BigInt(String(rows[0]!['max'])) === expected,
      observation: `insertId=${header.insertId} affected=${header.affectedRows} max=${String(rows[0]!['max'])}`,
    };
  });

  await probe('插入时对同表取 MAX', async () => {
    await db.query(
      'INSERT INTO probes (id, owner_id, slot, sort_rank) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_rank), 0) + 1024 FROM probes AS p WHERE p.owner_id = ? AND p.slot = ?))',
      [id(), OWNER, 'rankcalc', OWNER, 'rankcalc'],
    );
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      "SELECT sort_rank FROM probes WHERE slot = 'rankcalc'",
    );
    return {
      ok: Number(rows[0]!['sort_rank']) === 1024,
      observation: `rank=${String(rows[0]!['sort_rank'])}`,
    };
  });

  await probe('JSON 列读写', async () => {
    const rowId = id();
    await db.query(
      'INSERT INTO probes (id, owner_id, slot, payload) VALUES (?, ?, ?, CAST(? AS JSON))',
      [rowId, OWNER, 'json', JSON.stringify({ nested: { ok: true }, n: 7 })],
    );
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      'SELECT payload FROM probes WHERE id = ?',
      [rowId],
    );
    const raw = rows[0]!['payload'];
    const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      nested?: { ok?: boolean };
      n?: number;
    };
    return {
      ok: payload?.nested?.ok === true && payload.n === 7,
      observation: `driverType=${typeof raw} value=${JSON.stringify(payload)}`,
    };
  });

  await expectRejected(
    'DATETIME 拒绝带 Z 的 ISO 字符串',
    ['ER_TRUNCATED_WRONG_VALUE', 'ER_WRONG_VALUE', 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD'],
    () =>
      db.query('INSERT INTO probes (id, owner_id, slot, created_at) VALUES (?, ?, ?, ?)', [
        id(),
        OWNER,
        'iso',
        '2026-11-15T08:07:24.000Z',
      ]),
  );

  await probe('DATETIME(6) 往返', async () => {
    const rowId = id();
    await db.query('INSERT INTO probes (id, owner_id, slot, created_at) VALUES (?, ?, ?, ?)', [
      rowId,
      OWNER,
      'datetime',
      CREATED_AT,
    ]);
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      'SELECT created_at FROM probes WHERE id = ?',
      [rowId],
    );
    const value = rows[0]!['created_at'];
    return {
      ok: value instanceof Date && value.toISOString() === '2026-11-15T08:07:24.123Z',
      observation: `${value instanceof Date ? 'Date' : typeof value} ${String(value instanceof Date ? value.toISOString() : value)}`,
    };
  });

  await probe('CHECK + REGEXP_LIKE + CHAR_LENGTH', async () => {
    let rejected = false;
    try {
      await db.query("INSERT INTO checks_probe (prefix, title) VALUES ('bad', 'x')");
    } catch (error) {
      rejected = errorCode(error) === 'ER_CHECK_CONSTRAINT_VIOLATED';
    }
    await db.query("INSERT INTO checks_probe (prefix, title) VALUES ('ABC1', ' 标题 ')");
    return { ok: rejected, observation: `invalidRowRejected=${rejected}` };
  });

  await probe('排序规则', async () => {
    const [ci] = await db.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM case_probe WHERE title LIKE '%alice%'",
    );
    const [loose] = await db.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM (SELECT 'Owner' AS username UNION ALL SELECT 'owner') AS u WHERE u.username = 'owner'",
    );
    const [strict] = await db.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM (SELECT 'Owner' AS username UNION ALL SELECT 'owner') AS u WHERE u.username COLLATE utf8mb4_bin = 'owner'",
    );
    return {
      ok:
        Number(ci[0]!['n']) === 1 && Number(loose[0]!['n']) === 2 && Number(strict[0]!['n']) === 1,
      observation: `like=${String(ci[0]!['n'])} defaultEq=${String(loose[0]!['n'])} binEq=${String(strict[0]!['n'])}`,
    };
  });

  await probe('只读可重复读事务', async () => {
    const conn = await connect(DATABASE);
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await conn.query('START TRANSACTION READ ONLY');
      const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM probes');
      let writeRejected = false;
      try {
        await conn.query('INSERT INTO probes (id, owner_id, slot) VALUES (?, ?, ?)', [
          id(),
          OWNER,
          'readonly',
        ]);
      } catch (error) {
        writeRejected = errorCode(error) === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION';
      }
      await conn.commit();
      return {
        ok: Number(rows[0]!['n']) > 0 && writeRejected,
        observation: `readRows=${String(rows[0]!['n'])} writeRejected=${writeRejected}`,
      };
    } finally {
      await conn.end();
    }
  });

  await probe('语句级超时', async () => {
    const bulk: unknown[] = [];
    const tuples: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      tuples.push('(?, ?, ?)');
      bulk.push(id(), OWNER, 'timeout-fill');
    }
    await db.query(`INSERT INTO probes (id, owner_id, slot) VALUES ${tuples.join(',')}`, bulk);
    await db.query('SET SESSION max_execution_time = 50');
    let interrupted = false;
    try {
      await db.query('SELECT COUNT(*) FROM probes a, probes b WHERE a.sort_rank < b.sort_rank');
    } catch (error) {
      interrupted = errorCode(error) === 'ER_QUERY_TIMEOUT';
    }
    await db.query('SET SESSION max_execution_time = 0');
    return { ok: interrupted, observation: `selectInterrupted=${interrupted}` };
  });

  await probe('函数索引', async () => {
    await db.query(
      "CREATE INDEX probes_status_rank_idx ON probes ((CASE status WHEN 'IN_PROGRESS' THEN 0 WHEN 'TODO' THEN 1 ELSE 2 END), sort_rank, id)",
    );
    return { ok: true, observation: 'created' };
  });

  await probe('会话级咨询锁', async () => {
    const connA = await connect(DATABASE);
    const connB = await connect(DATABASE);
    try {
      const [a] = await connA.query<mysql.RowDataPacket[]>(
        "SELECT GET_LOCK('taskdock:probe', 0) AS held",
      );
      const [b] = await connB.query<mysql.RowDataPacket[]>(
        "SELECT GET_LOCK('taskdock:probe', 0) AS held",
      );
      await connA.query("SELECT RELEASE_LOCK('taskdock:probe')");
      const [c] = await connB.query<mysql.RowDataPacket[]>(
        "SELECT GET_LOCK('taskdock:probe', 0) AS held",
      );
      return {
        ok: [a, b, c].map((rows) => Number(rows[0]!['held'])).join(',') === '1,0,1',
        observation: `first=${String(a[0]!['held'])} second=${String(b[0]!['held'])} afterRelease=${String(c[0]!['held'])}`,
      };
    } finally {
      await connA.end();
      await connB.end();
    }
  });

  await probe('TINYINT(1) 读取', async () => {
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      "SELECT active FROM slot_unique WHERE slot = 'live' LIMIT 1",
    );
    const value = rows[0]!['active'];
    return { ok: value === 1 || value === true, observation: `${typeof value}:${String(value)}` };
  });

  await probe('超过 2^53 的 BIGINT', async () => {
    await db.query('TRUNCATE TABLE big_probe');
    await db.query('INSERT INTO big_probe (v) VALUES (?)', ['9007199254740993']);
    const [rows] = await db.query<mysql.RowDataPacket[]>('SELECT v FROM big_probe');
    const value = rows[0]!['v'];
    return { ok: true, observation: `driverReturns ${typeof value}:${String(value)}` };
  });

  await probe('FILTER 聚合', async () => {
    let code = '';
    try {
      await db.query("SELECT COUNT(*) FILTER (WHERE status = 'TODO') AS n FROM probes");
    } catch (error) {
      code = errorCode(error);
    }
    return { ok: code === 'ER_PARSE_ERROR', observation: code || 'unexpectedly supported' };
  });

  await probe('INTERVAL 参数化', async () => {
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      'SELECT NOW(6) - INTERVAL ? DAY AS cutoff',
      [90],
    );
    return {
      ok: rows[0]!['cutoff'] instanceof Date,
      observation: rows[0]!['cutoff'] instanceof Date ? 'Date' : typeof rows[0]!['cutoff'],
    };
  });

  await probe('utf8mb4 中文与 emoji', async () => {
    const rowId = id();
    await db.query('INSERT INTO probes (id, owner_id, slot, title) VALUES (?, ?, ?, ?)', [
      rowId,
      OWNER,
      'utf8',
      '任务 🚀 标题',
    ]);
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      'SELECT CHAR_LENGTH(title) AS n FROM probes WHERE id = ?',
      [rowId],
    );
    return { ok: Number(rows[0]!['n']) === 7, observation: `chars=${String(rows[0]!['n'])}` };
  });

  await expectRejected('rank 是 MySQL 保留字', ['ER_PARSE_ERROR'], () =>
    db.query('SELECT id, rank FROM probes LIMIT 1'),
  );

  await probe('反引号引用保留字', async () => {
    await db.query('INSERT INTO keyword_probe (`rank`, `cursor`) VALUES (?, ?)', [7, 3]);
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      'SELECT `rank`, `cursor` FROM keyword_probe ORDER BY `rank` DESC LIMIT 1',
    );
    return {
      ok: Number(rows[0]!['rank']) === 7 && Number(rows[0]!['cursor']) === 3,
      observation: `rank=${String(rows[0]!['rank'])} cursor=${String(rows[0]!['cursor'])}`,
    };
  });

  await db.end();
  const cleanup = await connect();
  await cleanup.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
  await cleanup.end();
}

async function main(): Promise<void> {
  await bootstrap();
  await cases();
  const failed = results.filter((result) => !result.passed).length;
  console.log(`\n${results.length - failed}/${results.length} cases matched the expectation.`);
  if (failed) {
    console.error('MySQL 8.4 does not behave as the dialect plan assumes; revisit the plan.');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
