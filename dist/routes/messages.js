import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { tdlibManager } from '../lib/tdlib/manager.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { getFromCache, setInCache, cacheKeys, CACHE_TTL } from '../lib/redis.js';
const messagesQuerySchema = z.object({
    limit: z.string().optional().transform((val) => parseInt(val || '50', 10)),
    before: z.string().optional(),
    includeDeleted: z.string().optional().transform((val) => val === 'true'),
});
const chatIdParamSchema = z.object({
    chatId: z.string().transform((val) => BigInt(val)),
});
const sendMessageSchema = z.object({
    chatId: z.string().transform((val) => BigInt(val)),
    text: z.string().min(1).max(4096),
    replyToMessageId: z.string().optional(),
    messageThreadId: z.string().optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
});
const searchQuerySchema = z.object({
    q: z.string().min(1).max(500),
    chatId: z.string().optional().transform((val) => (val ? BigInt(val) : undefined)),
    includeDeleted: z.string().optional().transform((val) => val === 'true'),
    limit: z.string().optional().transform((val) => parseInt(val || '50', 10)),
    offset: z.string().optional().transform((val) => parseInt(val || '0', 10)),
});
export async function messageRoutes(app) {
    app.addHook('preHandler', authMiddleware);
    // Listener mode: only return messages that were received after user registration
    // Messages are populated through TDLib events (updateNewMessage)
    app.get('/api/chats/:chatId/messages', async (request, reply) => {
        try {
            if (!request.userId) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
            const { chatId } = chatIdParamSchema.parse(request.params);
            const { limit, before, includeDeleted } = messagesQuerySchema.parse(request.query);
            const chatIdStr = chatId.toString();
            const cacheKey = cacheKeys.messages(request.userId, chatIdStr, includeDeleted, before);
            // Check cache first
            const cached = await getFromCache(cacheKey);
            if (cached) {
                return reply.send(cached);
            }
            // Return only messages from database (populated by TDLib events)
            const whereClause = { chatId };
            if (!includeDeleted) {
                whereClause.deletedOnTelegram = false;
            }
            if (before) {
                whereClause.telegramMessageId = { lt: BigInt(before) };
            }
            const messages = await prisma.message.findMany({
                where: whereClause,
                orderBy: { telegramCreatedAt: 'desc' },
                take: limit,
                include: {
                    sender: {
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            username: true,
                        },
                    },
                },
            });
            // Fetch referenced messages for replies
            const replyToIds = messages
                .map((m) => m.replyToTelegramId)
                .filter((id) => id !== null);
            const replyMessages = replyToIds.length > 0
                ? await prisma.message.findMany({
                    where: {
                        chatId,
                        telegramMessageId: { in: replyToIds },
                    },
                    select: {
                        telegramMessageId: true,
                        content: true,
                        sender: {
                            select: {
                                firstName: true,
                                lastName: true,
                                username: true,
                            },
                        },
                    },
                })
                : [];
            const replyMap = new Map(replyMessages.map((m) => [m.telegramMessageId.toString(), m]));
            // Calculate isOutgoing dynamically based on senderId vs current user
            const currentUserIdBigInt = BigInt(request.userId);
            const response = {
                messages: messages.map((msg) => {
                    const replyMsg = msg.replyToTelegramId
                        ? replyMap.get(msg.replyToTelegramId.toString())
                        : null;
                    return {
                        // Use chatId_telegramMessageId format for consistency with WebSocket events
                        id: `${msg.chatId.toString()}_${msg.telegramMessageId.toString()}`,
                        telegramMessageId: msg.telegramMessageId.toString(),
                        chatId: msg.chatId.toString(),
                        senderId: msg.senderId.toString(),
                        content: msg.content,
                        isOutgoing: msg.senderId === currentUserIdBigInt,
                        isRead: msg.isRead,
                        deletedOnTelegram: msg.deletedOnTelegram,
                        deletedOnTelegramAt: msg.deletedOnTelegramAt,
                        editHistory: msg.editHistory,
                        telegramCreatedAt: msg.telegramCreatedAt,
                        telegramEditedAt: msg.telegramEditedAt,
                        replyToTelegramId: msg.replyToTelegramId?.toString(),
                        replyToMessage: replyMsg
                            ? {
                                id: replyMsg.telegramMessageId.toString(),
                                senderName: [replyMsg.sender.firstName, replyMsg.sender.lastName]
                                    .filter(Boolean)
                                    .join(' ') ||
                                    replyMsg.sender.username ||
                                    'Unknown',
                                content: replyMsg.content,
                            }
                            : null,
                        sender: msg.sender
                            ? {
                                id: msg.sender.id.toString(),
                                firstName: msg.sender.firstName,
                                lastName: msg.sender.lastName,
                                username: msg.sender.username,
                            }
                            : null,
                    };
                }),
                hasMore: messages.length === limit,
                nextCursor: messages.length > 0
                    ? messages[messages.length - 1].telegramMessageId.toString()
                    : null,
            };
            // Cache the response
            await setInCache(cacheKey, response, CACHE_TTL.MESSAGES);
            return reply.send(response);
        }
        catch (error) {
            logger.error({ error }, 'Get messages failed');
            return reply.status(500).send({ error: 'Failed to get messages' });
        }
    });
    app.post('/api/messages', async (request, reply) => {
        try {
            if (!request.userId) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
            const { chatId, text, replyToMessageId, messageThreadId } = sendMessageSchema.parse(request.body);
            const client = await tdlibManager.getOrCreateClient(request.userId);
            const replyToId = replyToMessageId ? parseInt(replyToMessageId, 10) : undefined;
            const result = (await client.sendMessage(Number(chatId), text, replyToId, messageThreadId));
            // Message will be archived through updateNewMessage event handler
            return reply.send({
                success: true,
                message: {
                    id: result.id.toString(),
                    chatId: result.chat_id.toString(),
                    content: text,
                    isOutgoing: true,
                    telegramCreatedAt: new Date(result.date * 1000),
                },
            });
        }
        catch (error) {
            const err = error;
            // Handle TDLib session errors
            if (err.code === 401 || (err.message && err.message.includes('session expired'))) {
                await tdlibManager.handleTdlibError(request.userId, error);
            }
            logger.error({ error }, 'Send message failed');
            return reply.status(500).send({ error: 'Failed to send message' });
        }
    });
    // Mark messages as read (view messages)
    app.post('/api/chats/:chatId/read', async (request, reply) => {
        try {
            if (!request.userId) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
            const { chatId } = chatIdParamSchema.parse(request.params);
            const client = await tdlibManager.getOrCreateClient(request.userId);
            // First, open the chat to inform TDLib user is viewing it
            await client.invoke('openChat', {
                chat_id: Number(chatId),
            });
            // Get the chat info to find the last message ID for viewMessages
            const chatInfo = await client.invoke('getChat', {
                chat_id: Number(chatId),
            });
            // Only call viewMessages if there are unread messages and we have a last message
            if (chatInfo.last_message?.id && chatInfo.unread_count && chatInfo.unread_count > 0) {
                await client.invoke('viewMessages', {
                    chat_id: Number(chatId),
                    message_ids: [chatInfo.last_message.id],
                    force_read: true,
                });
                logger.info({
                    chatId: chatId.toString(),
                    lastMessageId: chatInfo.last_message.id,
                    unreadCount: chatInfo.unread_count,
                }, 'Messages marked as read via viewMessages');
            }
            return reply.send({ success: true });
        }
        catch (error) {
            const err = error;
            // Handle TDLib session errors gracefully - don't fail the whole request
            if (err.code === 401) {
                logger.warn({ userId: request.userId, error }, 'TDLib session expired during mark as read');
                // Still return success - the read operation is non-critical
                return reply.send({ success: true, warning: 'Session may need refresh' });
            }
            logger.error({ error }, 'Mark messages as read failed');
            return reply.status(500).send({ error: 'Failed to mark messages as read' });
        }
    });
    // Close chat (called when leaving chat screen)
    app.post('/api/chats/:chatId/close', async (request, reply) => {
        try {
            if (!request.userId) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
            const { chatId } = chatIdParamSchema.parse(request.params);
            const client = await tdlibManager.getOrCreateClient(request.userId);
            // Close chat
            await client.invoke('closeChat', {
                chat_id: Number(chatId),
            });
            return reply.send({ success: true });
        }
        catch (error) {
            const err = error;
            // Handle TDLib session errors gracefully - don't fail the whole request
            if (err.code === 401) {
                logger.warn({ userId: request.userId, error }, 'TDLib session expired during close chat');
                return reply.send({ success: true, warning: 'Session may need refresh' });
            }
            logger.error({ error }, 'Close chat failed');
            return reply.status(500).send({ error: 'Failed to close chat' });
        }
    });
    app.get('/api/messages/deleted', async (request, reply) => {
        try {
            const { limit } = messagesQuerySchema.parse(request.query);
            const messages = await prisma.message.findMany({
                where: { deletedOnTelegram: true },
                orderBy: { deletedOnTelegramAt: 'desc' },
                take: limit,
                include: {
                    sender: {
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            username: true,
                        },
                    },
                    chat: {
                        select: {
                            id: true,
                            title: true,
                            type: true,
                        },
                    },
                },
            });
            return reply.send({
                messages: messages.map((msg) => ({
                    // Use chatId_telegramMessageId format for consistency with WebSocket events
                    id: `${msg.chatId.toString()}_${msg.telegramMessageId.toString()}`,
                    telegramMessageId: msg.telegramMessageId.toString(),
                    chatId: msg.chatId.toString(),
                    content: msg.content,
                    deletedOnTelegramAt: msg.deletedOnTelegramAt,
                    telegramCreatedAt: msg.telegramCreatedAt,
                    sender: msg.sender
                        ? {
                            id: msg.sender.id.toString(),
                            firstName: msg.sender.firstName,
                            lastName: msg.sender.lastName,
                        }
                        : null,
                    chat: {
                        id: msg.chat.id.toString(),
                        title: msg.chat.title,
                        type: msg.chat.type,
                    },
                })),
            });
        }
        catch (error) {
            logger.error({ error }, 'Get deleted messages failed');
            return reply.status(500).send({ error: 'Failed to get deleted messages' });
        }
    });
    // Search messages (including deleted ones)
    app.get('/api/messages/search', async (request, reply) => {
        try {
            if (!request.userId) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
            const { q, chatId, includeDeleted, limit, offset } = searchQuerySchema.parse(request.query);
            const whereClause = {
                content: {
                    contains: q,
                    mode: 'insensitive',
                },
            };
            if (chatId) {
                whereClause.chatId = chatId;
            }
            if (!includeDeleted) {
                whereClause.deletedOnTelegram = false;
            }
            const [messages, total] = await Promise.all([
                prisma.message.findMany({
                    where: whereClause,
                    orderBy: { telegramCreatedAt: 'desc' },
                    take: Math.min(limit, 100),
                    skip: offset,
                    include: {
                        sender: {
                            select: {
                                id: true,
                                firstName: true,
                                lastName: true,
                                username: true,
                            },
                        },
                        chat: {
                            select: {
                                id: true,
                                title: true,
                                type: true,
                            },
                        },
                    },
                }),
                prisma.message.count({ where: whereClause }),
            ]);
            // Calculate isOutgoing dynamically based on senderId vs current user
            const currentUserIdBigInt = BigInt(request.userId);
            return reply.send({
                messages: messages.map((msg) => ({
                    // Use chatId_telegramMessageId format for consistency with WebSocket events
                    id: `${msg.chatId.toString()}_${msg.telegramMessageId.toString()}`,
                    telegramMessageId: msg.telegramMessageId.toString(),
                    chatId: msg.chatId.toString(),
                    content: msg.content,
                    isOutgoing: msg.senderId === currentUserIdBigInt,
                    deletedOnTelegram: msg.deletedOnTelegram,
                    deletedOnTelegramAt: msg.deletedOnTelegramAt,
                    telegramCreatedAt: msg.telegramCreatedAt,
                    sender: msg.sender
                        ? {
                            id: msg.sender.id.toString(),
                            firstName: msg.sender.firstName,
                            lastName: msg.sender.lastName,
                            username: msg.sender.username,
                        }
                        : null,
                    chat: {
                        id: msg.chat.id.toString(),
                        title: msg.chat.title,
                        type: msg.chat.type,
                    },
                })),
                total,
                hasMore: offset + messages.length < total,
            });
        }
        catch (error) {
            logger.error({ error }, 'Search messages failed');
            return reply.status(500).send({ error: 'Failed to search messages' });
        }
    });
}
//# sourceMappingURL=messages.js.map