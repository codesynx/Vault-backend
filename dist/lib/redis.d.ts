import { Redis } from 'ioredis';
export declare const redis: Redis;
export declare const CACHE_TTL: {
    readonly CHATS: 60;
    readonly MESSAGES: 300;
    readonly USER: 600;
    readonly CHAT_DETAIL: 300;
};
export declare const cacheKeys: {
    chats: (userId: string) => string;
    chatDetail: (chatId: string) => string;
    messages: (userId: string, chatId: string, includeDeleted: boolean, cursor?: string) => string;
    user: (userId: string) => string;
};
export declare function getFromCache<T>(key: string): Promise<T | null>;
export declare function setInCache<T>(key: string, data: T, ttl: number): Promise<void>;
export declare function invalidateCache(pattern: string): Promise<void>;
export declare function invalidateChatsCache(userId?: string): Promise<void>;
export declare function invalidateMessagesCache(chatId: string): Promise<void>;
export declare function invalidateChatCache(chatId: string): Promise<void>;
export declare function connectRedis(): Promise<void>;
export declare function disconnectRedis(): Promise<void>;
//# sourceMappingURL=redis.d.ts.map