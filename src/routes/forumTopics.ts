import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { tdlibManager } from '../lib/tdlib/manager.js';
import { syncForumTopic } from '../lib/tdlib/handlers/forumTopics.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import type { TdForumTopic } from '../lib/tdlib/types.js';

const chatIdSchema = z.object({
  chatId: z.string().transform((val) => BigInt(val)),
});

const topicIdSchema = z.object({
  chatId: z.string().transform((val) => BigInt(val)),
  topicId: z.string().transform((val) => BigInt(val)),
});

const paginationSchema = z.object({
  limit: z.string().optional().transform((val) => parseInt(val || '50', 10)),
  offset: z.string().optional().transform((val) => parseInt(val || '0', 10)),
});

export async function forumTopicRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // Get all topics for a forum chat
  app.get('/api/chats/:chatId/topics', async (request, reply) => {
    try {
      if (!request.userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { chatId } = chatIdSchema.parse(request.params);
      const { limit, offset } = paginationSchema.parse(request.query);

      // Verify the chat exists and is a forum
      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { isForum: true, type: true },
      });

      if (!chat) {
        return reply.status(404).send({ error: 'Chat not found' });
      }

      if (!chat.isForum) {
        return reply.status(400).send({ error: 'Chat is not a forum' });
      }

      // Fetch topics from TDLib and sync to database
      try {
        const client = await tdlibManager.getOrCreateClient(request.userId);
        const tdTopics = await client.getForumTopics(Number(chatId)) as {
          topics?: TdForumTopic[];
          total_count?: number;
        };

        if (tdTopics.topics && tdTopics.topics.length > 0) {
          logger.info({
            chatId: chatId.toString(),
            topicCount: tdTopics.topics.length,
          }, 'Fetched forum topics from TDLib');

          // Sync all topics to database
          await Promise.all(
            tdTopics.topics.map((topic) => syncForumTopic(Number(chatId), topic))
          );
        }
      } catch (tdError) {
        // Log but don't fail - we'll return whatever is in the database
        logger.warn({ chatId: chatId.toString(), error: tdError }, 'Failed to fetch topics from TDLib, returning cached data');
      }

      const topics = await prisma.forumTopic.findMany({
        where: {
          chatId,
          isHidden: false,
        },
        orderBy: [
          { isGeneral: 'desc' }, // General topic first
          { lastMessageAt: 'desc' },
        ],
        take: limit,
        skip: offset,
        select: {
          id: true,
          name: true,
          iconColor: true,
          iconCustomEmojiId: true,
          creationDate: true,
          creatorUserId: true,
          isGeneral: true,
          isClosed: true,
          unreadCount: true,
          lastMessagePreview: true,
          lastMessageAt: true,
          lastMessageSender: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              username: true,
            },
          },
        },
      });

      const total = await prisma.forumTopic.count({
        where: {
          chatId,
          isHidden: false,
        },
      });

      return reply.send({
        topics: topics.map((topic: typeof topics[number]) => ({
          id: topic.id.toString(),
          name: topic.name,
          iconColor: topic.iconColor,
          iconCustomEmojiId: topic.iconCustomEmojiId,
          creationDate: topic.creationDate.toISOString(),
          creatorUserId: topic.creatorUserId?.toString(),
          isGeneral: topic.isGeneral,
          isClosed: topic.isClosed,
          unreadCount: topic.unreadCount,
          lastMessagePreview: topic.lastMessagePreview,
          lastMessageAt: topic.lastMessageAt?.toISOString(),
          lastMessageSender: topic.lastMessageSender ? {
            firstName: topic.lastMessageSender.firstName,
            lastName: topic.lastMessageSender.lastName,
            username: topic.lastMessageSender.username,
          } : undefined,
        })),
        total,
      });
    } catch (error) {
      logger.error({ error }, 'Get forum topics failed');
      return reply.status(500).send({ error: 'Failed to get forum topics' });
    }
  });

  // Get a specific topic
  app.get('/api/chats/:chatId/topics/:topicId', async (request, reply) => {
    try {
      const { chatId, topicId } = topicIdSchema.parse(request.params);

      const topic = await prisma.forumTopic.findUnique({
        where: {
          chatId_id: {
            chatId,
            id: topicId,
          },
        },
      });

      if (!topic) {
        return reply.status(404).send({ error: 'Topic not found' });
      }

      return reply.send({
        id: topic.id.toString(),
        chatId: topic.chatId.toString(),
        name: topic.name,
        iconColor: topic.iconColor,
        iconCustomEmojiId: topic.iconCustomEmojiId,
        creationDate: topic.creationDate.toISOString(),
        creatorUserId: topic.creatorUserId?.toString(),
        isGeneral: topic.isGeneral,
        isClosed: topic.isClosed,
        isHidden: topic.isHidden,
        unreadCount: topic.unreadCount,
        lastMessagePreview: topic.lastMessagePreview,
        lastMessageAt: topic.lastMessageAt?.toISOString(),
      });
    } catch (error) {
      logger.error({ error }, 'Get forum topic failed');
      return reply.status(500).send({ error: 'Failed to get forum topic' });
    }
  });

  // Get messages for a specific topic
  app.get('/api/chats/:chatId/topics/:topicId/messages', async (request, reply) => {
    try {
      if (!request.userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { chatId, topicId } = topicIdSchema.parse(request.params);
      const { limit, offset } = paginationSchema.parse(request.query);

      const messages = await prisma.message.findMany({
        where: {
          chatId,
          forumTopicId: topicId,
          deletedOnTelegram: false,
        },
        orderBy: { telegramCreatedAt: 'desc' },
        take: limit,
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
        },
      });

      // Fetch referenced messages for replies
      const replyToIds = messages
        .map((m: typeof messages[number]) => m.replyToTelegramId)
        .filter((id: bigint | null): id is bigint => id !== null);

      type ReplyMessage = {
        telegramMessageId: bigint;
        content: string;
        sender: { firstName: string; lastName: string | null; username: string | null };
      };

      const replyMessages: ReplyMessage[] = replyToIds.length > 0
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

      const replyMap = new Map<string, ReplyMessage>(
        replyMessages.map((m: ReplyMessage) => [m.telegramMessageId.toString(), m])
      );

      const total = await prisma.message.count({
        where: {
          chatId,
          forumTopicId: topicId,
          deletedOnTelegram: false,
        },
      });

      // Calculate isOutgoing dynamically based on senderId vs current user
      const currentUserIdBigInt = BigInt(request.userId);

      return reply.send({
        messages: messages.map((msg: typeof messages[number]) => {
          const replyMsg = msg.replyToTelegramId
            ? replyMap.get(msg.replyToTelegramId.toString())
            : null;

          return {
            // Use chatId_telegramMessageId format for consistency with WebSocket events
            id: `${msg.chatId.toString()}_${msg.telegramMessageId.toString()}`,
            telegramMessageId: msg.telegramMessageId.toString(),
            chatId: msg.chatId.toString(),
            forumTopicId: msg.forumTopicId?.toString(),
            senderId: msg.senderId.toString(),
            content: msg.content,
            isOutgoing: msg.senderId === currentUserIdBigInt,
            isRead: msg.isRead,
            deletedOnTelegram: msg.deletedOnTelegram,
            deletedOnTelegramAt: msg.deletedOnTelegramAt?.toISOString(),
            telegramCreatedAt: msg.telegramCreatedAt.toISOString(),
            telegramEditedAt: msg.telegramEditedAt?.toISOString(),
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
              : undefined,
          };
        }),
        total,
      });
    } catch (error) {
      logger.error({ error }, 'Get topic messages failed');
      return reply.status(500).send({ error: 'Failed to get topic messages' });
    }
  });
}
