import { buildServer } from './server.js';

const { app, store, config } = await buildServer();
await app.listen({ host: '0.0.0.0', port: config.appPort });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await store.close();
};
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
