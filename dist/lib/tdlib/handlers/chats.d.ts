import type { TdChat, TdUpdate } from '../types.js';
export declare function syncChat(chat: TdChat, userId?: string): Promise<void>;
export declare function createChatHandlers(userId?: string): {
    updateNewChat: (update: TdUpdate) => Promise<void>;
    updateChatPosition: (update: TdUpdate) => Promise<{
        chatId: string;
        order: string;
    } | null>;
    updateChatTitle: (update: TdUpdate) => Promise<void>;
    updateChatLastMessage: (update: TdUpdate) => Promise<void>;
    updateChatReadInbox: (update: TdUpdate) => Promise<number>;
    updateChatReadOutbox: (update: TdUpdate) => Promise<void>;
    updateChatIsForum: (update: TdUpdate) => Promise<void>;
};
//# sourceMappingURL=chats.d.ts.map