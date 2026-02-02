import { prisma } from '../../prisma.js';
import { logger } from '../../../utils/logger.js';
import type { TdUser, TdUpdate } from '../types.js';

export async function syncUser(user: TdUser): Promise<void> {
  try {
    const username = user.usernames?.editable_username || user.username || null;

    await prisma.user.upsert({
      where: { id: BigInt(user.id) },
      update: {
        firstName: user.first_name,
        lastName: user.last_name || null,
        username,
        phoneNumber: user.phone_number || null,
        isContact: user.is_contact,
        isMutualContact: user.is_mutual_contact,
        isVerified: user.is_verified,
        isBot: user.is_bot,
        updatedAt: new Date(),
      },
      create: {
        id: BigInt(user.id),
        firstName: user.first_name,
        lastName: user.last_name || null,
        username,
        phoneNumber: user.phone_number || null,
        isContact: user.is_contact,
        isMutualContact: user.is_mutual_contact,
        isVerified: user.is_verified,
        isBot: user.is_bot,
      },
    });

    logger.debug({ userId: user.id }, 'User synced');
  } catch (error) {
    logger.error({ error, user }, 'Failed to sync user');
  }
}

export function createUserHandlers() {
  return {
    updateUser: async (update: TdUpdate) => {
      const user = update.user as TdUser;
      await syncUser(user);
    },

    updateUserStatus: async (update: TdUpdate) => {
      const userId = update.user_id as number;
      const status = update.status as { '@type': string; was_online?: number };

      let onlineStatus: string;
      let lastSeenAt: Date | null = null;

      switch (status['@type']) {
        case 'userStatusOnline':
          onlineStatus = 'online';
          break;
        case 'userStatusOffline':
          onlineStatus = 'offline';
          if (status.was_online) {
            lastSeenAt = new Date(status.was_online * 1000);
          }
          break;
        case 'userStatusRecently':
          onlineStatus = 'recently';
          break;
        case 'userStatusLastWeek':
          onlineStatus = 'last_week';
          break;
        case 'userStatusLastMonth':
          onlineStatus = 'last_month';
          break;
        default:
          onlineStatus = 'unknown';
      }

      try {
        await prisma.user.update({
          where: { id: BigInt(userId) },
          data: {
            onlineStatus,
            lastSeenAt,
          },
        });
      } catch (error) {
        logger.error({ error, userId }, 'Failed to update user status');
      }
    },
  };
}
