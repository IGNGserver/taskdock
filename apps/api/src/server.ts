import { access } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bootstrapSchema,
  createEventSchema,
  createFolderSchema,
  createStepSchema,
  createWorkflowSchema,
  createWorkflowStageSchema,
  createPlacementSchema,
  loginSchema,
  localDateSchema,
  placementTargetSchema,
  v2MutationSchema,
  v2PushSchema,
  reorderSchema,
  updateFolderSchema,
  updateStepSchema,
  updateTimePointSchema,
  updateWorkflowSchema,
  updateWorkflowStageSchema,
  moveWorkflowStageSchema,
  updateV2SettingsSchema,
  treeMoveSchema,
  stepMoveSchema,
  addWorkflowTaskSchema,
  moveWorkflowMembershipSchema,
  uuidSchema,
  type ErrorCode,
} from '@devtodo/contracts';
import { createPool } from '@devtodo/database';
import { DomainError } from '@devtodo/domain';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import websocket, { type WebSocket as HubWebSocket } from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { AuthService, type AuthConfig } from './auth.js';
import { PostgresStore } from './postgres-store.js';
import { PostgresTreeStore } from './postgres-tree-store.js';
import { MemoryStore, type Store } from './store.js';
import { MemoryTreeStore, type V2TreeStore } from './tree-store.js';

const pageLimitSchema = z.coerce.number().int().min(1).max(500).default(100);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = resolve(moduleDirectory, '../../web/dist');

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { ownerId: string; deviceId: string };
  }
}

export interface AppConfig extends AuthConfig {
  nodeEnv: string;
  appVersion: string;
  appPort: number;
  appOrigin: string;
  databaseUrl?: string;
  corsAllowedOrigins: string[];
  nativeAllowedOrigins: string[];
  trustProxy: boolean | string | string[] | ((address: string, hop: number) => boolean);
  logLevel: string;
  devMemoryStore: boolean;
  webRoot: string;
  syncChangeRetentionDays: number;
  mutationReceiptRetentionDays: number;
  dbConnectionTimeoutMs: number;
  dbIdleTimeoutMs: number;
  dbQueryTimeoutMs: number;
  dbStatementTimeoutMs: number;
  dbLockTimeoutMs: number;
  httpRequestTimeoutMs: number;
  httpConnectionTimeoutMs: number;
}

export interface BuildServerOptions {
  config?: Partial<AppConfig>;
  store?: Store;
}

const v2StoreCache = new WeakMap<object, V2TreeStore>();
const websocketConnections = new Map<string, number>();
const websocketMaxPerOriginAndIp = 32;
const websocketMaxBufferedBytes = 1_000_000;

function treeStoreFor(store: Store): V2TreeStore {
  const cached = v2StoreCache.get(store);
  if (cached) return cached;
  // MemoryTreeStore performs the v1 -> v2 projection lazily and keeps the
  // legacy store untouched. A PostgreSQL adapter is installed below through
  // the same interface; keeping this boundary here prevents route handlers
  // from ever reaching across Owner scopes.
  const tree =
    store instanceof PostgresStore
      ? new PostgresTreeStore(store)
      : new MemoryTreeStore(store instanceof MemoryStore ? store : undefined);
  v2StoreCache.set(store, tree);
  return tree;
}

