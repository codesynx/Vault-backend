import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { tdlibManager } from '../lib/tdlib/manager.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const userIdParamSchema = z.object({
  userId: z.string().transform((val) => BigInt(val)),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // Get current user profile
  app.get('/api/users/me', async (request, reply) => {
    try {
      if (!request.userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const user = await prisma.user.findUnique({
        where: { id: BigInt(request.userId) },
      });

      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      return reply.send({
        id: user.id.toString(),
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        phoneNumber: user.phoneNumber,
        bio: user.bio,
        onlineStatus: user.onlineStatus,
        lastSeenAt: user.lastSeenAt,
        isVerified: user.isVerified,
      });
    } catch (error) {
      logger.error({ error }, 'Get current user failed');
      return reply.status(500).send({ error: 'Failed to get user profile' });
    }
  });

  // Get user by ID
  app.get('/api/users/:userId', async (request, reply) => {
    try {
      if (!request.userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { userId } = userIdParamSchema.parse(request.params);

      // First try to get from database
      let user = await prisma.user.findUnique({
        where: { id: userId },
      });

      // If not found, try to fetch from TDLib and cache
      if (!user) {
        try {
          const client = await tdlibManager.getOrCreateClient(request.userId);
          const tdUser = await client.invoke('getUser', {
            user_id: Number(userId),
          }) as {
            id: number;
            first_name: string;
            last_name?: string;
            usernames?: { editable_username?: string };
            phone_number?: string;
            status?: { _: string; was_online?: number };
            is_verified?: boolean;
          };

          user = await prisma.user.upsert({
            where: { id: userId },
            update: {
              firstName: tdUser.first_name,
              lastName: tdUser.last_name || null,
              username: tdUser.usernames?.editable_username || null,
              phoneNumber: tdUser.phone_number || null,
              isVerified: tdUser.is_verified || false,
              onlineStatus: tdUser.status?._?.replace('userStatus', '') || null,
              lastSeenAt: tdUser.status?.was_online
                ? new Date(tdUser.status.was_online * 1000)
                : null,
            },
            create: {
              id: userId,
              firstName: tdUser.first_name,
              lastName: tdUser.last_name || null,
              username: tdUser.usernames?.editable_username || null,
              phoneNumber: tdUser.phone_number || null,
              isVerified: tdUser.is_verified || false,
              onlineStatus: tdUser.status?._?.replace('userStatus', '') || null,
              lastSeenAt: tdUser.status?.was_online
                ? new Date(tdUser.status.was_online * 1000)
                : null,
            },
          });
        } catch (err) {
          logger.warn({ err, userId: userId.toString() }, 'Failed to fetch user from TDLib');
        }
      }

      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      return reply.send({
        id: user.id.toString(),
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        bio: user.bio,
        onlineStatus: user.onlineStatus,
        lastSeenAt: user.lastSeenAt,
        isVerified: user.isVerified,
        isContact: user.isContact,
        isMutualContact: user.isMutualContact,
      });
    } catch (error) {
      logger.error({ error }, 'Get user failed');
      return reply.status(500).send({ error: 'Failed to get user' });
    }
  });

  // Get user's online status
  app.get('/api/users/:userId/status', async (request, reply) => {
    try {
      if (!request.userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { userId } = userIdParamSchema.parse(request.params);

      try {
        const client = await tdlibManager.getOrCreateClient(request.userId);
        const tdUser = await client.invoke('getUser', {
          user_id: Number(userId),
        }) as {
          status?: { _: string; was_online?: number };
        };

        const status = tdUser.status?._?.replace('userStatus', '') || 'unknown';
        const lastSeenAt = tdUser.status?.was_online
          ? new Date(tdUser.status.was_online * 1000)
          : null;

        // Update cache
        await prisma.user.update({
          where: { id: userId },
          data: { onlineStatus: status, lastSeenAt },
        }).catch(() => { /* User might not exist in DB yet */ });

        return reply.send({
          status,
          lastSeenAt,
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to get user status from TDLib, falling back to cache');

        // Fall back to cached data
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { onlineStatus: true, lastSeenAt: true },
        });

        if (!user) {
          return reply.status(404).send({ error: 'User not found' });
        }

        return reply.send({
          status: user.onlineStatus || 'unknown',
          lastSeenAt: user.lastSeenAt,
        });
      }
    } catch (error) {
      logger.error({ error }, 'Get user status failed');
      return reply.status(500).send({ error: 'Failed to get user status' });
    }
  });
}
