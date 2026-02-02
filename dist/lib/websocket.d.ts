import type { WebSocket } from 'ws';
export type WebSocketEvent = {
    type: 'message:new';
    data: MessageEventData;
} | {
    type: 'message:deleted';
    data: MessageDeletedEventData;
} | {
    type: 'message:edited';
    data: MessageEditedEventData;
} | {
    type: 'message:send_succeeded';
    data: MessageSendSucceededEventData;
} | {
    type: 'message:send_failed';
    data: MessageSendFailedEventData;
} | {
    type: 'messages:read';
    data: MessagesReadEventData;
} | {
    type: 'chat:updated';
    data: ChatUpdatedEventData;
} | {
    type: 'chat:new';
    data: ChatNewEventData;
} | {
    type: 'chat:position_updated';
    data: ChatPositionUpdatedEventData;
} | {
    type: 'forum_topic:updated';
    data: ForumTopicUpdatedEventData;
} | {
    type: 'forum_topic:new';
    data: ForumTopicNewEventData;
} | {
    type: 'typing';
    data: TypingEventData;
} | {
    type: 'connected';
    data: {
        userId: string;
    };
} | {
    type: 'error';
    data: {
        message: string;
    };
};
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
declare class WebSocketManager {
    private connections;
    addConnection(userId: string, socket: WebSocket): void;
    removeConnection(userId: string, socket: WebSocket): void;
    send(userId: string, event: WebSocketEvent): void;
    broadcast(event: WebSocketEvent): void;
    getConnectionCount(userId?: string): number;
    getConnectedUserIds(): string[];
}
export declare const wsManager: WebSocketManager;
export {};
//# sourceMappingURL=websocket.d.ts.map