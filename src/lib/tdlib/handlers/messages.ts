import { prisma } from '../../prisma.js';
import { logger } from '../../../utils/logger.js';
import type { TdMessage, TdUpdate } from '../types.js';
import { invalidateMessagesCache, invalidateChatsCache } from '../../redis.js';

function getSenderId(senderIdObj: TdMessage['sender_id']): bigint {
  if (senderIdObj._ === 'messageSenderUser') {
    return BigInt(senderIdObj.user_id || 0);
  }
  if (senderIdObj._ === 'messageSenderChat') {
    return BigInt(senderIdObj.chat_id || 0);
  }
  return BigInt(0);
}

function extractTextContent(content: TdMessage['content']): string {
  // Cast to any to handle all TDLib message content types
  const c = content as Record<string, unknown>;
  const caption = (c.caption as { text?: string })?.text;

  switch (content._) {
    case 'messageText':
      return content.text?.text || '';
    case 'messagePhoto':
      return caption || '[Photo]';
    case 'messageVideo':
      return caption || '[Video]';
    case 'messageDocument': {
      const doc = c.document as { file_name?: string } | undefined;
      return caption || `[Document${doc?.file_name ? `: ${doc.file_name}` : ''}]`;
    }
    case 'messageAudio':
      return caption || '[Audio]';
    case 'messageVoiceNote':
      return '[Voice message]';
    case 'messageVideoNote':
      return '[Video message]';
    case 'messageSticker': {
      const sticker = c.sticker as { emoji?: string } | undefined;
      return `[Sticker${sticker?.emoji ? ` ${sticker.emoji}` : ''}]`;
    }
    case 'messageAnimation':
      return caption || '[GIF]';
    case 'messageLocation':
      return '[Location]';
    case 'messagePoll': {
      const poll = c.poll as { question?: { text?: string } } | undefined;
      return `[Poll: ${poll?.question?.text || 'Poll'}]`;
    }
    case 'messageContact': {
      const contact = c.contact as { first_name?: string } | undefined;
      return `[Contact: ${contact?.first_name || 'Contact'}]`;
    }
    case 'messageContactRegistered':
      return 'joined Telegram';
    case 'messageChatAddMembers':
      return 'added members';
    case 'messageChatJoinByLink':
      return 'joined via invite link';
    case 'messageChatDeleteMember':
      return 'left the chat';
    case 'messageChatChangeTitle':
      return `changed title to "${(c.title as string) || ''}"`;
    case 'messageChatChangePhoto':
      return 'changed photo';
    case 'messagePinMessage':
      return 'pinned a message';
    case 'messageScreenshotTaken':
      return 'took a screenshot';
    case 'messageCall':
      return '[Call]';
    default:
      // Log unknown content types for debugging
      logger.debug({ contentType: content._ }, 'Unknown message content type');
      return '';
  }
}

export interface ArchiveMessageResult {
  archived: boolean;
  forumTopicId?: string;
  content?: string;
}

