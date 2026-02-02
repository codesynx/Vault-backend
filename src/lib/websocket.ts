import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

export type WebSocketEvent =
  | { type: 'message:new'; data: MessageEventData }
  | { type: 'message:deleted'; data: MessageDeletedEventData }
  | { type: 'message:edited'; data: MessageEditedEventData }
  | { type: 'message:send_succeeded'; data: MessageSendSucceededEventData }
  | { type: 'message:send_failed'; data: MessageSendFailedEventData }
  | { type: 'messages:read'; data: MessagesReadEventData }
  | { type: 'chat:updated'; data: ChatUpdatedEventData }
  | { type: 'chat:new'; data: ChatNewEventData }
  | { type: 'chat:position_updated'; data: ChatPositionUpdatedEventData }
  | { type: 'forum_topic:updated'; data: ForumTopicUpdatedEventData }
  | { type: 'forum_topic:new'; data: ForumTopicNewEventData }
  | { type: 'typing'; data: TypingEventData }
  | { type: 'connected'; data: { userId: string } }
  | { type: 'error'; data: { message: string } };

export interface MessageEventData {
  id: string;
  chatId: string;
  telegramMessageId: string;
  senderId: string;
  content: string;
  isOutgoing: boolean;
  telegramCreatedAt: string;
  senderName?: string;
  topicId?: string;
  chatType?: string;
  chatTitle?: string;
  sender?: {
    id: string;
    firstName: string;
    lastName: string | null;
    username: string | null;
  };
}

export interface MessageDeletedEventData {
  chatId: string;
  messageIds: string[];
}

export interface MessageEditedEventData {
  chatId: string;
  telegramMessageId: string;
  newContent: string;
  editedAt: string;
}

export interface ChatUpdatedEventData {
  id: string;
  title?: string;
  type?: string;
  isForum?: boolean;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  unreadCount?: number;
}

export interface ChatNewEventData {
  id: string;
  type: string;
  title: string;
  isForum?: boolean;
}

export interface ChatPositionUpdatedEventData {
  chatId: string;
  order: string;
}

export interface TypingEventData {
  chatId: string;
  userId: string;
}

export interface MessageSendSucceededEventData {
  chatId: string;
  oldMessageId: string;
  newMessageId: string;
  telegramCreatedAt: string;
}

export interface MessageSendFailedEventData {
  chatId: string;
  oldMessageId: string;
  errorCode?: number;
  errorMessage: string;
}

export interface MessagesReadEventData {
  chatId: string;
  lastReadMessageId: string;
}

export interface ForumTopicUpdatedEventData {
  chatId: string;
  topicId: string;
  name?: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  isClosed?: boolean;
  isHidden?: boolean;
  unreadCount?: number;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  lastReadInboxId?: string;
}

export interface ForumTopicNewEventData {
  chatId: string;
  topicId: string;
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  isGeneral: boolean;
}

interface UserConnection {
  socket: WebSocket;
  userId: string;
  connectedAt: Date;
}

class WebSocketManager {
  private connections: Map<string, UserConnection[]> = new Map();

  addConnection(userId: string, socket: WebSocket): void {
    const userConnections = this.connections.get(userId) || [];
    userConnections.push({
      socket,
      userId,
      connectedAt: new Date(),
    });
    this.connections.set(userId, userConnections);

    logger.info({ userId, totalConnections: userConnections.length }, 'WebSocket connection added');

    this.send(userId, { type: 'connected', data: { userId } });
  }

  removeConnection(userId: string, socket: WebSocket): void {
    const userConnections = this.connections.get(userId);
    if (!userConnections) return;

    const filtered = userConnections.filter((conn) => conn.socket !== socket);

    if (filtered.length === 0) {
      this.connections.delete(userId);
    } else {
      this.connections.set(userId, filtered);
    }

    logger.info(
      { userId, remainingConnections: filtered.length },
      'WebSocket connection removed'
    );
  }

  send(userId: string, event: WebSocketEvent): void {
    const userConnections = this.connections.get(userId);
    if (!userConnections) {
      logger.debug({ userId, eventType: event.type }, '[DEBUG] WebSocket send - no connections for user');
      return;
    }

    const message = JSON.stringify(event);
    let sentCount = 0;

    for (const conn of userConnections) {
      if (conn.socket.readyState === 1) {
        conn.socket.send(message);
        sentCount++;
      }
    }

    if (event.type === 'message:new' || event.type === 'message:deleted' || event.type === 'message:edited') {
      logger.info({
        userId,
        eventType: event.type,
        sentCount,
        totalConnections: userConnections.length,
        timestamp: new Date().toISOString()
      }, '[DEBUG] WebSocket message sent');
    }
  }

  broadcast(event: WebSocketEvent): void {
    const message = JSON.stringify(event);

    for (const [, userConnections] of this.connections) {
      for (const conn of userConnections) {
        if (conn.socket.readyState === 1) {
          conn.socket.send(message);
        }
      }
    }
  }

  getConnectionCount(userId?: string): number {
    if (userId) {
      return this.connections.get(userId)?.length || 0;
    }

    let total = 0;
    for (const conns of this.connections.values()) {
      total += conns.length;
    }
    return total;
  }

  getConnectedUserIds(): string[] {
    return Array.from(this.connections.keys());
  }
}

export const wsManager = new WebSocketManager();
