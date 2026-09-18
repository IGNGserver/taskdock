import { buildServer } from './server.js';

let app: Awaited<ReturnType<typeof buildServer>>['app'] | undefined;
let store: Awaited<ReturnType<typeof buildServer>>['store'] | undefined;
let shutdownPromise: Promise<void> | undefined;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    app?.log.info({ signal, exitCode }, 'shutting down');
    try {
      await app?.close();
    } finally {
      await store?.close();
    }
    if (exitCode !== 0) process.exitCode = exitCode;
  })();
  return shutdownPromise;
}

function fatal(event: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (app) app.log.fatal({ event, err: error }, 'fatal process error');
  else console.error(JSON.stringify({ event, message }));
  void shutdown(event, 1).catch((shutdownError: unknown) => {
    console.error(
      JSON.stringify({
        event: 'api.shutdown_failed',
        message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
      }),
    );
    process.exitCode = 1;
  });
}

process.once('uncaughtException', (error) => fatal('uncaughtException', error));
process.once('unhandledRejection', (error) => fatal('unhandledRejection', error));
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

void (async () => {
  const built = await buildServer();
  app = built.app;
  store = built.store;
  await app.listen({ host: '0.0.0.0', port: built.config.appPort });
  // Keep Node's raw HTTP server limits explicit as well as Fastify's request
  // option, so a bare-node deployment has the same bounded socket behavior.
  app.server.requestTimeout = built.config.httpRequestTimeoutMs;
  app.server.headersTimeout = Math.min(built.config.httpRequestTimeoutMs + 1_000, 120_000);
  app.server.keepAliveTimeout = 5_000;
})().catch((error: unknown) => fatal('startup_failed', error));