export async function archiveMessage(message: TdMessage): Promise<ArchiveMessageResult> {
  const content = extractTextContent(message.content);

  if (!content) {
    logger.debug({ chatId: message.chat_id, messageId: message.id }, '[DEBUG] Skipping message archive - no text content');
    return { archived: false };
  }

  // Skip channel messages - channels are not supported
  // Channel messages have sender_id as messageSenderChat where chat_id equals the message's chat_id
  if (message.sender_id._ === 'messageSenderChat' && message.sender_id.chat_id === message.chat_id) {
    logger.debug({ chatId: message.chat_id, messageId: message.id }, '[DEBUG] Skipping message archive - channel message');
    return { archived: false };
  }

  const senderId = getSenderId(message.sender_id);
  const chatId = BigInt(message.chat_id);

  logger.info({
    chatId: message.chat_id,
    messageId: message.id,
    senderId: senderId.toString(),
    contentPreview: content.slice(0, 50),
    timestamp: new Date().toISOString()
  }, '[DEBUG] Archiving message');

  try {
    const messageDate = new Date(message.date * 1000);

    // For private chats, determine the other user ID
    // - For incoming messages: sender is the other user
    // - For outgoing messages in private chats: chatId equals the other user's ID
    let otherUserId: bigint | null = null;
    if (message.sender_id._ === 'messageSenderUser') {
      if (!message.is_outgoing) {
        // Incoming message - sender is the other user
        otherUserId = senderId;
      } else {
        // Outgoing message in private chat - chatId is the other user's ID
        otherUserId = chatId;
      }
    }

    // Determine chat type from sender_id and chatId
    // Telegram ID format:
    // - Positive: private chat (user_id)
    // - -100XXXXXXXXX: supergroup or channel
    // - Other negative: basic group
    let defaultChatType = 'unknown';
    if (message.sender_id._ === 'messageSenderChat') {
      // If sender is the chat itself, it's likely a channel
      if (message.sender_id.chat_id === message.chat_id) {
        defaultChatType = 'channel';
      } else {
        // Sender is a different chat (e.g., forwarded or group admin posting)
        defaultChatType = 'supergroup';
      }
    } else if (message.sender_id._ === 'messageSenderUser') {
      // For user senders: determine from chatId format
      if (chatId > BigInt(0)) {
        // Positive chatId = private chat
        defaultChatType = 'private';
      } else {
        // Negative chatId = group/supergroup
        // -100XXXXXXXXX format indicates supergroup, otherwise basic group
        const chatIdStr = chatId.toString();
        if (chatIdStr.startsWith('-100')) {
          defaultChatType = 'supergroup';
        } else {
          defaultChatType = 'group';
        }
      }
    }

    // Ensure chat exists and update last message info
    await prisma.chat.upsert({
      where: { id: chatId },
      update: {
        lastMessagePreview: content.substring(0, 255),
        lastMessageAt: messageDate,
        lastMessageId: BigInt(message.id),
        // Update otherUserId if we have it and it wasn't set before
        ...(otherUserId ? { otherUserId } : {}),
      },
      create: {
        id: chatId,
        type: defaultChatType, // Best guess, will be corrected when updateNewChat fires
        title: 'New Chat',
        otherUserId,
        lastMessagePreview: content.substring(0, 255),
        lastMessageAt: messageDate,
        lastMessageId: BigInt(message.id),
      },
    });

    // Ensure sender exists (to satisfy foreign key constraint)
    // Note: actual user data will be synced by syncUser when updateNewMessage handler fetches user info
    if (senderId !== BigInt(0)) {
      await prisma.user.upsert({
        where: { id: senderId },
        update: {},
        create: {
          id: senderId,
          firstName: 'Unknown',
        },
      });
    }

    // Get forum topic ID if this is a topic message
    // Handle both old format (message_thread_id) and new format (topic_id.forum_topic_id)
    const msgAny = message as unknown as Record<string, unknown>;
    const topicIdObj = msgAny.topic_id as { forum_topic_id?: number } | undefined;
    let forumTopicId = topicIdObj?.forum_topic_id
      ? BigInt(topicIdObj.forum_topic_id)
      : message.message_thread_id
        ? BigInt(message.message_thread_id)
        : undefined;

    // Ensure forum topic exists if we have a topic ID (to satisfy foreign key constraint)
    if (forumTopicId) {
      const topicExists = await prisma.forumTopic.findUnique({
        where: {
          chatId_id: {
            chatId,
            id: forumTopicId,
          },
        },
        select: { id: true },
      });

      if (!topicExists) {
        // Create a placeholder topic - will be updated when topics are synced
        try {
          await prisma.forumTopic.create({
            data: {
              id: forumTopicId,
              chatId,
              name: 'Loading...',
              creationDate: new Date(),
              isGeneral: false,
              isOutgoing: false,
              lastMessagePreview: content.substring(0, 255),
              lastMessageAt: messageDate,
              lastMessageId: BigInt(message.id),
            },
          });
          logger.debug({ chatId: chatId.toString(), topicId: forumTopicId.toString() }, 'Created placeholder forum topic');
        } catch {
          // Topic might have been created by another concurrent request, ignore
          logger.debug({ chatId: chatId.toString(), topicId: forumTopicId.toString() }, 'Placeholder topic creation skipped (may already exist)');
        }
      } else {
          // Update the topic's last message info
          await prisma.forumTopic.update({
            where: {
              chatId_id: {
                chatId,
                id: forumTopicId,
              },
            },
            data: {
              lastMessagePreview: content.substring(0, 255),
              lastMessageAt: messageDate,
              lastMessageId: BigInt(message.id),
              lastMessageSenderId: senderId,
            },
          });
          logger.debug({ chatId: chatId.toString(), topicId: forumTopicId.toString() }, 'Updated forum topic last message info');
      }
    }

    await prisma.message.upsert({
      where: {
        chatId_telegramMessageId: {
          chatId,
          telegramMessageId: BigInt(message.id),
        },
      },
      update: {
        content,
        telegramEditedAt: message.edit_date ? new Date(message.edit_date * 1000) : undefined,
        forumTopicId,
        updatedAt: new Date(),
      },
      create: {
        chatId,
        telegramMessageId: BigInt(message.id),
        senderId,
        content,
        contentType: 'text',
        telegramCreatedAt: new Date(message.date * 1000),
        telegramEditedAt: message.edit_date ? new Date(message.edit_date * 1000) : undefined,
        isOutgoing: message.is_outgoing,
        forumTopicId,
        replyToTelegramId: message.reply_to?.message_id
          ? BigInt(message.reply_to.message_id)
          : undefined,
        forwardedFromUserId: message.forward_info?.origin?.sender_user_id
          ? BigInt(message.forward_info.origin.sender_user_id)
          : undefined,
        forwardedFromChatId: message.forward_info?.origin?.chat_id
          ? BigInt(message.forward_info.origin.chat_id)
          : undefined,
        forwardedAt: message.forward_info?.date
          ? new Date(message.forward_info.date * 1000)
          : undefined,
        archivedAt: new Date(),
      },
    });

    logger.info(
      { chatId: message.chat_id, messageId: message.id },
      '[DEBUG] Message archived successfully'
    );

    return {
      archived: true,
      forumTopicId: forumTopicId ? forumTopicId.toString() : undefined,
      content,
    };
  } catch (error) {
    logger.error({
      error: JSON.stringify(error),
      errorMessage: (error as Error).message,
      chatId: message.chat_id,
      messageId: message.id,
      senderId: senderId.toString(),
      timestamp: new Date().toISOString()
    }, '[DEBUG] Failed to archive message');
    return { archived: false };
  }
}

