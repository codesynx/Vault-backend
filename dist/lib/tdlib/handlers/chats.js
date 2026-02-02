import { prisma } from '../../prisma.js';
import { logger } from '../../../utils/logger.js';
import { invalidateChatsCache, invalidateChatCache } from '../../redis.js';
// Extract content preview from message (handles text and media)
function extractContentPreview(content) {
    const c = content;
    const caption = c.caption?.text;
    switch (content._) {
        case 'messageText':
            return content.text?.text?.substring(0, 255) || '';
        case 'messagePhoto':
            return caption?.substring(0, 255) || '[Photo]';
        case 'messageVideo':
            return caption?.substring(0, 255) || '[Video]';
        case 'messageDocument': {
            const doc = c.document;
            return caption?.substring(0, 255) || `[Document${doc?.file_name ? `: ${doc.file_name}` : ''}]`;
        }
        case 'messageAudio':
            return caption?.substring(0, 255) || '[Audio]';
        case 'messageVoiceNote':
            return '[Voice message]';
        case 'messageVideoNote':
            return '[Video message]';
        case 'messageSticker': {
            const sticker = c.sticker;
            return `[Sticker${sticker?.emoji ? ` ${sticker.emoji}` : ''}]`;
        }
        case 'messageAnimation':
            return caption?.substring(0, 255) || '[GIF]';
        case 'messageLocation':
            return '[Location]';
        case 'messagePoll': {
            const poll = c.poll;
            return `[Poll: ${poll?.question?.text || 'Poll'}]`;
        }
        default:
            return '';
    }
}
function getChatType(typeObj) {
    // Handle supergroup with is_channel flag (channels are supergroups with is_channel=true)
    if (typeObj._ === 'chatTypeSupergroup' && typeObj.is_channel) {
        return 'channel';
    }
    const typeMap = {
        chatTypePrivate: 'private',
        chatTypeBasicGroup: 'group',
        chatTypeSupergroup: 'supergroup',
        chatTypeSecret: 'secret',
    };
    return typeMap[typeObj._] || 'unknown';
}
function getMainChatListOrder(positions) {
    if (!positions || positions.length === 0) {
        return '0';
    }
    // Find the position for the main chat list (chatListMain)
    const mainPosition = positions.find((pos) => pos.list._ === 'chatListMain');
    return mainPosition?.order || positions[0]?.order || '0';
}
async function countLocalUnread(chatId, lastReadInboxId) {
    try {
        // If we don't have a last read inbox ID, all incoming messages might be unread,
        // but usually this means 0 or very old. If 0, we can assume everything is unread?
        // Or maybe we should trust TDLib's unread count if we have no local messages?
        // For now, let's follow the requirement: count where id > lastReadInboxId.
        return await prisma.message.count({
            where: {
                chatId: BigInt(chatId),
                telegramMessageId: { gt: BigInt(lastReadInboxId) },
                isOutgoing: false,
                // Also exclude deleted messages if we track them
                deletedOnTelegram: false,
            },
        });
    }
    catch (error) {
        logger.error({ error, chatId }, 'Failed to count local unread messages');
        return 0;
    }
}
export async function syncChat(chat, userId) {
    try {
        const chatType = getChatType(chat.type);
        // Skip channels - they are not supported
        if (chatType === 'channel') {
            logger.debug({ chatId: chat.id, title: chat.title }, 'Skipping channel sync - channels not supported');
            return;
        }
        const otherUserId = chat.type.user_id ? BigInt(chat.type.user_id) : null;
        const order = getMainChatListOrder(chat.positions);
        const lastMessagePreview = chat.last_message
            ? extractContentPreview(chat.last_message.content)
            : undefined;
        // Determine if chat is a forum (supergroup with is_forum flag)
        const isForum = chat.is_forum === true;
        // For forums, set type to 'forum' instead of 'supergroup'
        const finalChatType = isForum ? 'forum' : chatType;
        // Calculate local unread count
        const lastReadInboxId = chat.last_read_inbox_message_id || 0;
        const localUnreadCount = await countLocalUnread(chat.id, lastReadInboxId);
        await prisma.chat.upsert({
            where: { id: BigInt(chat.id) },
            update: {
                title: chat.title,
                type: finalChatType,
                otherUserId,
                unreadCount: localUnreadCount, // Use local unread count
                lastReadInboxId: BigInt(lastReadInboxId),
                isPinned: chat.is_pinned,
                isForum,
                order,
                lastMessageAt: chat.last_message ? new Date(chat.last_message.date * 1000) : undefined,
                lastMessagePreview,
                lastMessageId: chat.last_message ? BigInt(chat.last_message.id) : undefined,
                updatedAt: new Date(),
            },
            create: {
                id: BigInt(chat.id),
                type: finalChatType,
                title: chat.title,
                otherUserId,
                unreadCount: localUnreadCount, // Use local unread count
                lastReadInboxId: BigInt(lastReadInboxId),
                isPinned: chat.is_pinned,
                isForum,
                order,
                lastMessageAt: chat.last_message ? new Date(chat.last_message.date * 1000) : undefined,
                lastMessagePreview,
                lastMessageId: chat.last_message ? BigInt(chat.last_message.id) : undefined,
            },
        });
        // Create ChatMember record for the current user if userId is provided
        if (userId) {
            await prisma.chatMember.upsert({
                where: {
                    chatId_userId: {
                        chatId: BigInt(chat.id),
                        userId: BigInt(userId),
                    },
                },
                update: {}, // No updates needed, just ensure it exists
                create: {
                    chatId: BigInt(chat.id),
                    userId: BigInt(userId),
                    role: 'member',
                },
            });
        }
        // Invalidate cache so updated chat info is fetched
        await invalidateChatsCache(userId);
        logger.debug({ chatId: chat.id, chatType, title: chat.title, userId }, 'Chat synced');
    }
    catch (error) {
        logger.error({ error, chat }, 'Failed to sync chat');
    }
}
export function createChatHandlers(userId) {
    return {
        updateNewChat: async (update) => {
            const chat = update.chat;
            await syncChat(chat, userId);
            await invalidateChatsCache(userId);
        },
        updateChatPosition: async (update) => {
            const chatId = update.chat_id;
            const position = update.position;
            // Only update for main chat list
            if (position.list._ !== 'chatListMain') {
                return null;
            }
            const newOrder = position.order;
            const isPinned = position.is_pinned;
            try {
                const result = await prisma.chat.updateMany({
                    where: { id: BigInt(chatId) },
                    data: { order: newOrder, isPinned },
                });
                if (result.count === 0) {
                    logger.debug({ chatId }, 'Chat not in database yet, skipping position update');
                    return null;
                }
                logger.debug({ chatId, newOrder, isPinned }, 'Chat position updated');
                // Invalidate chats cache when position changes
                await invalidateChatsCache();
                return { chatId: String(chatId), order: newOrder };
            }
            catch (error) {
                logger.error({ error, chatId }, 'Failed to update chat position');
                return null;
            }
        },
        updateChatTitle: async (update) => {
            const chatId = update.chat_id;
            const title = update.title;
            try {
                // Use updateMany to avoid P2025 error when chat doesn't exist yet
                const result = await prisma.chat.updateMany({
                    where: { id: BigInt(chatId) },
                    data: { title },
                });
                if (result.count === 0) {
                    logger.debug({ chatId }, 'Chat not in database yet, skipping title update');
                }
                else {
                    await invalidateChatCache(String(chatId));
                }
            }
            catch (error) {
                logger.error({ error, chatId }, 'Failed to update chat title');
            }
        },
        updateChatLastMessage: async (update) => {
            const chatId = update.chat_id;
            const lastMessage = update.last_message;
            if (!lastMessage)
                return;
            const preview = extractContentPreview(lastMessage.content);
            try {
                // Use updateMany to avoid P2025 error when chat doesn't exist yet
                const result = await prisma.chat.updateMany({
                    where: { id: BigInt(chatId) },
                    data: {
                        lastMessageId: BigInt(lastMessage.id),
                        lastMessageAt: new Date(lastMessage.date * 1000),
                        lastMessagePreview: preview || undefined,
                    },
                });
                if (result.count === 0) {
                    logger.debug({ chatId }, 'Chat not in database yet, skipping last message update');
                }
                else {
                    await invalidateChatsCache();
                }
            }
            catch (error) {
                logger.error({ error, chatId }, 'Failed to update chat last message');
            }
        },
        updateChatReadInbox: async (update) => {
            const chatId = update.chat_id;
            // const unreadCount = update.unread_count as number; // We ignore TDLib's unread count
            const lastReadInboxMessageId = update.last_read_inbox_message_id;
            try {
                // Recalculate local unread count
                const localUnreadCount = await countLocalUnread(chatId, lastReadInboxMessageId);
                // Use updateMany to avoid P2025 error when chat doesn't exist yet
                const result = await prisma.chat.updateMany({
                    where: { id: BigInt(chatId) },
                    data: {
                        unreadCount: localUnreadCount,
                        lastReadInboxId: BigInt(lastReadInboxMessageId),
                    },
                });
                if (result.count === 0) {
                    logger.debug({ chatId }, 'Chat not in database yet, skipping read inbox update');
                    return 0;
                }
                else {
                    await invalidateChatsCache();
                    return localUnreadCount;
                }
            }
            catch (error) {
                logger.error({ error, chatId }, 'Failed to update chat read inbox');
                return 0;
            }
        },
        updateChatReadOutbox: async (update) => {
            const chatId = update.chat_id;
            const lastReadOutboxMessageId = update.last_read_outbox_message_id;
            try {
                // Use updateMany to avoid P2025 error when chat doesn't exist yet
                const result = await prisma.chat.updateMany({
                    where: { id: BigInt(chatId) },
                    data: {
                        lastReadOutboxId: BigInt(lastReadOutboxMessageId),
                    },
                });
                if (result.count === 0) {
                    logger.debug({ chatId }, 'Chat not in database yet, skipping read outbox update');
                }
            }
            catch (error) {
                logger.error({ error, chatId }, 'Failed to update chat read outbox');
            }
        },
        updateChatIsForum: async (update) => {
            const chatId = update.chat_id;
            const isForum = update.is_forum;
            try {
                // Update both isForum flag and type
                const newType = isForum ? 'forum' : 'supergroup';
                const result = await prisma.chat.updateMany({
                    where: { id: BigInt(chatId) },
                    data: {
                        isForum,
                        type: newType,
                    },
                });
                if (result.count === 0) {
                    logger.debug({ chatId }, 'Chat not in database yet, skipping is_forum update');
                }
                else {
                    logger.info({ chatId, isForum, newType }, 'Chat is_forum status updated');
                    await invalidateChatsCache();
                    await invalidateChatCache(String(chatId));
                }
            }
            catch (error) {
                logger.error({ error, chatId }, 'Failed to update chat is_forum status');
            }
        },
    };
}
//# sourceMappingURL=chats.js.map