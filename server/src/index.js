const config = require('./config');
const logger = require('./lib/logger');
const app = require('./app');
const prisma = require('./prismaClient');
const { storage } = require('./lib/storage');
const { startOrphanSweeper } = require('./lib/orphanSweeper');

async function start() {
  await storage.init();

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, storage: storage.name },
      'QuickCheckIn API listening'
    );
  });

  const stopSweeper = startOrphanSweeper();

  // Containers are stopped with SIGTERM and given a grace period. Closing the
  // listener first lets in-flight requests finish; without this, a deploy can
  // drop a guest's submission halfway through writing it.
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    stopSweeper();

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out, exiting');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        logger.error({ err: err.message }, 'Error disconnecting from database');
      }
      clearTimeout(forceExit);
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crash that leaves the process in an unknown state should end it, so the
  // orchestrator can replace it with a clean one.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason: String(reason) }, 'Unhandled rejection');
    shutdown('unhandledRejection');
  });
}

start().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Failed to start server');
  process.exit(1);
});