export async function markMessagesAsDeleted(
  chatId: number,
  messageIds: number[]
): Promise<void> {
  try {
    await prisma.message.updateMany({
      where: {
        chatId: BigInt(chatId),
        telegramMessageId: {
          in: messageIds.map((id) => BigInt(id)),
        },
      },
      data: {
        deletedOnTelegram: true,
        deletedOnTelegramAt: new Date(),
      },
    });

    logger.info(
      { chatId, messageIds },
      'Messages marked as deleted (content preserved)'
    );
  } catch (error) {
    logger.error({ error, chatId, messageIds }, 'Failed to mark messages as deleted');
  }
}

export async function archiveMessageEdit(
  chatId: number,
  messageId: number,
  newContent: string
): Promise<void> {
  try {
    const existing = await prisma.message.findUnique({
      where: {
        chatId_telegramMessageId: {
          chatId: BigInt(chatId),
          telegramMessageId: BigInt(messageId),
        },
      },
    });

    if (!existing) {
      return;
    }

    const editHistory = (existing.editHistory as Array<{ content: string; editedAt: string }>) || [];
    editHistory.push({
      content: existing.content,
      editedAt: new Date().toISOString(),
    });

    await prisma.message.update({
      where: {
        chatId_telegramMessageId: {
          chatId: BigInt(chatId),
          telegramMessageId: BigInt(messageId),
        },
      },
      data: {
        content: newContent,
        telegramEditedAt: new Date(),
        editHistory,
      },
    });

    logger.info({ chatId, messageId }, 'Message edit archived');
  } catch (error) {
    logger.error({ error, chatId, messageId }, 'Failed to archive message edit');
  }
}

export function createMessageHandlers() {
  return {
    updateNewMessage: async (update: TdUpdate) => {
      const message = update.message as TdMessage;
      await archiveMessage(message);
      // Invalidate caches
      await invalidateMessagesCache(String(message.chat_id));
      await invalidateChatsCache();
    },

    updateDeleteMessages: async (update: TdUpdate) => {
      const chatId = update.chat_id as number;
      const messageIds = update.message_ids as number[];
      const isPermanent = update.is_permanent as boolean;

      if (isPermanent) {
        await markMessagesAsDeleted(chatId, messageIds);
        // Invalidate messages cache for this chat
        await invalidateMessagesCache(String(chatId));
      }
    },

    updateMessageContent: async (update: TdUpdate) => {
      const chatId = update.chat_id as number;
      const messageId = update.message_id as number;
      const newContent = update.new_content as TdMessage['content'];

      const text = extractTextContent(newContent);
      if (text) {
        await archiveMessageEdit(chatId, messageId, text);
        // Invalidate messages cache for this chat
        await invalidateMessagesCache(String(chatId));
      }
    },
  };
}
