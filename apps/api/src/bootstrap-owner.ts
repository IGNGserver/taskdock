import { createPool } from '@devtodo/database';
import { DomainError } from '@devtodo/domain';
import { z } from 'zod';
import { AuthService } from './auth.js';
import { PostgresStore } from './postgres-store.js';

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function main(): Promise<void> {
  const databaseUrl = requiredEnv('DATABASE_URL');
  const bootstrapToken = requiredEnv('BOOTSTRAP_TOKEN');
  const username = requiredEnv('OWNER_USERNAME');
  const password = requiredEnv('OWNER_PASSWORD');
  const input = z
    .object({ username: z.string().trim().min(1).max(64), password: z.string().min(6) })
    .parse({ username, password });
  const accessTokenSecret = requiredEnv('ACCESS_TOKEN_SECRET');
  const refreshTokenPepper = requiredEnv('REFRESH_TOKEN_PEPPER');
  const pool = createPool(databaseUrl);
  const store = new PostgresStore(pool);
  try {
    await store.init();
    if (await store.hasOwner()) {
      console.log('SKIP: Owner 已初始化，部署侧初始化不会重复执行。');
      return;
    }
    const auth = new AuthService(store, {
      bootstrapToken,
      accessTokenSecret,
      refreshTokenPepper,
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
    });
    await auth.bootstrap(bootstrapToken, input.username, input.password);
    console.log(`PASS: 已在部署中枢完成 Owner 初始化（用户名：${input.username}）。`);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'BOOTSTRAP_ALREADY_COMPLETED') {
      console.log('SKIP: Owner 已初始化，部署侧初始化不会重复执行。');
      return;
    }
    throw error;
  } finally {
    await store.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
