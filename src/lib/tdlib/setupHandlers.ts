import { TdlibClient } from './client.js';
import { wsManager } from '../websocket.js';
import { prisma } from '../prisma.js';
import { logger } from '../../utils/logger.js';
import { invalidateMessagesCache, invalidateChatsCache } from '../redis.js';
import { createMessageHandlers, archiveMessage } from './handlers/messages.js';
import { createChatHandlers, syncChat } from './handlers/chats.js';
import { createUserHandlers, syncUser } from './handlers/users.js';
import { createForumTopicHandlers, syncForumTopic } from './handlers/forumTopics.js';
import type { TdMessage, TdChat, TdUpdate, TdUser, TdForumTopic } from './types.js';

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
    default:
      return '';
  }
}

function getSenderId(senderIdObj: TdMessage['sender_id']): bigint {
  if (senderIdObj._ === 'messageSenderUser') {
    return BigInt(senderIdObj.user_id || 0);
  }
  if (senderIdObj._ === 'messageSenderChat') {
    return BigInt(senderIdObj.chat_id || 0);
  }
  return BigInt(0);
}

function getChatType(chatType: TdChat['type']): string {
  // Handle supergroup with is_channel flag (channels are supergroups with is_channel=true)
  if (chatType._ === 'chatTypeSupergroup' && chatType.is_channel) {
    return 'channel';
  }

  const typeMap: Record<string, string> = {
    chatTypePrivate: 'private',
    chatTypeBasicGroup: 'group',
    chatTypeSupergroup: 'supergroup',
    chatTypeSecret: 'secret',
  };
  return typeMap[chatType._] || 'unknown';
}

