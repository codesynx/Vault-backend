import { prisma } from '../../prisma.js';
import { logger } from '../../../utils/logger.js';
import { invalidateChatsCache } from '../../redis.js';
async function countLocalTopicUnread(chatId, topicId, lastReadInboxId) {
    try {
        return await prisma.message.count({
            where: {
                chatId: BigInt(chatId),
                forumTopicId: BigInt(topicId),
                telegramMessageId: { gt: BigInt(lastReadInboxId) },
                isOutgoing: false,
                deletedOnTelegram: false,
            },
        });
    }
    catch (error) {
        logger.error({ error, chatId, topicId }, 'Failed to count local topic unread messages');
        return 0;
    }
}
export async function syncForumTopic(chatId, topic) {
    try {
        const info = topic.info;
        // NOTE: We intentionally do NOT use topic.last_message from TDLib to set lastMessagePreview.
        // TDLib returns Telegram's actual last message, but our app only stores messages
        // received after user login. Using TDLib's preview would show messages that don't
        // exist in our archive. Instead, lastMessagePreview is only set by archiveMessage()
        // when we actually archive a message.
        // Handle both message_thread_id (older TDLib) and forum_topic_id (newer TDLib)
        const topicId = info.forum_topic_id ?? info.message_thread_id;
        if (!topicId) {
            logger.error({ chatId, info }, 'Forum topic has no ID');
            return 0;
        }
        // Ensure chat exists before upserting topic
        const chatExists = await prisma.chat.findUnique({ where: { id: BigInt(chatId) } });
        if (!chatExists) {
            logger.warn({ chatId }, 'Chat not found during syncForumTopic, attempting to create placeholder');
            try {
                await prisma.chat.create({
                    data: {
                        id: BigInt(chatId),
                        type: 'supergroup', // default for forums
                        title: 'Unknown Chat', // placeholder
                        isForum: true,
                        unreadCount: 0,
                    }
                });
            }
            catch (e) {
                // Ignore unique constraint error if it was created concurrently
                logger.debug({ chatId, error: e }, 'Chat creation failed (likely exists)');
            }
        }
        // Creator can be a user or a chat
        const creatorUserId = info.creator_id?.user_id
            ? BigInt(info.creator_id.user_id)
            : null;
        // is_closed is in info for getForumTopics response
        const isClosed = info.is_closed ?? false;
        const isHidden = info.is_hidden ?? false;
        const lastReadInboxId = topic.last_read_inbox_message_id || 0;
        const localUnreadCount = await countLocalTopicUnread(chatId, Number(topicId), lastReadInboxId);
        await prisma.forumTopic.upsert({
            where: {
                chatId_id: {
                    chatId: BigInt(chatId),
                    id: BigInt(topicId),
                },
            },
            update: {
                // Update metadata from TDLib, but NOT lastMessagePreview/lastMessageAt/lastMessageId
                // Those are only set by archiveMessage() when we actually archive a message
                name: info.name,
                iconColor: info.icon?.color,
                iconCustomEmojiId: info.icon?.custom_emoji_id,
                isGeneral: info.is_general,
                isOutgoing: info.is_outgoing,
                isClosed,
                isHidden,
                unreadCount: localUnreadCount, // Use local unread count
                lastReadInboxId: BigInt(lastReadInboxId),
                lastReadOutboxId: BigInt(topic.last_read_outbox_message_id),
                updatedAt: new Date(),
            },
            create: {
                id: BigInt(topicId),
                chatId: BigInt(chatId),
                name: info.name,
                iconColor: info.icon?.color,
                iconCustomEmojiId: info.icon?.custom_emoji_id,
                creationDate: new Date(info.creation_date * 1000),
                creatorUserId,
                isGeneral: info.is_general,
                isOutgoing: info.is_outgoing,
                isClosed,
                isHidden,
                unreadCount: localUnreadCount, // Use local unread count
                lastReadInboxId: BigInt(lastReadInboxId),
                lastReadOutboxId: BigInt(topic.last_read_outbox_message_id),
                // Don't set lastMessagePreview/lastMessageAt/lastMessageId here either
                // They will remain null until we actually archive a message for this topic
            },
        });
        logger.debug({ chatId, topicId, name: info.name, localUnreadCount }, 'Forum topic synced');
        return localUnreadCount;
    }
    catch (error) {
        logger.error({ error, chatId, topic }, 'Failed to sync forum topic');
        return 0;
    }
}
export function createForumTopicHandlers(client) {
    return {
        // Called when forum topics are loaded for a chat
        updateForumTopicInfo: async (update) => {
            const chatId = update.chat_id;
            const info = update.info;
            // Handle both message_thread_id (older TDLib) and forum_topic_id (newer TDLib)
            const topicId = info.forum_topic_id ?? info.message_thread_id;
            if (!topicId) {
                logger.error({ chatId, info }, 'Forum topic info has no ID');
                return;
            }
            try {
                // Ensure chat exists
                const chatExists = await prisma.chat.findUnique({ where: { id: BigInt(chatId) } });
                if (!chatExists) {
                    logger.warn({ chatId }, 'Chat not found during updateForumTopicInfo, creating placeholder');
                    try {
                        await prisma.chat.create({
                            data: {
                                id: BigInt(chatId),
                                type: 'supergroup', // default for forums
                                title: 'Unknown Chat',
                                isForum: true,
                                unreadCount: 0,
                            }
                        });
                    }
                    catch (e) {
                        logger.debug({ chatId, error: e }, 'Chat creation failed (likely exists)');
                    }
                }
                const creatorUserId = info.creator_id?.user_id
                    ? BigInt(info.creator_id.user_id)
                    : null;
                await prisma.forumTopic.upsert({
                    where: {
                        chatId_id: {
                            chatId: BigInt(chatId),
                            id: BigInt(topicId),
                        },
                    },
                    update: {
                        name: info.name,
                        iconColor: info.icon?.color,
                        iconCustomEmojiId: info.icon?.custom_emoji_id,
                        isGeneral: info.is_general,
                        isOutgoing: info.is_outgoing,
                        isClosed: info.is_closed ?? undefined,
                        isHidden: info.is_hidden ?? undefined,
                        updatedAt: new Date(),
                    },
                    create: {
                        id: BigInt(topicId),
                        chatId: BigInt(chatId),
                        name: info.name,
                        iconColor: info.icon?.color,
                        iconCustomEmojiId: info.icon?.custom_emoji_id,
                        creationDate: new Date(info.creation_date * 1000),
                        creatorUserId,
                        isGeneral: info.is_general,
                        isOutgoing: info.is_outgoing,
                        isClosed: info.is_closed ?? false,
                        isHidden: info.is_hidden ?? false,
                    },
                });
                logger.debug({ chatId, topicId }, 'Forum topic info updated');
            }
            catch (error) {
                logger.error({ error, chatId, info }, 'Failed to update forum topic info');
            }
        },
        // Called when a forum topic is edited (title/icon changed)
        updateChatActiveStories: async (_update) => {
            // Not relevant for forums, skip
        },
        // Called when a topic is closed/reopened
        updateForumTopicClosed: async (update) => {
            const chatId = update.chat_id;
            const messageThreadId = update.message_thread_id;
            const isClosed = update.is_closed;
            try {
                await prisma.forumTopic.updateMany({
                    where: {
                        chatId: BigInt(chatId),
                        id: BigInt(messageThreadId),
                    },
                    data: {
                        isClosed,
                        updatedAt: new Date(),
                    },
                });
                logger.debug({ chatId, messageThreadId, isClosed }, 'Forum topic closed status updated');
            }
            catch (error) {
                logger.error({ error, chatId, messageThreadId }, 'Failed to update forum topic closed status');
            }
        },
        // Called when a topic is hidden/shown
        updateForumTopicHidden: async (update) => {
            const chatId = update.chat_id;
            const messageThreadId = update.message_thread_id;
            const isHidden = update.is_hidden;
            try {
                await prisma.forumTopic.updateMany({
                    where: {
                        chatId: BigInt(chatId),
                        id: BigInt(messageThreadId),
                    },
                    data: {
                        isHidden,
                        updatedAt: new Date(),
                    },
                });
                logger.debug({ chatId, messageThreadId, isHidden }, 'Forum topic hidden status updated');
            }
            catch (error) {
                logger.error({ error, chatId, messageThreadId }, 'Failed to update forum topic hidden status');
            }
        },
        // Called when unread count changes for a topic
        updateForumTopicUnreadCount: async (update) => {
            const chatId = update.chat_id;
            const messageThreadId = update.message_thread_id;
            try {
                // Fetch fresh topic info from TDLib to get the updated last_read_inbox_message_id
                // This is crucial for calculating the correct local unread count
                let lastReadInboxId = 0;
                try {
                    const tdTopic = await client.invoke('getForumTopic', {
                        chat_id: chatId,
                        message_thread_id: messageThreadId,
                    });
                    if (tdTopic) {
                        // Sync the full topic info including read state
                        return await syncForumTopic(chatId, tdTopic);
                    }
                }
                catch (err) {
                    logger.warn({ err, chatId, messageThreadId }, 'Failed to fetch fresh forum topic info from TDLib');
                    // Fallback to local DB logic below if TDLib fetch fails
                }
                // Fallback: Fetch current topic from DB
                const topic = await prisma.forumTopic.findUnique({
                    where: {
                        chatId_id: {
                            chatId: BigInt(chatId),
                            id: BigInt(messageThreadId),
                        },
                    },
                    select: { lastReadInboxId: true },
                });
                lastReadInboxId = topic ? Number(topic.lastReadInboxId) : 0;
                const localUnreadCount = await countLocalTopicUnread(chatId, messageThreadId, lastReadInboxId);
                const result = await prisma.forumTopic.updateMany({
                    where: {
                        chatId: BigInt(chatId),
                        id: BigInt(messageThreadId),
                    },
                    data: {
                        unreadCount: localUnreadCount,
                        updatedAt: new Date(),
                    },
                });
                if (result.count === 0) {
                    logger.debug({ chatId, messageThreadId }, 'Forum topic not found for unread count update');
                    return 0;
                }
                logger.debug({ chatId, messageThreadId, localUnreadCount }, 'Forum topic unread count updated (fallback)');
                await invalidateChatsCache();
                return localUnreadCount;
            }
            catch (error) {
                logger.error({ error, chatId, messageThreadId }, 'Failed to update forum topic unread count');
                return 0;
            }
        },
    };
}
//# sourceMappingURL=forumTopics.js.map