const defaultConfig: AppConfig = {
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  appVersion: process.env['APP_VERSION'] ?? '0.1.0',
  appPort: Number(process.env['APP_PORT'] ?? 3000),
  appOrigin: process.env['APP_ORIGIN'] ?? 'http://localhost:3000',
  databaseUrl: process.env['DATABASE_URL'],
  bootstrapToken: process.env['BOOTSTRAP_TOKEN'] ?? 'devtodo-local-bootstrap-token-change-me-now',
  accessTokenSecret:
    process.env['ACCESS_TOKEN_SECRET'] ?? 'devtodo-local-access-secret-change-me-now',
  refreshTokenPepper:
    process.env['REFRESH_TOKEN_PEPPER'] ?? 'devtodo-local-refresh-pepper-change-me-now',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  corsAllowedOrigins: (
    process.env['CORS_ALLOWED_ORIGINS'] ?? 'http://localhost:5173,http://localhost:3000'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  nativeAllowedOrigins: (
    process.env['NATIVE_ALLOWED_ORIGINS'] ??
    'devtodo://app,capacitor://localhost,https://localhost,http://localhost'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  trustProxy: parseTrustProxy(process.env['TRUST_PROXY'] ?? '0'),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  devMemoryStore: process.env['DEV_MEMORY_STORE'] !== 'false',
  webRoot: process.env['WEB_ROOT'] ? resolve(process.env['WEB_ROOT']) : defaultWebRoot,
  syncChangeRetentionDays: Number(process.env['SYNC_CHANGE_RETENTION_DAYS'] ?? 90),
  mutationReceiptRetentionDays: Number(process.env['MUTATION_RECEIPT_RETENTION_DAYS'] ?? 90),
  dbConnectionTimeoutMs: Number(process.env['DB_CONNECTION_TIMEOUT_MS'] ?? 5_000),
  dbIdleTimeoutMs: Number(process.env['DB_IDLE_TIMEOUT_MS'] ?? 30_000),
  dbQueryTimeoutMs: Number(process.env['DB_QUERY_TIMEOUT_MS'] ?? 30_000),
  dbStatementTimeoutMs: Number(process.env['DB_STATEMENT_TIMEOUT_MS'] ?? 30_000),
  dbLockTimeoutMs: Number(process.env['DB_LOCK_TIMEOUT_MS'] ?? 5_000),
  httpRequestTimeoutMs: Number(process.env['HTTP_REQUEST_TIMEOUT_MS'] ?? 30_000),
  httpConnectionTimeoutMs: Number(process.env['HTTP_CONNECTION_TIMEOUT_MS'] ?? 10_000),
};

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<{ app: FastifyInstance; store: Store; config: AppConfig }> {
  const config = { ...defaultConfig, ...options.config };
  validateRuntimeConfig(config);
  const store = options.store ?? (await createStore(config));
  await store.init();
  const auth = new AuthService(store, config);
  const rateLimiter = new AuthRateLimiter();
  let appOrigin: string | null = null;
  try {
    appOrigin = new URL(config.appOrigin).origin;
  } catch {
    appOrigin = null;
  }
  const nativeOrigins = [
    ...new Set(
      [
        ...config.corsAllowedOrigins,
        ...config.nativeAllowedOrigins,
        appOrigin,
        'http://localhost',
      ].filter((origin): origin is string => Boolean(origin)),
    ),
  ];
  const publicProtocol = protocolForOrigin(config.appOrigin);
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.refreshToken',
          'req.body.token',
          'req.body.accessToken',
          'req.query.ticket',
          'req.query.token',
          'req.query.accessToken',
          'req.query.refreshToken',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req: (request: {
          method?: string;
          url?: string;
          headers?: { host?: string };
          socket?: { remoteAddress?: string };
        }) => ({
          method: request.method,
          url: redactSensitiveUrl(request.url ?? ''),
          host: request.headers?.host,
          remoteAddress: request.socket?.remoteAddress,
        }),
      },
    },
    bodyLimit: 1_200_000,
    requestTimeout: config.httpRequestTimeoutMs,
    connectionTimeout: config.httpConnectionTimeoutMs,
    keepAliveTimeout: 5_000,
    genReqId: () => cryptoUuid(),
  });
  app.addHook('onClose', async () => {
    websocketConnections.clear();
  });

  await app.register(cookie);
  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || nativeOrigins.includes(origin)) callback(null, true);
      else callback(new Error('origin is not allowed'), false);
    },
  });
  await app.register(helmet, {
    // Fastify Helmet enables HSTS by default. HTTP/LAN deployments must not
    // advertise an HTTPS upgrade; the production HTTPS hook below owns HSTS.
    hsts: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        connectSrc: ["'self'", ...nativeOrigins],
        // The deployment docs intentionally support HTTP on trusted LANs.
        // Helmet enables this directive by default, which upgrades every
        // relative script/style request to HTTPS and leaves an HTTP-only
        // deployment blank. Keep it for HTTPS, explicitly disable it for
        // HTTP.
        upgradeInsecureRequests: publicProtocol === 'https:' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(websocket, {
    options: {
      maxPayload: 1_200_000,
      perMessageDeflate: false,
    },
  });
  let webBuildAvailable = false;
  try {
    await access(config.webRoot);
    await app.register(fastifyStatic, {
      root: config.webRoot,
      prefix: '/',
      wildcard: false,
    });
    webBuildAvailable = true;
  } catch {
    app.log.warn({ webRoot: config.webRoot }, 'web build not found; API-only mode');
  }

  app.addHook('onRequest', async (request, reply) => {
    const requestId = validRequestId(request.headers['x-request-id']) ?? request.id;
    reply.header('X-Request-Id', requestId);
    reply.header('X-TaskDock-Version', config.appVersion);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (config.nodeEnv === 'production' && protocolForOrigin(config.appOrigin) === 'https:')
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = String(reply.getHeader('X-Request-Id') ?? request.id);
    if (error instanceof DomainError)
      return sendError(
        reply,
        error.code,
        error.message,
        requestId,
        error.details,
        statusFor(error.code),
      );
    if (error instanceof ZodError)
      return sendError(reply, 'VALIDATION_FAILED', '请求参数无效', requestId, error.flatten(), 400);
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return sendError(reply, 'VALIDATION_FAILED', '请求体过大', requestId, null, 413);
    request.log.error({ err: error, requestId }, 'unhandled request error');
    return sendError(reply, 'INTERNAL_ERROR', '服务暂时不可用', requestId, null, 500);
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const ready = store instanceof PostgresStore ? await store.checkReady() : true;
    if (!ready) return reply.code(503).send({ status: 'not_ready' });
    return { status: 'ready' };
  });
  app.get('/version', async () => ({
    appVersion: config.appVersion,
    commitSha: process.env['COMMIT_SHA'] ?? 'local',
    buildTime: process.env['BUILD_TIME'] ?? null,
    syncProtocolVersion: 2,
  }));

  app.register(
    async (api) => {
      api.get('/bootstrap/status', async () => ({ initialized: await store.hasOwner() }));

      api.post('/bootstrap', async (request, reply) => {
        const body = z
          .object({ ...bootstrapSchema.shape, token: z.string().min(1) })
          .parse(request.body);
        rateLimiter.check(request, 'bootstrap', body.username, 5, 15 * 60_000);
        const user = await auth.bootstrap(body.token, body.username, body.password);
        return reply.code(201).send({ user });
      });

      api.post('/auth/login', async (request, reply) => {
        const body = loginSchema
          .extend({ nativeChallenge: uuidSchema.optional() })
          .parse(request.body);
        rateLimiter.check(request, 'login', body.username, 10, 15 * 60_000);
        const nativeExchange = await requireNativeExchange(
          request,
          config,
          store,
          body.nativeChallenge,
        );
        const result = await auth.login(body);
        setRefreshCookie(reply, result.refreshToken, config);
        return {
          accessToken: result.accessToken,
          user: result.user,
          device: result.device,
          ...(nativeExchange ? { refreshToken: result.refreshToken } : {}),
        };
      });

      api.post('/auth/refresh', async (request, reply) => {
        const body = z
          .object({
            refreshToken: z.string().min(1).optional(),
            nativeChallenge: uuidSchema.optional(),
          })
          .parse(request.body ?? {});
        rateLimiter.check(request, 'refresh', undefined, 30, 60_000);
        const nativeExchange = await requireNativeExchange(
          request,
          config,
          store,
          body.nativeChallenge,
        );
        const refreshToken = body.refreshToken ?? request.cookies['devtodo_refresh'];
        if (!refreshToken) throw new DomainError('AUTH_SESSION_REVOKED', '缺少 refresh token');
        const result = await auth.refresh(refreshToken);
        setRefreshCookie(reply, result.refreshToken, config);
        return {
          accessToken: result.accessToken,
          user: result.user,
          device: result.device,
          ...(nativeExchange ? { refreshToken: result.refreshToken } : {}),
        };
      });

      api.post('/auth/logout', async (request, reply) => {
        const body = z
          .object({ refreshToken: z.string().min(1).optional() })
          .parse(request.body ?? {});
        await auth.logout(body.refreshToken ?? request.cookies['devtodo_refresh']);
        clearRefreshCookie(reply, config);
        return { ok: true };
      });

      api.post('/auth/native/challenge', async (request, reply) => {
        const clientId = request.headers['x-client-id'];
        const rateIdentity =
          typeof clientId === 'string' ? clientId : (request.headers.origin ?? undefined);
        rateLimiter.check(request, 'native-challenge', rateIdentity, 30, 60_000);
        const origin = requestOrigin(request);
        if (!nativeClient(request, config) || !origin)
          throw new DomainError('AUTH_REQUIRED', '原生客户端来源未获允许');
        const expiresAt = new Date(Date.now() + 30_000).toISOString();
        const challenge = await store.createNativeChallenge(origin, expiresAt);
        return reply.code(201).send({ challenge, expiresAt });
      });

      api.addHook('preHandler', requireAccessToken(auth));

      api.get('/me', async (request) => {
        const ownerId = request.auth!.ownerId;
        const [user, settings] = await Promise.all([
          store.getUser(ownerId),
          store.getSettings(ownerId),
        ]);
        return {
          user,
          settings,
          capabilities: { syncProtocolVersion: 2, websocket: true, offline: true },
        };
      });
      api.get('/devices', async (request) => store.listDevices(request.auth!.ownerId));

      api.get('/settings', async (request) => store.getSettings(request.auth!.ownerId));
      api.patch('/settings', async (request) => {
        const body = z
          .object({
            timezone: z.string().optional(),
            weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
            defaultCaptureTarget: z.string().min(1).optional(),
            baseVersion: z.number().int().positive(),
          })
          .parse(request.body);
        const meta = mutationMeta(request);
        return mutate(
          store,
          request.auth!.ownerId,
          meta,
          'settings.update',
          request.auth!.ownerId,
          body,
          () => store.updateSettings(request.auth!.ownerId, body, body.baseVersion),
        );
      });

      api.get('/projects', async (request) => {
        const query = z
          .object({
            archived: z.enum(['true', 'false']).optional(),
            cursor: z.string().max(512).optional(),
            limit: pageLimitSchema,
          })
          .parse(request.query);
        const archived = query.archived === 'true';
        const page =
          store instanceof PostgresStore
            ? await store.listProjectsPage(
                request.auth!.ownerId,
                archived,
                query.cursor,
                query.limit,
              )
            : paginateList(
                await store.listProjects(request.auth!.ownerId, archived),
                query.cursor,
                query.limit,
              );
        return {
          items: page.items,
          nextCursor: page.nextCursor,
        };
      });
      api.get('/projects/task-counts', async (request) => {
        const query = z
          .object({ archived: z.enum(['true', 'false']).optional() })
          .parse(request.query);
        return {
          items: await store.listProjectTaskCounts(
            request.auth!.ownerId,
            query.archived === 'true',
          ),
        };
      });
      api.get('/projects/:id', async (request) =>
        store.getProject(request.auth!.ownerId, paramId(request)),
      );
      api.post('/projects', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 项目写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.patch('/projects/:id', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 项目写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.post('/projects/:id/archive', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 项目写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.post('/projects/:id/restore', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 项目写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.post('/projects/reorder', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 项目写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });

      api.get('/tasks', async (request) => {
        const query = z
          .object({
            projectId: z.union([uuidSchema, z.literal('null')]).optional(),
            category: z.enum(['FEATURE', 'MISC']).optional(),
            status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
            archived: z.enum(['true', 'false']).optional(),
            timePointId: uuidSchema.optional(),
            cursor: z.string().max(512).optional(),
            limit: pageLimitSchema,
          })
          .parse(request.query);
        const filters = {
          projectId:
            query['projectId'] === undefined
              ? undefined
              : query['projectId'] === 'null'
                ? null
                : query['projectId'],
          category: enumQuery(query['category'], ['FEATURE', 'MISC']),
          status: enumQuery(query['status'], ['TODO', 'IN_PROGRESS', 'DONE']),
          archived: query['archived'] === undefined ? false : query['archived'] === 'true',
          timePointId: query['timePointId'],
        };
        const page =
          store instanceof PostgresStore
            ? await store.listTasksPage(request.auth!.ownerId, filters, query.cursor, query.limit)
            : paginateList(
                await store.listTasks(request.auth!.ownerId, filters),
                query.cursor,
                query.limit,
              );
        return { items: page.items, nextCursor: page.nextCursor };
      });
      api.get('/tasks/:id', async (request) =>
        store.getTaskDetails(request.auth!.ownerId, paramId(request)),
      );
      api.post('/tasks', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 任务写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.patch('/tasks/:id', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 任务写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.post('/tasks/:id/archive', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 任务写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.post('/tasks/:id/restore', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 任务写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.post('/tasks/:id/duplicate', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 任务写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.post('/tasks/reorder', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 任务写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.get('/tasks/:id/note', async (request) =>
        store.getNote(request.auth!.ownerId, paramId(request)),
      );
      api.put('/tasks/:id/note', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 备注写入已关闭，请升级到 TaskDock v2 统一目录树协议',
        );
      });
      api.get('/search/tasks', async (request) => {
        const query = z
          .object({
            q: z.string().trim().max(500).optional(),
            includeArchived: z.enum(['true', 'false']).optional(),
            limit: pageLimitSchema,
          })
          .parse(request.query);
        const items = await store.search(
          request.auth!.ownerId,
          query.q ?? '',
          query.includeArchived === 'true',
          query.limit,
        );
        return { items };
      });

      api.get('/time-points', async (request) => {
        const query = z
          .object({
            type: z.enum(['DATE', 'EVENT']).optional(),
            archived: z.enum(['true', 'false']).optional(),
            cursor: z.string().max(512).optional(),
            limit: pageLimitSchema,
          })
          .parse(request.query);
        const type = enumQuery(query.type, ['DATE', 'EVENT']);
        const archived = query.archived === undefined ? false : query.archived === 'true';
        const page =
          store instanceof PostgresStore
            ? await store.listTimePointsPage(
                request.auth!.ownerId,
                type,
                archived,
                query.cursor,
                query.limit,
              )
            : paginateList(
                await store.listTimePoints(request.auth!.ownerId, type, archived),
                query.cursor,
                query.limit,
                (point: {
                  id: string;
                  type: 'DATE' | 'EVENT';
                  localDate: string | null;
                  rank: string;
                }) =>
                  point.type === 'DATE'
                    ? { group: 'date', value: point.localDate ?? '', id: point.id }
                    : { group: 'event', value: point.rank, id: point.id },
              );
        return {
          items: page.items,
          nextCursor: page.nextCursor,
        };
      });
      api.post('/time-points/date', async (request, reply) => {
        const body = z.object({ localDate: localDateSchema }).parse(request.body);
        const meta = mutationMeta(request);
        const result = await mutate(
          store,
          request.auth!.ownerId,
          meta,
          'timePoint.date.create',
          meta.mutationId,
          body,
          () => store.createDate(request.auth!.ownerId, body.localDate, meta.mutationId),
        );
        return reply.code(201).send(result);
      });
      api.post('/time-points/events', async (request, reply) => {
        const body = createEventSchema.parse(request.body);
        const meta = mutationMeta(request);
        const result = await mutate(
          store,
          request.auth!.ownerId,
          meta,
          'timePoint.event.create',
          meta.mutationId,
          body,
          () => store.createEvent(request.auth!.ownerId, body.title, meta.mutationId),
        );
        return reply.code(201).send(result);
      });
      api.get('/time-points/placement-counts', async (request) => {
        const query = z
          .object({
            type: z.enum(['DATE', 'EVENT']),
            archived: z.enum(['true', 'false']).optional(),
            from: localDateSchema.optional(),
            to: localDateSchema.optional(),
          })
          .parse(request.query);
        if (query.type === 'EVENT' && (query.from || query.to))
          throw new DomainError('VALIDATION_FAILED', '事件时间点不支持日期范围筛选');
        if (query.from && query.to && query.from > query.to)
          throw new DomainError('VALIDATION_FAILED', '日期范围无效');
        return {
          items: await store.listTimePointPlacementCounts(
            request.auth!.ownerId,
            query.type,
            query.archived === undefined ? undefined : query.archived === 'true',
            query.from,
            query.to,
          ),
        };
      });
      api.get('/time-points/:id', async (request) =>
        store.getTimePoint(request.auth!.ownerId, paramId(request)),
      );
      api.patch('/time-points/:id', async (request) => {
        const body = updateTimePointSchema.parse(request.body);
        const meta = mutationMeta(request);
        return mutate(
          store,
          request.auth!.ownerId,
          meta,
          'timePoint.update',
          paramId(request),
          body,
          () =>
            store.updateTimePoint(
              request.auth!.ownerId,
              paramId(request),
              body.title ?? '',
              body.baseVersion,
            ),
        );
      });
      api.post('/time-points/:id/reach', async (request) =>
        actionVersioned(store, request, 'timePoint.reach', (id, ownerId, version) =>
          store.reachTimePoint(ownerId, id, version),
        ),
      );
      api.post('/time-points/:id/archive', async (request) =>
        actionVersioned(store, request, 'timePoint.archive', (id, ownerId, version) =>
          store.archiveTimePoint(ownerId, id, version),
        ),
      );
      api.post('/time-points/:id/restore', async (request) =>
        actionVersioned(store, request, 'timePoint.restore', (id, ownerId, version) =>
          store.restoreTimePoint(ownerId, id, version),
        ),
      );
      api.post('/time-points/events/reorder', async (request) => {
        const body = reorderSchema.parse(request.body);
        const meta = mutationMeta(request);
        return mutate(
          store,
          request.auth!.ownerId,
          meta,
          'timePoint.reorder',
          request.auth!.ownerId,
          body,
          () => store.reorderEvents(request.auth!.ownerId, body.ids),
        );
      });

      api.get('/time-points/:id/placements', async (request) => {
        const query = z
          .object({ cursor: z.string().max(512).optional(), limit: pageLimitSchema })
          .parse(request.query);
        const page =
          store instanceof PostgresStore
            ? await store.listPlacementsPage(
                request.auth!.ownerId,
                paramId(request),
                query.cursor,
                query.limit,
              )
            : paginateList(
                await store.listPlacements(request.auth!.ownerId, paramId(request)),
                query.cursor,
                query.limit,
              );
        return { items: page.items, nextCursor: page.nextCursor };
      });
      api.post('/placements', async (request, reply) => {
        const body = createPlacementSchema.parse(request.body);
        const meta = mutationMeta(request);
        const result = await mutate(
          store,
          request.auth!.ownerId,
          meta,
          'placement.create',
          meta.mutationId,
          body,
          () =>
            store.addPlacement(
              request.auth!.ownerId,
              body.taskId,
              body.timePointId,
              meta.mutationId,
            ),
        );
        return reply.code(result.existed ? 200 : 201).send(result.placement);
      });
      api.delete('/placements/:id', async (request, reply) => {
        const body = z
          .object({ baseVersion: z.number().int().positive() })
          .parse(request.body ?? {});
        const meta = mutationMeta(request);
        await mutate(
          store,
          request.auth!.ownerId,
          meta,
          'placement.remove',
          paramId(request),
          body,
          () => store.removePlacement(request.auth!.ownerId, paramId(request), body.baseVersion),
        );
        return reply.code(204).send();
      });
      api.post('/placements/:id/move', async (request) => {
        const body = placementTargetSchema
          .extend({ baseVersion: z.number().int().positive() })
          .parse(request.body);
        const meta = mutationMeta(request);
        return mutate(
          store,
          request.auth!.ownerId,
          meta,
          'placement.move',
          paramId(request),
          body,
          () =>
            store.movePlacement(
              request.auth!.ownerId,
              paramId(request),
              body.timePointId,
              body.baseVersion,
            ),
        );
      });
      api.post('/placements/:id/copy', async (request) => {
        const body = placementTargetSchema.parse(request.body);
        const meta = mutationMeta(request);
        return mutate(
          store,
          request.auth!.ownerId,
          meta,
          'placement.copy',
          paramId(request),
          body,
          () => store.copyPlacement(request.auth!.ownerId, paramId(request), body.timePointId),
        );
      });
      api.post('/time-points/:id/placements/reorder', async (request) => {
        const body = reorderSchema.parse(request.body);
        const meta = mutationMeta(request);
        return mutate(
          store,
          request.auth!.ownerId,
          meta,
          'placement.reorder',
          paramId(request),
          body,
          () => store.reorderPlacements(request.auth!.ownerId, paramId(request), body.ids),
        );
      });
      api.post('/dates/:localDate/rollover', async (request) => {
        const localDate = localDateSchema.parse(
          (request.params as { localDate: string }).localDate,
        );
        z.object({}).parse(request.body ?? {});
        const meta = mutationMeta(request);
        return mutate(
          store,
          request.auth!.ownerId,
          meta,
          'rollover.create',
          meta.mutationId,
          { localDate },
          () => store.rollover(request.auth!.ownerId, localDate),
        );
      });
      api.post('/rollovers/:operationId/undo', async (request) => {
        const meta = mutationMeta(request);
        const operationId = uuidSchema.parse(
          (request.params as { operationId?: string }).operationId,
        );
        z.object({}).parse(request.body ?? {});
        return mutate(store, request.auth!.ownerId, meta, 'rollover.undo', operationId, {}, () =>
          store.undoRollover(request.auth!.ownerId, operationId),
        );
      });

      api.get('/sync/snapshot', async (request) => store.syncSnapshot(request.auth!.ownerId));
      api.get('/sync/pull', async (request) => {
        const query = z
          .object({
            cursor: z.string().regex(/^\d+$/).default('0'),
            limit: z.coerce.number().int().min(1).max(500).default(500),
          })
          .parse(request.query);
        const result = await store.syncPull(request.auth!.ownerId, query.cursor, query.limit);
        return {
          changes: result.changes.map(changeDto),
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        };
      });
      api.get('/sync/status', async (request) => store.syncStatus(request.auth!.ownerId));
      api.post('/sync/push', async () => {
        throw new DomainError(
          'CLIENT_UPGRADE_REQUIRED',
          'v1 同步写入已关闭，请升级到 TaskDock v2 统一目录树同步协议',
        );
      });

      api.get('/ws', { websocket: true }, (socket, request) => {
        const tracked = trackWebSocket(socket, request);
        if (!tracked) return;
        let authenticated = false;
        let authenticating = false;
        let unsubscribe: (() => void) | undefined;
        const authTimeout = setTimeout(() => {
          if (!authenticated && socket.readyState === 1) socket.close(1008, 'AUTH_REQUIRED');
        }, 5_000);

        socket.on('message', (raw: unknown) => {
          if (authenticated || authenticating) {
            socket.close(1008, 'AUTH_REQUIRED');
            return;
          }
          authenticating = true;
          void (async () => {
            try {
              const message = JSON.parse(String(raw)) as {
                type?: unknown;
                accessToken?: unknown;
              };
              if (message.type !== 'auth' || typeof message.accessToken !== 'string')
                throw new DomainError('AUTH_REQUIRED', '需要登录');
              const session = await auth.verifyAccessToken(message.accessToken);
              authenticated = true;
              clearTimeout(authTimeout);
              unsubscribe = store.subscribeChanges((ownerId: string, cursor: string) => {
                if (ownerId === session.ownerId && socket.readyState === 1)
                  tracked.send({ type: 'sync.required', cursor });
              });
              if (socket.readyState === 1) tracked.send({ type: 'ready', protocolVersion: 1 });
            } catch {
              clearTimeout(authTimeout);
              if (socket.readyState === 1) socket.close(1008, 'AUTH_REQUIRED');
            }
          })();
        });
        socket.on('close', () => {
          clearTimeout(authTimeout);
          unsubscribe?.();
        });
      });
    },
    { prefix: '/api/v1' },
  );

  registerV2Routes(app, auth, treeStoreFor(store));

  if (webBuildAvailable) {
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split('?')[0] ?? request.url;
      const apiOrControlPath =
        pathname === '/api' ||
        pathname.startsWith('/api/') ||
        pathname === '/health' ||
        pathname.startsWith('/health/') ||
        pathname === '/version';
      if (apiOrControlPath || Boolean(extname(pathname))) {
        return reply
          .code(404)
          .type('application/json')
          .send({
            code: 'NOT_FOUND',
            message: '资源不存在',
            requestId: String(reply.getHeader('X-Request-Id') ?? request.id),
            details: null,
          });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, store, config };
}

function registerV2Routes(app: FastifyInstance, auth: AuthService, tree: V2TreeStore): void {
  app.register(
    async (api) => {
      api.addHook('preHandler', async (request) => {
        await requireAccessToken(auth)(request);
        if (request.auth) await tree.prepare?.(request.auth.ownerId);
      });

      api.get('/status', async (request) => ({
        serverVersion: '2.0.0',
        schemaVersion: 2,
        supportedApiVersions: [2],
        supportedSyncProtocols: [2],
        minClientVersion: '2.0.0',
        sync: await tree.status(request.auth!.ownerId),
      }));
      api.get(
        '/settings',
        async (request) => (await tree.snapshot(request.auth!.ownerId)).settings,
      );
      api.patch('/settings', async (request) => {
        const body = updateV2SettingsSchema.parse(request.body);
        const meta = mutationMeta(request);
        const { baseVersion, ...patch } = body;
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'settings.update',
          request.auth!.ownerId,
          baseVersion,
          patch,
        );
      });

      api.get('/tree/children', async (request) => {
        const query = z
          .object({
            parentFolderId: z.union([uuidSchema, z.literal('root')]).optional(),
            archived: z.enum(['true', 'false']).optional(),
          })
          .parse(request.query);
        return {
          items: tree.listTreeChildren(
            request.auth!.ownerId,
            query.parentFolderId === undefined || query.parentFolderId === 'root'
              ? null
              : query.parentFolderId,
            query.archived === 'true',
          ),
          parentFolderId: query.parentFolderId === 'root' ? null : (query.parentFolderId ?? null),
        };
      });
      api.get('/folders/:id', async (request) =>
        tree.getFolder(request.auth!.ownerId, paramId(request)),
      );
      api.get('/folders', async (request) => {
        const query = z
          .object({ archived: z.enum(['true', 'false']).optional() })
          .parse(request.query);
        return { items: tree.listFolders(request.auth!.ownerId, query.archived === 'true') };
      });
      api.get('/folders/:id/path', async (request) => ({
        items: tree.getFolderPath(request.auth!.ownerId, paramId(request)),
      }));

      api.get('/archive-operations', async (request) => {
        const query = z
          .object({ includeRestored: z.enum(['true', 'false']).optional() })
          .parse(request.query);
        return {
          items: tree.listArchiveOperations(
            request.auth!.ownerId,
            query.includeRestored === 'true',
          ),
        };
      });
      api.get('/archive-operations/:id', async (request) =>
        tree.getArchiveOperation(request.auth!.ownerId, paramId(request)),
      );

      api.post('/folders', async (request, reply) => {
        const body = createFolderSchema.parse(request.body);
        const meta = mutationMeta(request);
        const entityId = body.id ?? meta.mutationId;
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'folder.create',
          entityId,
          null,
          {
            parentFolderId: body.parentFolderId,
            title: body.title,
          },
        );
        return reply.code(201).send(result);
      });
      api.patch('/folders/:id', async (request) => {
        const body = updateFolderSchema.parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'folder.update',
          paramId(request),
          body.baseVersion,
          { title: body.title },
        );
      });
      api.post('/tree/items/move', async (request) => {
        const body = treeMoveSchema.parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'tree.move',
          body.item.id,
          body.baseVersion,
          body,
        );
      });
      api.post('/folders/:id/archive-tree', async (request) => {
        const body = z
          .object({ baseVersion: z.number().int().positive(), operationId: uuidSchema.optional() })
          .parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'folder.archiveTree',
          paramId(request),
          body.baseVersion,
          { operationId: body.operationId },
        );
      });
      api.post('/folders/:id/restore-tree', async (request) => {
        const body = z.object({ operationId: uuidSchema }).parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'folder.restoreTree',
          paramId(request),
          null,
          body,
        );
      });
      api.post('/folders/:id/delete-preview', async (request) => {
        z.object({}).parse(request.body ?? {});
        return tree.previewDelete(request.auth!.ownerId, paramId(request));
      });
      api.delete('/folders/:id/tree', async (request) => {
        const body = z.object({ confirmationToken: z.string().min(1) }).parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'folder.deleteTree',
          paramId(request),
          null,
          body,
        );
      });

      api.get('/tasks', async (request) => {
        const query = z
          .object({
            archived: z.enum(['true', 'false']).optional(),
            q: z.string().trim().max(500).optional(),
          })
          .parse(request.query);
        return {
          items: tree.listTasks(request.auth!.ownerId, query.archived === 'true', query.q),
          nextCursor: null,
        };
      });
      api.post('/tasks', async (request, reply) => {
        const body = z
          .object({
            id: uuidSchema.optional(),
            parentFolderId: uuidSchema.nullable().default(null),
            title: z.string().trim().min(1).max(500),
          })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'task.create',
          body.id ?? meta.mutationId,
          null,
          { parentFolderId: body.parentFolderId, title: body.title },
        );
        return reply.code(201).send(result);
      });
      api.get('/tasks/:id', async (request) =>
        tree.getTaskDetails(request.auth!.ownerId, paramId(request)),
      );
      api.patch('/tasks/:id', async (request) => {
        const body = z
          .object({
            title: z.string().trim().min(1).max(500).optional(),
            status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
            baseVersion: z.number().int().positive(),
          })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        const { baseVersion, ...patch } = body;
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'task.update',
          paramId(request),
          baseVersion,
          patch,
        );
      });
      api.patch('/tasks/:id/note', async (request) => {
        const body = z
          .object({
            contentMarkdown: z.string().max(1024 * 1024),
            baseVersion: z.number().int().positive(),
          })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'note.update',
          paramId(request),
          body.baseVersion,
          { taskId: paramId(request), contentMarkdown: body.contentMarkdown },
        );
      });
      api.post('/tasks/:id/archive', async (request) => {
        const body = z
          .object({ baseVersion: z.number().int().positive() })
          .parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'task.archive',
          paramId(request),
          body.baseVersion,
          {},
        );
      });
      api.post('/tasks/:id/restore', async (request) => {
        const body = z
          .object({ baseVersion: z.number().int().positive() })
          .parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'task.restore',
          paramId(request),
          body.baseVersion,
          {},
        );
      });
      api.delete('/tasks/:id', async (request) => {
        const body = z
          .object({ baseVersion: z.number().int().positive() })
          .strict()
          .parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'task.delete',
          paramId(request),
          body.baseVersion,
          {},
        );
      });
      api.post('/tasks/:id/duplicate', async (request, reply) => {
        const meta = mutationMeta(request);
        const body = z
          .object({
            taskId: uuidSchema.optional(),
            noteId: uuidSchema.optional(),
            stepIds: z.array(uuidSchema).optional(),
          })
          .strict()
          .parse(request.body ?? {});
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'task.duplicate',
          paramId(request),
          null,
          body,
        );
        return reply.code(201).send(result);
      });

      api.get('/time-points', async (request) => {
        const query = z
          .object({
            type: z.enum(['DATE', 'EVENT']).optional(),
            archived: z.enum(['true', 'false']).optional(),
          })
          .parse(request.query);
        return {
          items: tree.listTimePoints(
            request.auth!.ownerId,
            query.type,
            query.archived === undefined ? undefined : query.archived === 'true',
          ),
        };
      });
      api.get('/time-points/placement-counts', async (request) => {
        const query = z
          .object({
            type: z.enum(['DATE', 'EVENT']).optional(),
            from: localDateSchema.optional(),
            to: localDateSchema.optional(),
            archived: z.enum(['true', 'false']).optional(),
          })
          .parse(request.query);
        const points = tree
          .listTimePoints(
            request.auth!.ownerId,
            query.type,
            query.archived === undefined ? false : query.archived === 'true',
          )
          .filter(
            (point) =>
              !point.localDate ||
              ((!query.from || point.localDate >= query.from) &&
                (!query.to || point.localDate <= query.to)),
          );
        return {
          items: points.map((point) => {
            const placements = tree.listPlacements(request.auth!.ownerId, point.id);
            const doneCount = placements.filter(
              (placement) => placement.task.status === 'DONE',
            ).length;
            return {
              timePointId: point.id,
              localDate: point.localDate,
              totalCount: placements.length,
              openCount: placements.length - doneCount,
              doneCount,
            };
          }),
        };
      });
      api.post('/time-points/date', async (request, reply) => {
        const body = z
          .object({ id: uuidSchema.optional(), localDate: localDateSchema })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'timePoint.date.create',
          body.id ?? meta.mutationId,
          null,
          { localDate: body.localDate },
        );
        return reply.code(201).send(result);
      });
      api.post('/time-points/events', async (request, reply) => {
        const body = z
          .object({ id: uuidSchema.optional(), title: z.string().trim().min(1).max(200) })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'timePoint.event.create',
          body.id ?? meta.mutationId,
          null,
          { title: body.title },
        );
        return reply.code(201).send(result);
      });
      api.post('/time-points/events/reorder', async (request) => {
        const body = z
          .object({ ids: z.array(uuidSchema).max(1000) })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'timePoint.reorder',
          meta.mutationId,
          null,
          { ids: body.ids },
        );
      });
      api.get('/time-points/:id', async (request) =>
        tree.getTimePoint(request.auth!.ownerId, paramId(request)),
      );
      api.patch('/time-points/:id', async (request) => {
        const body = updateTimePointSchema.parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'timePoint.update',
          paramId(request),
          body.baseVersion,
          { title: body.title },
        );
      });
      api.post('/time-points/:id/reach', async (request) =>
        versionedV2Action(tree, request, 'timePoint.reach'),
      );
      api.post('/time-points/:id/archive', async (request) =>
        versionedV2Action(tree, request, 'timePoint.archive'),
      );
      api.post('/time-points/:id/restore', async (request) =>
        versionedV2Action(tree, request, 'timePoint.restore'),
      );
      api.get('/time-points/:id/placements', async (request) => ({
        items: tree.listPlacements(request.auth!.ownerId, paramId(request)),
      }));
      api.post('/placements', async (request, reply) => {
        const body = z
          .object({ id: uuidSchema.optional(), taskId: uuidSchema, timePointId: uuidSchema })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'placement.create',
          body.id ?? meta.mutationId,
          null,
          body,
        );
        return reply.code(201).send(result);
      });
      api.delete('/placements/:id', async (request) => {
        const body = z
          .object({ baseVersion: z.number().int().positive() })
          .parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'placement.remove',
          paramId(request),
          body.baseVersion,
          {},
        );
      });
      api.post('/placements/:id/move', async (request) => {
        const body = z
          .object({
            timePointId: uuidSchema,
            targetPlacementId: uuidSchema.optional(),
            baseVersion: z.number().int().positive(),
          })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'placement.move',
          paramId(request),
          body.baseVersion,
          body,
        );
      });
      api.post('/placements/:id/copy', async (request) => {
        const body = z
          .object({ timePointId: uuidSchema, targetPlacementId: uuidSchema.optional() })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'placement.copy',
          paramId(request),
          null,
          body,
        );
      });
      api.post('/time-points/:id/placements/reorder', async (request) => {
        const body = z
          .object({ ids: z.array(uuidSchema).max(1000) })
          .strict()
          .parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'placement.reorder',
          paramId(request),
          null,
          { timePointId: paramId(request), ids: body.ids },
        );
      });

      api.post('/dates/:localDate/rollover', async (request) => {
        const localDate = localDateSchema.parse(
          (request.params as { localDate: string }).localDate,
        );
        z.object({}).parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'rollover.create',
          meta.mutationId,
          null,
          { localDate },
        );
      });
      api.post('/rollovers/undo', async (request) => {
        const body = z
          .object({ placementIds: z.array(uuidSchema).max(1000) })
          .strict()
          .parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'rollover.undo',
          meta.mutationId,
          null,
          body,
        );
      });

      api.get('/tasks/:taskId/steps', async (request) => ({
        steps: tree.getTaskDetails(
          request.auth!.ownerId,
          uuidSchema.parse((request.params as { taskId: string }).taskId),
        ).steps,
      }));
      api.post('/tasks/:taskId/steps', async (request, reply) => {
        const body = createStepSchema.parse(request.body);
        const meta = mutationMeta(request);
        const taskId = uuidSchema.parse((request.params as { taskId: string }).taskId);
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'taskStep.create',
          body.id ?? meta.mutationId,
          null,
          { taskId, title: body.title, noteMarkdown: body.noteMarkdown },
        );
        return reply.code(201).send(result);
      });
      api.patch('/task-steps/:id', async (request) => {
        const body = updateStepSchema.parse(request.body);
        const meta = mutationMeta(request);
        const { baseVersion, ...patch } = body;
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'taskStep.update',
          paramId(request),
          baseVersion,
          patch,
        );
      });
      api.post('/task-steps/:id/move', async (request) => {
        const body = stepMoveSchema.parse(request.body);
        const meta = mutationMeta(request);
        const { baseVersion, ...patch } = body;
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'taskStep.move',
          paramId(request),
          baseVersion,
          patch,
        );
      });
      api.delete('/task-steps/:id', async (request) => {
        const body = z
          .object({ baseVersion: z.number().int().positive() })
          .parse(request.body ?? {});
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'taskStep.delete',
          paramId(request),
          body.baseVersion,
          {},
        );
      });

      api.get('/workflows', async (request) => {
        const query = z
          .object({ includeArchived: z.enum(['true', 'false']).optional() })
          .parse(request.query);
        return {
          items: tree.listWorkflows(request.auth!.ownerId, query.includeArchived === 'true'),
        };
      });
      api.post('/workflows', async (request, reply) => {
        const body = createWorkflowSchema.parse(request.body);
        const meta = mutationMeta(request);
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'workflow.create',
          body.id ?? meta.mutationId,
          null,
          { name: body.name, defaultStageId: body.defaultStageId },
        );
        return reply.code(201).send(result);
      });
      api.get('/workflows/:id', async (request) =>
        tree.getWorkflow(request.auth!.ownerId, paramId(request)),
      );
      api.patch('/workflows/:id', async (request) => {
        const body = updateWorkflowSchema.parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'workflow.update',
          paramId(request),
          body.baseVersion,
          { name: body.name },
        );
      });
      api.post('/workflows/:id/archive', async (request) =>
        versionedV2Action(tree, request, 'workflow.archive'),
      );
      api.post('/workflows/:id/restore', async (request) =>
        versionedV2Action(tree, request, 'workflow.restore'),
      );
      api.delete('/workflows/:id', async (request) =>
        versionedV2Action(tree, request, 'workflow.delete'),
      );
      api.post('/workflows/:id/stages', async (request, reply) => {
        const body = createWorkflowStageSchema.parse(request.body);
        const meta = mutationMeta(request);
        const workflowId = paramId(request);
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'workflowStage.create',
          body.id ?? meta.mutationId,
          null,
          { workflowId, name: body.name },
        );
        return reply.code(201).send(result);
      });
      api.patch('/workflow-stages/:id', async (request) => {
        const body = updateWorkflowStageSchema.parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'workflowStage.update',
          paramId(request),
          body.baseVersion,
          { name: body.name },
        );
      });
      api.post('/workflow-stages/:id/move', async (request) => {
        const body = moveWorkflowStageSchema.parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'workflowStage.move',
          paramId(request),
          body.baseVersion,
          { beforeId: body.beforeId, afterId: body.afterId },
        );
      });
      api.delete('/workflow-stages/:id', async (request) =>
        versionedV2Action(tree, request, 'workflowStage.delete'),
      );
      api.post('/workflow-stages/:id/tasks', async (request, reply) => {
        const body = addWorkflowTaskSchema.parse(request.body);
        const meta = mutationMeta(request);
        const stageId = paramId(request);
        const workflow = tree
          .listWorkflows(request.auth!.ownerId)
          .find((candidate) => candidate.stages?.some((stage) => stage.id === stageId));
        if (!workflow) throw new DomainError('ENTITY_NOT_FOUND', '流程阶段不存在');
        const result = await runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'workflowTask.add',
          meta.mutationId,
          null,
          { workflowId: workflow.id, stageId, taskId: body.taskId },
        );
        return reply.code(201).send(result);
      });
      api.post('/workflow-memberships/:id/move', async (request) => {
        const body = moveWorkflowMembershipSchema.parse(request.body);
        const meta = mutationMeta(request);
        return runV2Mutation(
          tree,
          request.auth!.ownerId,
          meta,
          'workflowTask.move',
          paramId(request),
          body.baseVersion,
          { stageId: body.stageId, beforeId: body.beforeId, afterId: body.afterId },
        );
      });
      api.delete('/workflow-memberships/:id', async (request) =>
        versionedV2Action(tree, request, 'workflowTask.remove'),
      );

      api.get('/sync/snapshot', async (request) => tree.snapshot(request.auth!.ownerId));
      api.get('/sync/pull', async (request) => {
        const query = z
          .object({
            cursor: z.string().regex(/^\d+$/).default('0'),
            limit: z.coerce.number().int().min(1).max(500).default(500),
          })
          .parse(request.query);
        const result = await tree.pull(request.auth!.ownerId, query.cursor, query.limit);
        return {
          changes: result.changes.map(changeDto),
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          protocolVersion: 2,
        };
      });
      api.get('/sync/status', async (request) => await tree.status(request.auth!.ownerId));
      api.post('/sync/push', async (request) => {
        const raw = request.body as { protocolVersion?: unknown };
        if (raw?.protocolVersion !== 2)
          throw new DomainError('SYNC_PROTOCOL_UNSUPPORTED', '只支持同步协议 v2');
        const body = v2PushSchema.parse(request.body);
        const results: unknown[] = [];
        for (const mutation of body.mutations) {
          try {
            const result = await tree.applyMutationIdempotent(
              request.auth!.ownerId,
              body.clientId,
              mutation,
            );
            results.push({
              mutationId: mutation.mutationId,
              status: 'applied',
              replayed: result.replayed,
              result: result.result,
            });
          } catch (error) {
            const domain =
              error instanceof DomainError
                ? error
                : new DomainError('MUTATION_REJECTED', 'mutation 被拒绝');
            results.push({
              mutationId: mutation.mutationId,
              status: domain.code === 'VERSION_CONFLICT' ? 'conflict' : 'rejected',
              error: { code: domain.code, message: domain.message, details: domain.details },
            });
          }
        }
        return { protocolVersion: 2, results };
      });
      api.get('/ws', { websocket: true }, (socket, request) => {
        const tracked = trackWebSocket(socket, request);
        if (!tracked) return;
        let authenticated = false;
        let authenticating = false;
        let unsubscribe: (() => void) | undefined;
        const authTimeout = setTimeout(() => {
          if (!authenticated && socket.readyState === 1) socket.close(1008, 'AUTH_REQUIRED');
        }, 5_000);
        socket.on('message', (raw: unknown) => {
          if (authenticated || authenticating) {
            socket.close(1008, 'AUTH_REQUIRED');
            return;
          }
          authenticating = true;
          void (async () => {
            try {
              const message = JSON.parse(String(raw)) as { type?: unknown; accessToken?: unknown };
              if (message.type !== 'auth' || typeof message.accessToken !== 'string')
                throw new DomainError('AUTH_REQUIRED', '需要登录');
              const session = await auth.verifyAccessToken(message.accessToken);
              authenticated = true;
              clearTimeout(authTimeout);
              unsubscribe = tree.subscribeChanges?.((ownerId, cursor) => {
                if (ownerId === session.ownerId && socket.readyState === 1)
                  tracked.send({ type: 'sync.required', cursor });
              });
              if (socket.readyState === 1) tracked.send({ type: 'ready', protocolVersion: 2 });
            } catch {
              clearTimeout(authTimeout);
              if (socket.readyState === 1) socket.close(1008, 'AUTH_REQUIRED');
            }
          })();
        });
        socket.on('close', () => {
          clearTimeout(authTimeout);
          unsubscribe?.();
        });
      });
    },
    { prefix: '/api/v2' },
  );
}

