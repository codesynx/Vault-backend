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

redis.on('error', (err: Error) => {
  logger.error({ err }, 'Redis connection error');
});

// Cache TTLs (in seconds)
export const CACHE_TTL = {
  CHATS: 60,           // 1 minute for chat list
  MESSAGES: 300,       // 5 minutes for messages
  USER: 600,           // 10 minutes for user info
  CHAT_DETAIL: 300,    // 5 minutes for chat details
} as const;

// Cache key generators
export const cacheKeys = {
  chats: (userId: string) => `chats:${userId}:list`,
  chatDetail: (chatId: string) => `chat:${chatId}`,
  messages: (userId: string, chatId: string, includeDeleted: boolean, cursor?: string) =>
    `messages:${userId}:${chatId}:${includeDeleted}:${cursor || 'first'}`,
  user: (userId: string) => `user:${userId}`,
};

// Generic cache helpers
export async function getFromCache<T>(key: string): Promise<T | null> {
  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
    return null;
  } catch (err) {
    logger.warn({ err, key }, 'Cache get error');
    return null;
  }
}

export async function setInCache<T>(key: string, data: T, ttl: number): Promise<void> {
  try {
    await redis.setex(key, ttl, JSON.stringify(data));
  } catch (err) {
    logger.warn({ err, key }, 'Cache set error');
  }
}

export async function invalidateCache(pattern: string): Promise<void> {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.debug({ pattern, count: keys.length }, 'Cache invalidated');
    }
  } catch (err) {
    logger.warn({ err, pattern }, 'Cache invalidation error');
  }
}

// Specific cache invalidation helpers
export async function invalidateChatsCache(userId?: string): Promise<void> {
  if (userId) {
    await invalidateCache(`chats:${userId}:*`);
  } else {
    // Invalidate all users' chat caches (used when chat data changes globally)
    await invalidateCache('chats:*');
  }
}

export async function invalidateMessagesCache(chatId: string): Promise<void> {
  // Invalidate all users' message caches for this chat
  await invalidateCache(`messages:*:${chatId}:*`);
}

export async function invalidateChatCache(chatId: string): Promise<void> {
  await invalidateCache(`chat:${chatId}`);
  await invalidateChatsCache();
}

// Connect to Redis
export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
  } catch (err) {
    // If already connected, ignore
    if ((err as Error).message?.includes('already')) {
      return;
    }
    logger.error({ err }, 'Failed to connect to Redis');
    throw err;
  }
}

// Graceful shutdown
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
