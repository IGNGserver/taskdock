import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DeviceDto, UserDto } from '@devtodo/contracts';
import { DomainError } from '@devtodo/domain';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import type { Store } from './store.js';

export interface AuthConfig {
  bootstrapToken: string;
  accessTokenSecret: string;
  refreshTokenPepper: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: UserDto;
  device: DeviceDto;
}

export class AuthService {
  private readonly secret: Uint8Array;

  constructor(
    private readonly store: Store,
    private readonly config: AuthConfig,
  ) {
    if (config.bootstrapToken.length < 32)
      throw new Error('BOOTSTRAP_TOKEN must contain at least 32 characters');
    if (config.accessTokenSecret.length < 32 || config.refreshTokenPepper.length < 32)
      throw new Error('token secrets are too short');
    this.secret = new TextEncoder().encode(config.accessTokenSecret);
  }

  async bootstrap(token: string, username: string, password: string): Promise<UserDto> {
    if (!safeEqual(token, this.config.bootstrapToken))
      throw new DomainError('BOOTSTRAP_TOKEN_INVALID', '初始化令牌无效');
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    return this.store.withMutation(async () => {
      if (await this.store.hasOwner())
        throw new DomainError('BOOTSTRAP_ALREADY_COMPLETED', 'Owner 已初始化');
      return await this.store.createOwner(username, passwordHash);
    });
  }

  async login(input: {
    username: string;
    password: string;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
  }): Promise<AuthResult> {
    const user = await this.store.findUserByUsername(input.username);
    if (!user || user.disabledAt || !(await argon2.verify(user.passwordHash, input.password)))
      throw new DomainError('AUTH_INVALID_CREDENTIALS', '用户名或密码错误');
    const refreshToken = randomBytes(48).toString('base64url');
    const deviceName = input.deviceName ?? '未命名设备';
    const platform = input.platform ?? 'web';
    return this.store.withMutation(async () => {
      const device = await this.store.createDevice(user.id, input.deviceId, deviceName, platform);
      // Refresh session does not expire by time; valid until explicit logout or chain revocation.
      const expiresAt = new Date(Date.now() + 100 * 365 * 86_400_000).toISOString();
      await this.store.createSession(
        user.id,
        device.id,
        this.hashRefreshToken(refreshToken),
        expiresAt,
      );
      return {
        accessToken: await this.signAccessToken(user.id, device.id),
        refreshToken,
        user: { id: user.id, username: user.username, createdAt: user.createdAt },
        device,
      };
    });
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    const nextRefreshToken = randomBytes(48).toString('base64url');
    const outcome = await this.store.withMutation(async () => {
      const session = await this.store.findSessionByHash(this.hashRefreshToken(refreshToken));
      if (!session) throw new DomainError('AUTH_SESSION_REVOKED', '会话不存在或已撤销');
      if (session.revokedAt || session.usedAt || session.replacedById) {
        await this.store.revokeSessionChain(session);
        return { replayDetected: true as const };
      }
      const device = await this.store.getDevice(session.ownerId, session.deviceId);
      if (device.revokedAt) throw new DomainError('AUTH_SESSION_REVOKED', '设备会话已撤销');
      const user = await this.store.getUserRecord(session.ownerId);
      await this.store.rotateSession(
        session.id,
        this.hashRefreshToken(nextRefreshToken),
        session.expiresAt,
      );
      return {
        replayDetected: false as const,
        result: {
          accessToken: await this.signAccessToken(user.id, device.id),
          refreshToken: nextRefreshToken,
          user: { id: user.id, username: user.username, createdAt: user.createdAt },
          device: (await this.store.listDevices(user.id)).find(
            (candidate: DeviceDto) => candidate.id === device.id,
          )!,
        },
      };
    });
    if (outcome.replayDetected)
      throw new DomainError('AUTH_SESSION_REVOKED', '检测到 refresh token 重放，会话链已撤销');
    return outcome.result;
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.store.withMutation(async () => {
      const session = await this.store.findSessionByHash(this.hashRefreshToken(refreshToken));
      if (session) await this.store.revokeSessionChain(session);
    });
  }

  async signAccessToken(ownerId: string, deviceId: string): Promise<string> {
    return new SignJWT({ deviceId, tokenType: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(ownerId)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSeconds}s`)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string): Promise<{ ownerId: string; deviceId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'] });
      if (
        payload.tokenType !== 'access' ||
        typeof payload.sub !== 'string' ||
        typeof payload.deviceId !== 'string'
      )
        throw new Error('invalid claims');
      const device = await this.store.getDevice(payload.sub, payload.deviceId);
      if (device.revokedAt) throw new DomainError('AUTH_SESSION_REVOKED', '设备会话已撤销');
      await this.store.getUserRecord(payload.sub);
      return { ownerId: payload.sub, deviceId: payload.deviceId };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('AUTH_REQUIRED', '需要登录');
    }
  }

  private hashRefreshToken(value: string): string {
    return createHash('sha256').update(`${this.config.refreshTokenPepper}:${value}`).digest('hex');
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
