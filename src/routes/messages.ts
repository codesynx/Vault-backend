import type { FastifyInstance } from 'fastify';
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

export async function messageRoutes(app: FastifyInstance): Promise<void> {
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
      const cached = await getFromCache<{ messages: unknown[]; hasMore: boolean; nextCursor: string | null }>(cacheKey);
      if (cached) {
        return reply.send(cached);
      }

      // Return only messages from database (populated by TDLib events)
      const whereClause: Record<string, unknown> = { chatId };

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
        .filter((id): id is bigint => id !== null);

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

      const replyMap = new Map(
        replyMessages.map((m) => [m.telegramMessageId.toString(), m])
      );

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
                senderName:
                    [replyMsg.sender.firstName, replyMsg.sender.lastName]
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
        nextCursor:
          messages.length > 0
            ? messages[messages.length - 1].telegramMessageId.toString()
            : null,
      };

      // Cache the response
      await setInCache(cacheKey, response, CACHE_TTL.MESSAGES);

      return reply.send(response);
    } catch (error) {
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
      const result = (await client.sendMessage(
        Number(chatId),
        text,
        replyToId,
        messageThreadId
      )) as { id: number; chat_id: number; date: number };

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
    } catch (error) {
      const err = error as { code?: number; message?: string };
      // Handle TDLib session errors
      if (err.code === 401 || (err.message && err.message.includes('session expired'))) {
        await tdlibManager.handleTdlibError(request.userId!, error);
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
      const { topicId } = z.object({
        topicId: z.string().optional().transform((val) => (val ? parseInt(val, 10) : undefined)),
      }).parse(request.body || {});

      const client = await tdlibManager.getOrCreateClient(request.userId);

      // First, open the chat to inform TDLib user is viewing it
      await client.invoke('openChat', {
        chat_id: Number(chatId),
      });

      let lastMessageId: number | undefined;
      let unreadCount: number | undefined;

      if (topicId) {
        try {
          // For forum topics, get topic info to find last message
          // We cast to any because TdForumTopic might not be fully exported or imported here
          const topic = await client.invoke('getForumTopic', {
            chat_id: Number(chatId),
            message_thread_id: topicId,
          }) as any;

          lastMessageId = topic.last_message?.id;
          unreadCount = topic.unread_count;
        } catch (err) {
          logger.warn({ chatId: chatId.toString(), topicId, err }, 'Failed to get forum topic from TDLib, trying local DB');

          // Fallback: get last message from local database
          const lastLocalMessage = await prisma.message.findFirst({
            where: {
              chatId,
              forumTopicId: BigInt(topicId),
              deletedOnTelegram: false,
            },
            orderBy: { telegramMessageId: 'desc' },
            select: { telegramMessageId: true },
          });

          if (lastLocalMessage) {
            lastMessageId = Number(lastLocalMessage.telegramMessageId);
            // Count unread messages locally - default to 1 to ensure viewMessages is called
            // when user is actively viewing a topic (they want to mark it as read)
            const localTopic = await prisma.forumTopic.findUnique({
              where: {
                chatId_id: { chatId, id: BigInt(topicId) },
              },
              select: { unreadCount: true },
            });
            // Always use at least 1 to ensure we try marking as read when user views topic
            unreadCount = Math.max(localTopic?.unreadCount ?? 1, 1);
            logger.info({ chatId: chatId.toString(), topicId, lastMessageId, unreadCount }, 'Using local DB for forum topic read status');
          } else {
            logger.warn({ chatId: chatId.toString(), topicId }, 'No messages found in local DB for topic');
          }
        }
      } else {
        // Get the chat info to find the last message ID for viewMessages
        const chatInfo = await client.invoke('getChat', {
          chat_id: Number(chatId),
        }) as { last_message?: { id: number }; unread_count?: number };
        
        lastMessageId = chatInfo.last_message?.id;
        unreadCount = chatInfo.unread_count;
      }

      // Only call viewMessages if there are unread messages and we have a last message
      if (lastMessageId && unreadCount && unreadCount > 0) {
        try {
          await client.invoke('viewMessages', {
            chat_id: Number(chatId),
            message_thread_id: topicId,
            message_ids: [lastMessageId],
            force_read: true,
          });

          logger.info({
            chatId: chatId.toString(),
            topicId,
            lastMessageId,
            unreadCount,
          }, 'Messages marked as read via viewMessages');
        } catch (viewErr) {
          // Log error but don't fail the request - viewMessages errors are non-critical
          // This can happen when topic ID is invalid/stale in TDLib
          logger.warn({
            chatId: chatId.toString(),
            topicId,
            lastMessageId,
            error: viewErr,
          }, 'viewMessages failed (topic may be invalid in TDLib)');
        }
      } else {
        logger.debug({
          chatId: chatId.toString(),
          topicId,
          lastMessageId,
          unreadCount,
        }, 'Skipping viewMessages - no unread messages or no lastMessageId');
      }

      return reply.send({ success: true });
    } catch (error) {
      const err = error as { code?: number; message?: string };
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
    } catch (error) {
      const err = error as { code?: number };
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
    } catch (error) {
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

      const whereClause: Record<string, unknown> = {
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
    } catch (error) {
      logger.error({ error }, 'Search messages failed');
      return reply.status(500).send({ error: 'Failed to search messages' });
    }
  });
}
