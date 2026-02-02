import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
// Redis client
export const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: () => 100,
    lazyConnect: true,
});
redis.on('connect', () => {
    logger.info('Redis connected');
});
redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
});
// Cache TTLs (in seconds)
export const CACHE_TTL = {
    CHATS: 60, // 1 minute for chat list
    MESSAGES: 300, // 5 minutes for messages
    USER: 600, // 10 minutes for user info
    CHAT_DETAIL: 300, // 5 minutes for chat details
};
// Cache key generators
export const cacheKeys = {
    chats: (userId) => `chats:${userId}:list`,
    chatDetail: (chatId) => `chat:${chatId}`,
    messages: (userId, chatId, includeDeleted, cursor) => `messages:${userId}:${chatId}:${includeDeleted}:${cursor || 'first'}`,
    user: (userId) => `user:${userId}`,
};
// Generic cache helpers
export async function getFromCache(key) {
    try {
        const cached = await redis.get(key);
        if (cached) {
            return JSON.parse(cached);
        }
        return null;
    }
    catch (err) {
        logger.warn({ err, key }, 'Cache get error');
        return null;
    }
}
export async function setInCache(key, data, ttl) {
    try {
        await redis.setex(key, ttl, JSON.stringify(data));
    }
    catch (err) {
        logger.warn({ err, key }, 'Cache set error');
    }
}
export async function invalidateCache(pattern) {
    try {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
            await redis.del(...keys);
            logger.debug({ pattern, count: keys.length }, 'Cache invalidated');
        }
    }
    catch (err) {
        logger.warn({ err, pattern }, 'Cache invalidation error');
    }
}
// Specific cache invalidation helpers
export async function invalidateChatsCache(userId) {
    if (userId) {
        await invalidateCache(`chats:${userId}:*`);
    }
    else {
        // Invalidate all users' chat caches (used when chat data changes globally)
        await invalidateCache('chats:*');
    }
}
export async function invalidateMessagesCache(chatId) {
    // Invalidate all users' message caches for this chat
    await invalidateCache(`messages:*:${chatId}:*`);
}
export async function invalidateChatCache(chatId) {
    await invalidateCache(`chat:${chatId}`);
    await invalidateChatsCache();
}
// Connect to Redis
export async function connectRedis() {
    try {
        await redis.connect();
    }
    catch (err) {
        // If already connected, ignore
        if (err.message?.includes('already')) {
            return;
        }
        logger.error({ err }, 'Failed to connect to Redis');
        throw err;
    }
}
// Graceful shutdown
export async function disconnectRedis() {
    await redis.quit();
}
//# sourceMappingURL=redis.js.map