export function setupClientHandlers(client: TdlibClient, userId: string): void {
  const messageHandlers = createMessageHandlers();
  const chatHandlers = createChatHandlers(userId);
  const userHandlers = createUserHandlers();
  const forumTopicHandlers = createForumTopicHandlers(client);

  // Record the time when handlers are set up - only archive messages newer than this
  // Subtract 60 seconds buffer to account for messages that might arrive during setup
  const syncStartTime = Math.floor(Date.now() / 1000) - 60;
  logger.info({ userId, syncStartTime, syncStartTimeISO: new Date(syncStartTime * 1000).toISOString() }, 'Setting up TDLib handlers with sync start time');

  client.on('updateNewMessage', async (update) => {
    const message = update.message as TdMessage;
    const content = extractTextContent(message.content);

    // Skip old messages - only process messages that arrived after sync start
    // This prevents archiving historical messages when TDLib initially syncs
    if (message.date < syncStartTime) {
      logger.debug({
        chatId: message.chat_id,
        messageId: message.id,
        messageDate: message.date,
        messageDateISO: new Date(message.date * 1000).toISOString(),
        syncStartTime,
      }, '[DEBUG] Skipping old message - arrived before sync start');
      return;
    }

    logger.info({
      chatId: message.chat_id,
      messageId: message.id,
      hasContent: !!content,
      contentPreview: content?.slice(0, 50),
      isOutgoing: message.is_outgoing,
      userId,
      timestamp: new Date().toISOString()
    }, '[DEBUG] updateNewMessage received from TDLib');

    const senderId = getSenderId(message.sender_id);
    let senderInfo: { firstName: string; lastName: string | null; username: string | null } | null = null;

    // Fetch and sync user info from TDLib if sender is a user (not a chat)
    if (message.sender_id._ === 'messageSenderUser' && senderId !== BigInt(0)) {
      try {
        const tdUser = await client.getUser(Number(senderId)) as TdUser;
        if (tdUser) {
          await syncUser(tdUser);
          senderInfo = {
            firstName: tdUser.first_name,
            lastName: tdUser.last_name || null,
            username: tdUser.usernames?.editable_username || tdUser.username || null,
          };
        }
      } catch (err) {
        logger.debug({ senderId: senderId.toString(), err }, 'Failed to fetch user info from TDLib');
      }
    }

    // For outgoing messages in private chats, sync the recipient
    // Only for private chats: chat_id > 0 means it's a user ID
    if (message.is_outgoing && message.sender_id._ === 'messageSenderUser' && message.chat_id > 0) {
      try {
        const recipientId = message.chat_id;
        const tdRecipient = await client.getUser(recipientId) as TdUser;
        if (tdRecipient) {
          await syncUser(tdRecipient);
        }
      } catch (err) {
        logger.debug({ recipientId: message.chat_id, err }, 'Failed to fetch recipient user info from TDLib');
      }
    }

    // If we couldn't get from TDLib, try database
    if (!senderInfo && senderId !== BigInt(0)) {
      try {
        const sender = await prisma.user.findUnique({
          where: { id: senderId },
          select: { firstName: true, lastName: true, username: true },
        });
        if (sender && sender.firstName !== 'Unknown') {
          senderInfo = sender;
        }
      } catch {
        // Ignore
      }
    }

    // Fetch and sync chat info to ensure we have correct title and type
    // This is especially important for groups/channels where title comes from the chat
    let chatType: string | undefined;
    let chatTitle: string | undefined;
    try {
      const tdChat = await client.getChat(message.chat_id) as TdChat;
      if (tdChat) {
        // For supergroups, fetch additional info to check if it's a forum
        if (tdChat.type._ === 'chatTypeSupergroup' && tdChat.type.supergroup_id && !tdChat.type.is_channel) {
          try {
            const supergroup = await client.getSupergroup(tdChat.type.supergroup_id) as { is_forum?: boolean };
            if (supergroup && supergroup.is_forum) {
              (tdChat as { is_forum?: boolean }).is_forum = true;
            }
          } catch (err) {
            logger.debug({ supergroupId: tdChat.type.supergroup_id, err }, 'Failed to fetch supergroup info for message');
          }
        }
        await syncChat(tdChat, userId);

        // Capture chat info for WebSocket event
        chatTitle = tdChat.title;
        chatType = getChatType(tdChat.type);
        if (tdChat.is_forum) {
          chatType = 'forum';
        }

        // Skip channel messages entirely - channels are not supported
        if (chatType === 'channel') {
          logger.debug({ chatId: message.chat_id, chatTitle: tdChat.title }, '[DEBUG] Skipping channel message - channels not supported');
          return;
        }

        logger.debug({
          chatId: message.chat_id,
          chatTitle: tdChat.title,
          chatType: tdChat.type._,
          isChannel: tdChat.type.is_channel,
          isForum: tdChat.is_forum,
        }, '[DEBUG] Synced chat info for new message');
      }
    } catch (err) {
      logger.debug({ chatId: message.chat_id, err }, 'Failed to fetch chat info from TDLib');
    }

    // Skip archiving outgoing messages that are still being sent (have sending_state)
    // These will be archived in updateMessageSendSucceeded with their real message ID.
    // Archiving here with the temp ID causes duplicates.
    // However, outgoing messages from OTHER clients (like official Telegram app) don't have sending_state
    // and won't trigger updateMessageSendSucceeded, so we must archive them here.
    const msgAnyForSendingState = message as unknown as { sending_state?: { _: string } };
    const isPendingMessage = msgAnyForSendingState.sending_state != null;

    if (!message.is_outgoing || !isPendingMessage) {
      // Archive: incoming messages OR outgoing messages already sent (from other clients)
      await messageHandlers.updateNewMessage(update);
    } else {
      // Skip: outgoing messages still being sent (will be archived in updateMessageSendSucceeded)
      logger.debug({
        chatId: message.chat_id,
        messageId: message.id,
        sendingState: msgAnyForSendingState.sending_state?._,
      }, '[DEBUG] Skipping message archive for pending outgoing message (will be archived in updateMessageSendSucceeded)');
    }

    if (!content) {
      logger.info({ chatId: message.chat_id, messageId: message.id }, '[DEBUG] Skipping WebSocket - no text content');
      return;
    }

    // Skip message:new for outgoing messages that are still being sent (pending)
    // These are handled by message:send_succeeded. This prevents duplicate messages in the UI.
    if (message.is_outgoing && isPendingMessage) {
      logger.info({ chatId: message.chat_id, messageId: message.id, sendingState: msgAnyForSendingState.sending_state?._ }, '[DEBUG] Skipping message:new WebSocket for pending outgoing message (handled by send_succeeded)');
      return;
    }

    // For outgoing messages that are NOT pending, check if we already handled this message
    // via updateMessageSendSucceeded. If so, skip WebSocket to prevent duplicates.
    // This handles the case where TDLib sends updateNewMessage again after the message is sent.
    if (message.is_outgoing && !isPendingMessage) {
      const existingMessage = await prisma.message.findUnique({
        where: {
          chatId_telegramMessageId: {
            chatId: BigInt(message.chat_id),
            telegramMessageId: BigInt(message.id),
          },
        },
        select: { id: true },
      });
      if (existingMessage) {
        logger.debug({ chatId: message.chat_id, messageId: message.id }, '[DEBUG] Skipping message:new WebSocket for outgoing message already in database');
        return;
      }
    }

    const senderName = senderInfo
      ? [senderInfo.firstName, senderInfo.lastName].filter(Boolean).join(' ')
      : undefined;

    // Get forum topic ID from message (both old and new TDLib format)
    const msgAny = message as unknown as Record<string, unknown>;
    const topicIdObj = msgAny.topic_id as { forum_topic_id?: number } | undefined;
    const forumTopicId = topicIdObj?.forum_topic_id
      ? String(topicIdObj.forum_topic_id)
      : message.message_thread_id
        ? String(message.message_thread_id)
        : undefined;

    const wsConnectionCount = wsManager.getConnectionCount(userId);
    logger.info({
      userId,
      chatId: message.chat_id,
      messageId: message.id,
      forumTopicId,
      wsConnectionCount,
      senderName,
      timestamp: new Date().toISOString()
    }, '[DEBUG] Sending message:new via WebSocket');

    wsManager.send(userId, {
      type: 'message:new',
      data: {
        id: `${message.chat_id}_${message.id}`,
        chatId: String(message.chat_id),
        telegramMessageId: String(message.id),
        senderId: String(senderId),
        content,
        isOutgoing: message.is_outgoing,
        telegramCreatedAt: new Date(message.date * 1000).toISOString(),
        senderName,
        topicId: forumTopicId,
        chatType,
        chatTitle,
        sender: senderInfo ? {
          id: String(senderId),
          firstName: senderInfo.firstName,
          lastName: senderInfo.lastName,
          username: senderInfo.username,
        } : undefined,
      },
    });

    // Send forum_topic:updated if this message is in a forum topic
    if (forumTopicId) {
      wsManager.send(userId, {
        type: 'forum_topic:updated',
        data: {
          chatId: String(message.chat_id),
          topicId: forumTopicId,
          lastMessagePreview: content.substring(0, 255),
          lastMessageAt: new Date(message.date * 1000).toISOString(),
        },
      });
      logger.debug({
        chatId: message.chat_id,
        topicId: forumTopicId,
      }, '[DEBUG] Sent forum_topic:updated for new message');
    }
  });

  client.on('updateDeleteMessages', async (update) => {
    await messageHandlers.updateDeleteMessages(update);

    const chatId = update.chat_id as number;
    const messageIds = update.message_ids as number[];
    const isPermanent = update.is_permanent as boolean;

    if (isPermanent) {
      wsManager.send(userId, {
        type: 'message:deleted',
        data: {
          chatId: String(chatId),
          messageIds: messageIds.map(String),
        },
      });
    }
  });

  client.on('updateMessageContent', async (update) => {
    await messageHandlers.updateMessageContent(update);

    const chatId = update.chat_id as number;
    const messageId = update.message_id as number;
    const newContent = update.new_content as TdMessage['content'];

    const text = extractTextContent(newContent);
    if (text) {
      wsManager.send(userId, {
        type: 'message:edited',
        data: {
          chatId: String(chatId),
          telegramMessageId: String(messageId),
          newContent: text,
          editedAt: new Date().toISOString(),
        },
      });
    }
  });

  // Handle successful message sending - maps temp ID to real ID
  client.on('updateMessageSendSucceeded', async (update) => {
    const message = update.message as TdMessage;
    const oldMessageId = update.old_message_id as number;

    logger.info({
      chatId: message.chat_id,
      oldMessageId,
      newMessageId: message.id,
      timestamp: new Date().toISOString()
    }, '[DEBUG] updateMessageSendSucceeded received');

    // Delete any message that was archived with the temp/old ID to prevent duplicates
    // This handles race conditions where updateNewMessage might have archived the message
    // before we knew it was from this client
    try {
      const deleted = await prisma.message.deleteMany({
        where: {
          chatId: BigInt(message.chat_id),
          telegramMessageId: BigInt(oldMessageId),
        },
      });
      if (deleted.count > 0) {
        logger.debug({
          chatId: message.chat_id,
          oldMessageId,
          deletedCount: deleted.count,
        }, '[DEBUG] Deleted message with temp ID before archiving with real ID');
      }
    } catch (err) {
      logger.warn({ err, chatId: message.chat_id, oldMessageId }, 'Failed to delete temp message');
    }

    // Archive the message with its real ID
    await archiveMessage(message);

    // Invalidate Redis cache so reloads get fresh data with the new message
    await invalidateMessagesCache(String(message.chat_id));
    await invalidateChatsCache();

    // Notify frontend about successful send with ID mapping
    wsManager.send(userId, {
      type: 'message:send_succeeded',
      data: {
        chatId: String(message.chat_id),
        oldMessageId: String(oldMessageId),
        newMessageId: String(message.id),
        telegramCreatedAt: new Date(message.date * 1000).toISOString(),
      },
    });
  });

  // Handle failed message sending
  client.on('updateMessageSendFailed', async (update) => {
    const message = update.message as TdMessage;
    const oldMessageId = update.old_message_id as number;
    const error = update.error as { code?: number; message?: string };

    logger.error({
      chatId: message.chat_id,
      oldMessageId,
      errorCode: error?.code,
      errorMessage: error?.message,
      timestamp: new Date().toISOString()
    }, '[DEBUG] updateMessageSendFailed received');

    // Notify frontend about failed send
    wsManager.send(userId, {
      type: 'message:send_failed',
      data: {
        chatId: String(message.chat_id),
        oldMessageId: String(oldMessageId),
        errorCode: error?.code,
        errorMessage: error?.message || 'Unknown error',
      },
    });
  });

  client.on('updateNewChat', async (update) => {
    const chat = update.chat as TdChat;

    // Skip old chats - only sync chats that have recent activity
    // Check if the last message is recent (within syncStartTime)
    const lastMessageDate = chat.last_message?.date || 0;
    if (lastMessageDate < syncStartTime) {
      logger.debug({
        chatId: chat.id,
        chatTitle: chat.title,
        lastMessageDate,
        lastMessageDateISO: lastMessageDate ? new Date(lastMessageDate * 1000).toISOString() : null,
        syncStartTime,
      }, '[DEBUG] Skipping old chat - last message before sync start');
      return;
    }

    let title = chat.title;
    let chatType = getChatType(chat.type);
    let isForum = chat.is_forum === true;

    // Skip channels entirely - they are not supported
    if (chatType === 'channel') {
      logger.debug({ chatId: chat.id, chatTitle: chat.title }, '[DEBUG] Skipping channel chat - channels not supported');
      return;
    }

    // For supergroups, fetch additional info to check if it's a forum
    if (chat.type._ === 'chatTypeSupergroup' && chat.type.supergroup_id && !chat.type.is_channel) {
      try {
        const supergroup = await client.getSupergroup(chat.type.supergroup_id) as { is_forum?: boolean };
        if (supergroup && supergroup.is_forum) {
          isForum = true;
          chatType = 'forum';
          // Update chat object for syncChat
          (chat as { is_forum?: boolean }).is_forum = true;
        }
        logger.debug({
          chatId: chat.id,
          supergroupId: chat.type.supergroup_id,
          isForum: supergroup?.is_forum,
        }, '[DEBUG] Fetched supergroup info for forum check');
      } catch (err) {
        logger.debug({ supergroupId: chat.type.supergroup_id, err }, 'Failed to fetch supergroup info');
      }
    }

    await chatHandlers.updateNewChat(update);

    // For private chats, fetch and sync the other user's info to ensure we have their name
    if (chat.type._ === 'chatTypePrivate' && chat.type.user_id) {
      try {
        const tdUser = await client.getUser(chat.type.user_id) as TdUser;
        if (tdUser) {
          await syncUser(tdUser);
          // Use the user's name as the chat title if we got it
          const userName = [tdUser.first_name, tdUser.last_name].filter(Boolean).join(' ');
          if (userName) {
            title = userName;
          }
        }
      } catch (err) {
        logger.debug({ userId: chat.type.user_id, err }, 'Failed to fetch user info for new chat');
      }
    }

    wsManager.send(userId, {
      type: 'chat:new',
      data: {
        id: String(chat.id),
        type: chatType,
        title,
        isForum,
      },
    });
  });

  client.on('updateChatTitle', chatHandlers.updateChatTitle);
  client.on('updateChatLastMessage', async (update) => {
    const chatId = update.chat_id as number;
    const lastMessage = update.last_message as TdChat['last_message'];

    // Skip if no last message or if it's an old message
    if (!lastMessage || lastMessage.date < syncStartTime) {
      logger.debug({
        chatId,
        lastMessageDate: lastMessage?.date,
        syncStartTime,
      }, '[DEBUG] Skipping updateChatLastMessage - old message or no message');
      return;
    }

    await chatHandlers.updateChatLastMessage(update);

    // Check if this message is from a forum topic
    // Forum topic messages have topic_id or message_thread_id set
    const msgAny = lastMessage as unknown as Record<string, unknown>;
    const topicIdObj = msgAny.topic_id as { forum_topic_id?: number } | undefined;
    const isForumTopicMessage = topicIdObj?.forum_topic_id || lastMessage.message_thread_id;

    // For forum topic messages, don't send chat:updated with lastMessagePreview
    // The topic preview is handled separately via forum_topic:updated event
    // This prevents all topics from showing the same preview
    if (isForumTopicMessage) {
      logger.debug({
        chatId,
        topicId: topicIdObj?.forum_topic_id || lastMessage.message_thread_id,
      }, '[DEBUG] Skipping chat:updated preview for forum topic message');
      return;
    }

    const preview = extractTextContent(lastMessage.content);
    wsManager.send(userId, {
      type: 'chat:updated',
      data: {
        id: String(chatId),
        lastMessagePreview: preview?.substring(0, 255) || undefined,
        lastMessageAt: new Date(lastMessage.date * 1000).toISOString(),
      },
    });
  });

  client.on('updateChatReadInbox', async (update) => {
    const localUnreadCount = await chatHandlers.updateChatReadInbox(update);

    const chatId = update.chat_id as number;

    wsManager.send(userId, {
      type: 'chat:updated',
      data: {
        id: String(chatId),
        unreadCount: localUnreadCount,
      },
    });
  });

  client.on('updateChatReadOutbox', async (update) => {
    await chatHandlers.updateChatReadOutbox(update);

    const chatId = update.chat_id as number;
    const lastReadOutboxMessageId = update.last_read_outbox_message_id as number;

    // Notify frontend that outgoing messages up to this ID have been read
    wsManager.send(userId, {
      type: 'messages:read',
      data: {
        chatId: String(chatId),
        lastReadMessageId: String(lastReadOutboxMessageId),
      },
    });
  });

  client.on('updateChatPosition', async (update) => {
    const result = await chatHandlers.updateChatPosition(update);

    if (result) {
      wsManager.send(userId, {
        type: 'chat:position_updated',
        data: {
          chatId: result.chatId,
          order: result.order,
        },
      });
    }
  });

  // Handle forum status changes
  client.on('updateChatIsForum', async (update) => {
    await chatHandlers.updateChatIsForum(update);

    const chatId = update.chat_id as number;
    const isForum = update.is_forum as boolean;

    wsManager.send(userId, {
      type: 'chat:updated',
      data: {
        id: String(chatId),
        isForum,
        type: isForum ? 'forum' : 'supergroup',
      },
    });
  });

  client.on('updateUser', userHandlers.updateUser);
  client.on('updateUserStatus', userHandlers.updateUserStatus);

  // Forum topic handlers
  client.on('updateForumTopic', async (update) => {
    const chatId = update.chat_id as number;
    const topic = update.forum_topic as TdForumTopic | undefined;

    // Handle new TDLib format where topic data is directly on update (partial update)
    // This format includes: forum_topic_id, last_read_inbox_message_id, last_read_outbox_message_id, etc.
    if (!topic) {
      const topicId = update.forum_topic_id as number | undefined;
      if (!topicId) {
        logger.warn({ update }, 'Received updateForumTopic without topic or forum_topic_id');
        return;
      }

      // This is a partial update (e.g., read status change) - update DB directly
      const lastReadInboxId = (update.last_read_inbox_message_id as number) || 0;
      const lastReadOutboxId = (update.last_read_outbox_message_id as number) || 0;

      try {
        // Count local unread messages
        const localUnreadCount = await prisma.message.count({
          where: {
            chatId: BigInt(chatId),
            forumTopicId: BigInt(topicId),
            telegramMessageId: { gt: BigInt(lastReadInboxId) },
            isOutgoing: false,
            deletedOnTelegram: false,
          },
        });

        // Update the topic in DB with new read status
        await prisma.forumTopic.updateMany({
          where: {
            chatId: BigInt(chatId),
            id: BigInt(topicId),
          },
          data: {
            lastReadInboxId: BigInt(lastReadInboxId),
            lastReadOutboxId: BigInt(lastReadOutboxId),
            unreadCount: localUnreadCount,
            updatedAt: new Date(),
          },
        });

        logger.debug(
          { chatId, topicId, lastReadInboxId, localUnreadCount },
          'Forum topic read status updated (partial update)'
        );

        // Send updated info to frontend
        wsManager.send(userId, {
          type: 'forum_topic:updated',
          data: {
            chatId: String(chatId),
            topicId: String(topicId),
            unreadCount: localUnreadCount,
            lastReadInboxId: String(lastReadInboxId),
          },
        });

        await invalidateChatsCache();
      } catch (error) {
        logger.error({ error, chatId, topicId }, 'Failed to update forum topic read status');
      }
      return;
    }

    // Handle old TDLib format with full forum_topic object
    // Sync the topic (calculate local unread count and update DB)
    const localUnreadCount = await syncForumTopic(chatId, topic);

    // Get info for WebSocket event
    const info = topic.info;
    const topicId = info.forum_topic_id ?? info.message_thread_id;

    if (topicId) {
      // Send updated info to frontend (including correct unread count)
      wsManager.send(userId, {
        type: 'forum_topic:updated',
        data: {
          chatId: String(chatId),
          topicId: String(topicId),
          unreadCount: localUnreadCount,
        },
      });
    }
  });

  client.on('updateForumTopicInfo', async (update) => {
    await forumTopicHandlers.updateForumTopicInfo(update);

    const chatId = update.chat_id as number;
    const info = update.info as TdForumTopic['info'];

    // Handle both message_thread_id (older TDLib) and forum_topic_id (newer TDLib)
    const topicId = info.forum_topic_id ?? info.message_thread_id;
    if (!topicId) {
      logger.warn({ chatId, info }, 'updateForumTopicInfo: no topic ID found');
      return;
    }

    wsManager.send(userId, {
      type: 'forum_topic:updated',
      data: {
        chatId: String(chatId),
        topicId: String(topicId),
        name: info.name,
        iconColor: info.icon?.color,
        iconCustomEmojiId: info.icon?.custom_emoji_id,
      },
    });
  });

  client.on('updateForumTopicClosed', async (update) => {
    await forumTopicHandlers.updateForumTopicClosed(update);

    const chatId = update.chat_id as number;
    const messageThreadId = update.message_thread_id as number;
    const isClosed = update.is_closed as boolean;

    wsManager.send(userId, {
      type: 'forum_topic:updated',
      data: {
        chatId: String(chatId),
        topicId: String(messageThreadId),
        isClosed,
      },
    });
  });

  client.on('updateForumTopicHidden', async (update) => {
    await forumTopicHandlers.updateForumTopicHidden(update);

    const chatId = update.chat_id as number;
    const messageThreadId = update.message_thread_id as number;
    const isHidden = update.is_hidden as boolean;

    wsManager.send(userId, {
      type: 'forum_topic:updated',
      data: {
        chatId: String(chatId),
        topicId: String(messageThreadId),
        isHidden,
      },
    });
  });

  client.on('updateForumTopicUnreadCount', async (update) => {
    const localUnreadCount = await forumTopicHandlers.updateForumTopicUnreadCount(update);

    const chatId = update.chat_id as number;
    const messageThreadId = update.message_thread_id as number;

    wsManager.send(userId, {
      type: 'forum_topic:updated',
      data: {
        chatId: String(chatId),
        topicId: String(messageThreadId),
        unreadCount: localUnreadCount,
      },
    });
  });

  logger.info({ userId }, 'TDLib handlers set up with WebSocket integration');
}
