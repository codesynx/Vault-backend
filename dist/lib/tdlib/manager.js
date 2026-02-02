import { randomUUID } from 'crypto';
import path from 'path';
import { TdlibClient } from './client.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { setupClientHandlers } from './setupHandlers.js';
import { prisma } from '../prisma.js';
class TdlibManager {
    clients = new Map();
    authClients = new Map();
    async getOrCreateClient(userId) {
        let client = this.clients.get(userId);
        if (!client) {
            const sessionPath = path.join(config.TDLIB_SESSIONS_PATH, `user_${userId}`);
            client = new TdlibClient(sessionPath);
            await client.initialize();
            // Check if the TDLib session is valid (fully authenticated)
            const authState = client.getAuthState();
            if (authState !== 'authorizationStateReady') {
                logger.warn({ userId, authState }, 'TDLib client not authenticated, closing and removing session');
                await client.close();
                // Delete user's app sessions to force re-login
                await prisma.session.deleteMany({
                    where: { userId: BigInt(userId) },
                });
                throw new Error('TDLib session expired. Please log in again.');
            }
            setupClientHandlers(client, userId);
            this.clients.set(userId, client);
            logger.info({ userId, authState }, 'Created TDLib client for user');
        }
        return client;
    }
    async createAuthClient(phoneNumber) {
        const sessionId = randomUUID();
        const sessionPath = path.join(config.TDLIB_SESSIONS_PATH, `auth_${sessionId}`);
        logger.info({
            sessionId,
            sessionPath,
            phoneNumberPrefix: phoneNumber.slice(0, 4),
            tdlibSessionsPath: config.TDLIB_SESSIONS_PATH,
            timestamp: new Date().toISOString()
        }, '[DEBUG] createAuthClient() - creating new auth client');
        const client = new TdlibClient(sessionPath);
        logger.info({ sessionId, timestamp: new Date().toISOString() }, '[DEBUG] createAuthClient() - about to initialize TDLib client');
        try {
            await client.initialize();
            logger.info({
                sessionId,
                authState: client.getAuthState(),
                timestamp: new Date().toISOString()
            }, '[DEBUG] createAuthClient() - TDLib client initialized successfully');
        }
        catch (initErr) {
            logger.error({
                sessionId,
                err: JSON.stringify(initErr),
                errMessage: initErr.message,
                errStack: initErr.stack,
                timestamp: new Date().toISOString()
            }, '[DEBUG] createAuthClient() - TDLib client initialization failed');
            throw initErr;
        }
        this.authClients.set(sessionId, client);
        logger.info({
            sessionId,
            phoneNumberPrefix: phoneNumber.slice(0, 4),
            totalAuthClients: this.authClients.size,
            timestamp: new Date().toISOString()
        }, '[DEBUG] Created auth TDLib client and added to authClients map');
        return { client, sessionId };
    }
    getAuthClient(sessionId) {
        return this.authClients.get(sessionId);
    }
    async promoteAuthClient(sessionId, userId) {
        const authClient = this.authClients.get(sessionId);
        if (!authClient) {
            throw new Error('Auth client not found');
        }
        this.authClients.delete(sessionId);
        setupClientHandlers(authClient, userId);
        this.clients.set(userId, authClient);
        logger.info({ sessionId, userId }, 'Promoted auth client to user client');
        return authClient;
    }
    async removeAuthClient(sessionId) {
        const client = this.authClients.get(sessionId);
        if (client) {
            await client.close();
            this.authClients.delete(sessionId);
            logger.info({ sessionId }, 'Removed auth client');
        }
    }
    async removeUserClient(userId) {
        const client = this.clients.get(userId);
        if (client) {
            await client.close();
            this.clients.delete(userId);
            logger.info({ userId }, 'Removed user client');
        }
    }
    getClient(userId) {
        return this.clients.get(userId);
    }
    // Handle TDLib 401 errors by cleaning up invalid sessions
    async handleTdlibError(userId, error) {
        const err = error;
        // If 401 Unauthorized, the TDLib session is invalid
        if (err.code === 401) {
            logger.warn({ userId, errCode: err.code, errMessage: err.message }, 'TDLib session unauthorized, cleaning up');
            // Remove the client from memory
            const client = this.clients.get(userId);
            if (client) {
                try {
                    await client.close();
                }
                catch {
                    // Ignore close errors
                }
                this.clients.delete(userId);
            }
            // Delete user's app sessions to force re-login
            await prisma.session.deleteMany({
                where: { userId: BigInt(userId) },
            });
            throw new Error('Telegram session expired. Please log in again.');
        }
        // Re-throw other errors
        throw error;
    }
    async closeAll() {
        for (const [sessionId, client] of this.authClients) {
            await client.close();
            logger.info({ sessionId }, 'Closed auth client');
        }
        this.authClients.clear();
        for (const [userId, client] of this.clients) {
            await client.close();
            logger.info({ userId }, 'Closed user client');
        }
        this.clients.clear();
        logger.info('All TDLib clients closed');
    }
    // Restore TDLib clients for all active sessions on server startup
    async restoreClients() {
        try {
            // Get unique user IDs from active sessions
            const sessions = await prisma.session.findMany({
                select: { userId: true },
                distinct: ['userId'],
            });
            logger.info({ sessionCount: sessions.length }, 'Restoring TDLib clients for active sessions');
            let restoredCount = 0;
            let invalidCount = 0;
            for (const session of sessions) {
                const userId = session.userId.toString();
                try {
                    await this.getOrCreateClient(userId);
                    restoredCount++;
                    logger.info({ userId }, 'Restored TDLib client');
                }
                catch (err) {
                    invalidCount++;
                    const errorMessage = err.message;
                    if (errorMessage.includes('session expired')) {
                        logger.warn({ userId }, 'TDLib session expired, user will need to re-login');
                    }
                    else {
                        logger.error({ userId, err }, 'Failed to restore TDLib client');
                    }
                }
            }
            logger.info({
                clientCount: this.clients.size,
                restoredCount,
                invalidCount,
            }, 'TDLib clients restoration complete');
        }
        catch (err) {
            logger.error({ err }, 'Failed to restore TDLib clients');
        }
    }
}
export const tdlibManager = new TdlibManager();
//# sourceMappingURL=manager.js.map