function trackWebSocket(
  socket: HubWebSocket,
  request: FastifyRequest,
): { send: (message: Record<string, unknown>) => boolean } | null {
  const origin = request.headers.origin ?? '(none)';
  const key = `${request.ip}|${origin}`;
  const current = websocketConnections.get(key) ?? 0;
  if (current >= websocketMaxPerOriginAndIp) {
    socket.close(1013, 'RATE_LIMITED');
    return null;
  }
  websocketConnections.set(key, current + 1);

  let released = false;
  let alive = true;
  const release = (): void => {
    if (released) return;
    released = true;
    const next = (websocketConnections.get(key) ?? 1) - 1;
    if (next > 0) websocketConnections.set(key, next);
    else websocketConnections.delete(key);
  };
  const heartbeat = setInterval(() => {
    if (socket.readyState !== 1) {
      release();
      return;
    }
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 30_000);
  heartbeat.unref?.();
  socket.on('pong', () => {
    alive = true;
  });
  socket.on('message', () => {
    alive = true;
  });
  socket.on('close', () => {
    clearInterval(heartbeat);
    release();
  });
  socket.on('error', () => {
    clearInterval(heartbeat);
    release();
  });

  return {
    send(message) {
      if (socket.readyState !== 1 || socket.bufferedAmount > websocketMaxBufferedBytes) {
        if (socket.readyState === 1) socket.close(1013, 'BACKPRESSURE');
        return false;
      }
      try {
        socket.send(JSON.stringify(message), (error?: Error) => {
          if (error && socket.readyState === 1) socket.terminate();
        });
        return true;
      } catch {
        if (socket.readyState === 1) socket.terminate();
        return false;
      }
    },
  };
}

async function runV2Mutation(
  tree: V2TreeStore,
  ownerId: string,
  meta: MutationMeta,
  command: string,
  entityId: string,
  baseVersion: number | null,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const mutation = v2MutationSchema.parse({
    mutationId: meta.mutationId,
    command,
    entityId,
    baseVersion,
    occurredAt: new Date().toISOString(),
    payload,
  });
  const result = await tree.applyMutationIdempotent(ownerId, meta.clientId, mutation);
  return result.result;
}

async function versionedV2Action(
  tree: V2TreeStore,
  request: FastifyRequest,
  command: string,
): Promise<unknown> {
  const body = z.object({ baseVersion: z.number().int().positive() }).parse(request.body ?? {});
  const meta = mutationMeta(request);
  return runV2Mutation(
    tree,
    request.auth!.ownerId,
    meta,
    command,
    paramId(request),
    body.baseVersion,
    {},
  );
}

async function createStore(config: AppConfig): Promise<Store> {
  if (config.devMemoryStore || !config.databaseUrl) return new MemoryStore();
  const pool = createPool(config.databaseUrl, {
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    idleTimeoutMillis: config.dbIdleTimeoutMs,
    queryTimeoutMillis: config.dbQueryTimeoutMs,
    statementTimeoutMillis: config.dbStatementTimeoutMs,
    lockTimeoutMillis: config.dbLockTimeoutMs,
  });
  return new PostgresStore(pool, {
    changeRetentionDays: config.syncChangeRetentionDays,
    mutationReceiptRetentionDays: config.mutationReceiptRetentionDays,
    transactionTimeoutMs: config.dbStatementTimeoutMs,
  });
}

function validateRuntimeConfig(config: AppConfig): void {
  const boundedTimeouts = [
    config.dbConnectionTimeoutMs,
    config.dbIdleTimeoutMs,
    config.dbQueryTimeoutMs,
    config.dbStatementTimeoutMs,
    config.dbLockTimeoutMs,
    config.httpRequestTimeoutMs,
    config.httpConnectionTimeoutMs,
  ];
  if (
    !Number.isInteger(config.syncChangeRetentionDays) ||
    config.syncChangeRetentionDays < 1 ||
    !Number.isInteger(config.mutationReceiptRetentionDays) ||
    config.mutationReceiptRetentionDays < 1 ||
    !Number.isInteger(config.dbConnectionTimeoutMs) ||
    config.dbConnectionTimeoutMs < 1 ||
    !Number.isInteger(config.dbIdleTimeoutMs) ||
    config.dbIdleTimeoutMs < 1 ||
    !Number.isInteger(config.dbQueryTimeoutMs) ||
    config.dbQueryTimeoutMs < 1 ||
    !Number.isInteger(config.dbStatementTimeoutMs) ||
    config.dbStatementTimeoutMs < 1 ||
    !Number.isInteger(config.dbLockTimeoutMs) ||
    config.dbLockTimeoutMs < 1 ||
    !Number.isInteger(config.httpRequestTimeoutMs) ||
    config.httpRequestTimeoutMs < 1 ||
    !Number.isInteger(config.httpConnectionTimeoutMs) ||
    config.httpConnectionTimeoutMs < 1 ||
    boundedTimeouts.some((value) => value > 120_000)
  )
    throw new Error('retention windows and timeout values must be integers between 1 and 120000');
  if (config.nodeEnv !== 'production') return;
  const insecureMarkers = ['change-me', 'local-access-secret', 'local-refresh-pepper'];
  if (
    config.devMemoryStore ||
    !config.databaseUrl ||
    config.bootstrapToken.length < 32 ||
    config.accessTokenSecret.length < 32 ||
    config.refreshTokenPepper.length < 32 ||
    insecureMarkers.some(
      (marker) =>
        config.bootstrapToken.includes(marker) ||
        config.accessTokenSecret.includes(marker) ||
        config.refreshTokenPepper.includes(marker),
    )
  )
    throw new Error('production requires PostgreSQL and non-default token secrets');
  let origin: URL;
  try {
    origin = new URL(config.appOrigin);
  } catch {
    throw new Error('APP_ORIGIN must be an absolute HTTP or HTTPS origin in production');
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:')
    throw new Error('APP_ORIGIN must be an absolute HTTP or HTTPS origin in production');
  if (
    config.corsAllowedOrigins.some((allowedOrigin) => {
      try {
        const parsed = new URL(allowedOrigin);
        return parsed.protocol !== 'http:' && parsed.protocol !== 'https:';
      } catch {
        return true;
      }
    })
  )
    throw new Error(
      'CORS_ALLOWED_ORIGINS must contain absolute HTTP or HTTPS origins in production',
    );
  if (
    config.nativeAllowedOrigins.some((allowedOrigin) => {
      try {
        const parsed = new URL(allowedOrigin);
        return !(
          ((parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
            parsed.hostname === 'localhost') ||
          (parsed.protocol === 'devtodo:' && parsed.hostname === 'app') ||
          (parsed.protocol === 'capacitor:' && parsed.hostname === 'localhost')
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('NATIVE_ALLOWED_ORIGINS must contain controlled native origins');
}

function parseTrustProxy(
  value: string,
): boolean | string | string[] | ((address: string, hop: number) => boolean) {
  const normalized = value.trim();
  if (normalized === 'true') return true;
  if (normalized === 'false' || normalized === '0') return false;
  if (/^\d+$/.test(normalized)) {
    const hops = Number(normalized);
    return (_address, hop) => hop < hops;
  }
  const addresses = normalized
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (!addresses.length || addresses.some((candidate) => candidate === '*'))
    throw new Error('TRUST_PROXY must be 0, a proxy hop count, or an explicit address list');
  return addresses;
}

class AuthRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  check(
    request: FastifyRequest,
    scope: string,
    username: string | undefined,
    limit: number,
    windowMs: number,
  ): void {
    const now = Date.now();
    const normalizedUsername = username?.trim().toLocaleLowerCase('en-US') ?? '';
    const key = `${scope}:${request.ip}:${normalizedUsername}`;
    const existing = this.buckets.get(key);
    const bucket =
      existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + windowMs };
    if (bucket.count >= limit) {
      throw new DomainError('RATE_LIMITED', '请求过于频繁，请稍后重试', {
        retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
      });
    }
    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10_000) {
      for (const [candidateKey, candidate] of this.buckets)
        if (candidate.resetAt <= now) this.buckets.delete(candidateKey);
    }
  }
}

function requireAccessToken(auth: AuthService) {
  return async (request: FastifyRequest): Promise<void> => {
    if (isPublicRoute(request)) return;
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    request.auth = await auth.verifyAccessToken(token ?? '');
  };
}

const publicApiRoutes = new Set([
  '/bootstrap/status',
  '/bootstrap',
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/auth/native/challenge',
  '/ws',
]);

const publicWebSocketRoutes = new Set(['/api/v1/ws', '/api/v2/ws']);

function isPublicRoute(request: FastifyRequest): boolean {
  const declaredPath = request.routeOptions.url?.split('?')[0];
  const requestPath = request.url.split('?')[0] ?? '';
  return (
    (declaredPath !== undefined && publicApiRoutes.has(declaredPath)) ||
    publicWebSocketRoutes.has(requestPath) ||
    [...publicApiRoutes].some((path) => requestPath.endsWith(`/api/v1${path}`))
  );
}

async function mutate<T>(
  store: Store,
  ownerId: string,
  meta: MutationMeta,
  command: string,
  entityId: string,
  payload: unknown,
  action: () => T | Promise<T>,
): Promise<T> {
  const result = await store.withMutation(async () =>
    store.withIdempotency(
      ownerId,
      meta.clientId,
      meta.mutationId,
      { command, entityId, payload },
      action,
    ),
  );
  return result.result;
}

async function actionVersioned<T>(
  store: Store,
  request: FastifyRequest,
  command: string,
  action: (id: string, ownerId: string, version: number) => T | Promise<T>,
): Promise<T> {
  const body = z.object({ baseVersion: z.number().int().positive() }).parse(request.body ?? {});
  const meta = mutationMeta(request);
  const id = paramId(request);
  return mutate(store, request.auth!.ownerId, meta, command, id, body, () =>
    action(id, request.auth!.ownerId, body.baseVersion),
  );
}

interface MutationMeta {
  clientId: string;
  mutationId: string;
}
function mutationMeta(request: FastifyRequest): MutationMeta {
  const mutationId = uuidSchema.parse(request.headers['idempotency-key']);
  const clientId = uuidSchema.parse(request.headers['x-client-id']);
  return { mutationId, clientId };
}
function paramId(request: FastifyRequest): string {
  return uuidSchema.parse((request.params as { id?: string }).id);
}
function enumQuery<T extends string>(
  value: string | undefined,
  values: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) throw new DomainError('VALIDATION_FAILED', '查询枚举值无效');
  return value as T;
}
function changeDto(change: {
  seq: bigint;
  entityType: string;
  entityId: string;
  entityVersion: number;
  operation: string;
  snapshot: unknown;
  committedAt: string;
}): Record<string, unknown> {
  return {
    seq: change.seq.toString(),
    entityType: change.entityType,
    entityId: change.entityId,
    entityVersion: change.entityVersion,
    operation: change.operation,
    snapshot: change.snapshot,
    committedAt: change.committedAt,
  };
}
function sendError(
  reply: FastifyReply,
  code: ErrorCode,
  message: string,
  requestId: string,
  details: unknown,
  statusCode: number,
): FastifyReply {
  return reply.code(statusCode).send({ code, message, requestId, details });
}
function statusFor(code: string): number {
  if (
    code === 'AUTH_REQUIRED' ||
    code === 'AUTH_INVALID_CREDENTIALS' ||
    code === 'AUTH_SESSION_REVOKED'
  )
    return 401;
  if (code === 'VERSION_CONFLICT') return 409;
  if (
    code === 'TREE_CYCLE' ||
    code === 'PARENT_NOT_FOLDER' ||
    code === 'TARGET_ARCHIVED' ||
    code === 'ANCESTOR_ARCHIVED' ||
    code === 'SUBTREE_CHANGED' ||
    code === 'WORKFLOW_TASK_ALREADY_EXISTS' ||
    code === 'STAGE_WORKFLOW_MISMATCH' ||
    code === 'CLIENT_UPGRADE_REQUIRED' ||
    code === 'MUTATION_REJECTED'
  )
    return 409;
  if (code === 'SYNC_CURSOR_EXPIRED') return 410;
  if (code === 'DELETE_CONFIRMATION_REQUIRED') return 410;
  if (code === 'ENTITY_NOT_FOUND') return 404;
  if (code === 'ENTITY_ARCHIVED') return 410;
  if (code === 'BOOTSTRAP_ALREADY_COMPLETED' || code === 'PLACEMENT_ALREADY_EXISTS') return 409;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'INTERNAL_ERROR') return 500;
  return 400;
}
function cryptoUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 15) | 112;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function validRequestId(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && uuidSchema.safeParse(candidate).success ? candidate : undefined;
}
function nativeClient(request: FastifyRequest, config: AppConfig): boolean {
  const origin = requestOrigin(request);
  const fetchSite = request.headers['sec-fetch-site'];
  const normalizedFetchSite = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;
  return (
    origin !== undefined &&
    (config.nativeAllowedOrigins.includes(origin) || origin === 'http://localhost') &&
    normalizedFetchSite !== 'same-origin'
  );
}

function requestOrigin(request: FastifyRequest): string | undefined {
  const origin = Array.isArray(request.headers.origin)
    ? request.headers.origin[0]
    : request.headers.origin;
  return origin;
}

function redactSensitiveUrl(value: string): string {
  try {
    const url = new URL(value, 'http://devtodo.invalid');
    for (const key of ['accessToken', 'refreshToken', 'token', 'ticket']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '[REDACTED_URL]';
  }
}

async function requireNativeExchange(
  request: FastifyRequest,
  config: AppConfig,
  store: Store,
  challenge: string | undefined,
): Promise<boolean> {
  if (!nativeClient(request, config)) return false;
  if (!challenge) throw new DomainError('AUTH_REQUIRED', '原生客户端缺少一次性挑战');
  const origin = requestOrigin(request)!;
  if (!(await store.consumeNativeChallenge(challenge, origin)))
    throw new DomainError('AUTH_REQUIRED', '原生客户端挑战无效或已过期');
  return true;
}

function refreshCookieShouldBeSecure(config: AppConfig): boolean {
  return new URL(config.appOrigin).protocol === 'https:';
}

function protocolForOrigin(value: string): 'http:' | 'https:' {
  try {
    return new URL(value).protocol === 'https:' ? 'https:' : 'http:';
  } catch {
    // Runtime validation reports malformed production origins. Development
    // keeps the safe HTTP behavior so a bad local value cannot add an HTTPS
    // upgrade that makes the SPA shell disappear.
    return 'http:';
  }
}

function setRefreshCookie(reply: FastifyReply, value: string, config: AppConfig): void {
  reply.setCookie('devtodo_refresh', value, {
    httpOnly: true,
    secure: refreshCookieShouldBeSecure(config),
    sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: 100 * 365 * 86_400,
  });
}
function clearRefreshCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie('devtodo_refresh', {
    httpOnly: true,
    secure: refreshCookieShouldBeSecure(config),
    sameSite: 'lax',
    path: '/api/v1/auth',
  });
}
interface ListCursorKey {
  group: 'rank' | 'date' | 'event';
  value: string;
  id: string;
}

interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
}

function paginateList<T extends { id: string }>(
  items: T[],
  cursor: string | undefined,
  limit: number,
  keyFor: (item: T) => ListCursorKey = (item) => ({
    group: 'rank',
    value: (item as T & { rank: string }).rank,
    id: item.id,
  }),
): ListPage<T> {
  const ordered = [...items].sort((left, right) =>
    compareListCursorKeys(keyFor(left), keyFor(right)),
  );
  const after = cursor ? decodeListCursor(cursor) : null;
  const start = after
    ? ordered.findIndex((item) => compareListCursorKeys(keyFor(item), after) > 0)
    : 0;
  const offset = start < 0 ? ordered.length : start;
  const page = ordered.slice(offset, offset + limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor:
      last && offset + page.length < ordered.length ? encodeListCursor(keyFor(last)) : null,
  };
}

function compareListCursorKeys(left: ListCursorKey, right: ListCursorKey): number {
  const groupOrder = { date: 0, event: 1, rank: 2 } as const;
  if (groupOrder[left.group] !== groupOrder[right.group])
    return groupOrder[left.group] - groupOrder[right.group];
  if (left.group === 'rank' || left.group === 'event') {
    const leftRank = BigInt(left.value);
    const rightRank = BigInt(right.value);
    if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  } else {
    const valueOrder = left.value.localeCompare(right.value);
    if (valueOrder !== 0) return valueOrder;
  }
  return left.id.localeCompare(right.id);
}

function encodeListCursor(key: ListCursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeListCursor(value: string): ListCursorKey {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      group?: unknown;
      value?: unknown;
      id?: unknown;
    };
    if (
      (parsed.group !== 'rank' && parsed.group !== 'date' && parsed.group !== 'event') ||
      typeof parsed.value !== 'string' ||
      typeof parsed.id !== 'string' ||
      !uuidSchema.safeParse(parsed.id).success ||
      (parsed.group === 'date'
        ? !/^\d{4}-\d{2}-\d{2}$/.test(parsed.value)
        : !/^\d+$/.test(parsed.value))
    )
      throw new Error('invalid list cursor');
    return { group: parsed.group, value: parsed.value, id: parsed.id };
  } catch {
    throw new DomainError('VALIDATION_FAILED', '列表游标无效');
  }
}
