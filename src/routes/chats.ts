import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { getFromCache, setInCache, cacheKeys, CACHE_TTL } from '../lib/redis.js';

const paginationSchema = z.object({
  limit: z.string().optional().transform((val) => parseInt(val || '50', 10)),
  offset: z.string().optional().transform((val) => parseInt(val || '0', 10)),
});

const chatIdSchema = z.object({
  id: z.string().transform((val) => BigInt(val)),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // Listener mode: only return chats that were created after user registration
  // Chats are populated through TDLib events (updateNewMessage, updateNewChat, etc.)
  app.get('/api/chats', async (request, reply) => {
    try {
      if (!request.userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { limit, offset } = paginationSchema.parse(request.query);
      const userId = request.userId!.toString();
      const cacheKey = cacheKeys.chats(userId);

      // Check cache first
      const cached = await getFromCache<{ chats: unknown[]; total: number }>(cacheKey);
      if (cached && offset === 0) {
        return reply.send(cached);
      }

      // Return only chats where the user is a member and that have at least one archived message
      // This ensures data isolation - users only see their own chats
      // Exclude channels - they are not supported
      const userIdBigInt = BigInt(request.userId);
      const chats = await prisma.chat.findMany({
        where: {
          members: {
            some: {
              userId: userIdBigInt, // Only chats where user is a member
            },
          },
          messages: {
            some: {}, // Only chats with at least one archived message
          },
          type: {
            not: 'channel', // Exclude channels
          },
        },
        orderBy: [
          { isPinned: 'desc' },
          { lastMessageAt: 'desc' },
        ],
        take: limit,
        skip: offset,
        select: {
          id: true,
          type: true,
          title: true,
          username: true,
          otherUserId: true,
          isForum: true,
          lastMessagePreview: true,
          lastMessageAt: true,
          unreadCount: true,
          isPinned: true,
          isMuted: true,
        },
      });

      // For private chats with generic titles, fetch the other user's name
      const chatsWithTitles = await Promise.all(
        chats.map(async (chat) => {
          let title = chat.title;
          let user: { firstName: string; lastName: string | null; username: string | null } | undefined;

          // If it's a private chat, get the other user's info
          if (chat.type === 'private' && chat.otherUserId) {
            const otherUser = await prisma.user.findUnique({
              where: { id: chat.otherUserId },
              select: { firstName: true, lastName: true, username: true },
            });

            if (otherUser) {
              user = otherUser;
              // If title is generic, update it with user's name
              if (title === 'New Chat' || title === 'Unknown' || !title) {
                title = [otherUser.firstName, otherUser.lastName].filter(Boolean).join(' ') || title;
              }
            }
          }

          return {
            id: chat.id.toString(),
            type: chat.type,
            title,
            username: chat.username,
            isForum: (chat as { isForum?: boolean }).isForum || false,
            lastMessagePreview: chat.lastMessagePreview,
            lastMessageAt: chat.lastMessageAt,
            unreadCount: chat.unreadCount,
            isPinned: chat.isPinned,
            isMuted: chat.isMuted,
            user,
          };
        })
      );

      const response = {
        chats: chatsWithTitles,
        total: chatsWithTitles.length,
      };

      // Cache the response
      if (offset === 0) {
        await setInCache(cacheKey, response, CACHE_TTL.CHATS);
      }

      return reply.send(response);
    } catch (error) {
      logger.error({ error }, 'Get chats failed');
      return reply.status(500).send({ error: 'Failed to get chats' });
    }
  });

  app.get('/api/chats/:id', async (request, reply) => {
    try {
      if (!request.userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { id } = chatIdSchema.parse(request.params);
      const userIdBigInt = BigInt(request.userId);

      // Verify user is a member of this chat before returning details
      const chat = await prisma.chat.findFirst({
        where: {
          id,
          members: {
            some: {
              userId: userIdBigInt, // User must be a member
            },
          },
        },
        include: {
          members: {
            include: {
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  username: true,
                  onlineStatus: true,
                },
              },
            },
          },
        },
      });

      if (!chat) {
        return reply.status(404).send({ error: 'Chat not found' });
      }

      return reply.send({
        ...chat,
        id: chat.id.toString(),
        otherUserId: chat.otherUserId?.toString(),
        lastMessageId: chat.lastMessageId?.toString(),
        members: chat.members.map((m) => ({
          ...m,
          userId: m.userId.toString(),
          chatId: m.chatId.toString(),
          user: {
            ...m.user,
            id: m.user.id.toString(),
          },
        })),
      });
    } catch (error) {
      logger.error({ error }, 'Get chat failed');
      return reply.status(500).send({ error: 'Failed to get chat' });
    }
  });
}
