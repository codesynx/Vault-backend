import { config } from './config/index.js';
import { buildApp } from './app.js';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';
import { initializeTdlib } from './lib/tdlib/client.js';
import { tdlibManager } from './lib/tdlib/manager.js';
import { connectRedis, disconnectRedis } from './lib/redis.js';
async function main() {
    logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] Server starting...');
    const app = await buildApp();
    logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] App built successfully');
    try {
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] Connecting to database...');
        await prisma.$connect();
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] Connected to database');
        // Connect to Redis
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] Connecting to Redis...');
        await connectRedis();
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] Connected to Redis');
        // Initialize TDLib once at startup
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] Initializing TDLib...');
        await initializeTdlib();
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] TDLib initialized successfully');
        // Restore TDLib clients for existing sessions
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] Restoring TDLib clients...');
        await tdlibManager.restoreClients();
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] TDLib clients restored');
        await app.listen({ port: config.PORT, host: config.HOST });
        logger.info({
            url: `http://${config.HOST}:${config.PORT}`,
            timestamp: new Date().toISOString()
        }, '[DEBUG] Server running and ready to accept requests');
    }
    catch (err) {
        logger.error({ err, errMessage: err.message, errStack: err.stack, timestamp: new Date().toISOString() }, '[DEBUG] Failed to start server');
        process.exit(1);
    }
    const shutdown = async () => {
        logger.info('Shutting down...');
        await app.close();
        await disconnectRedis();
        await prisma.$disconnect();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main();
//# sourceMappingURL=index.js.map