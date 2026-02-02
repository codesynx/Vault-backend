import type { TdMessage, TdUpdate } from '../types.js';
export interface ArchiveMessageResult {
    archived: boolean;
    forumTopicId?: string;
    content?: string;
}
export declare function archiveMessage(message: TdMessage): Promise<ArchiveMessageResult>;
export declare function markMessagesAsDeleted(chatId: number, messageIds: number[]): Promise<void>;
export declare function archiveMessageEdit(chatId: number, messageId: number, newContent: string): Promise<void>;
export declare function createMessageHandlers(): {
    updateNewMessage: (update: TdUpdate) => Promise<void>;
    updateDeleteMessages: (update: TdUpdate) => Promise<void>;
    updateMessageContent: (update: TdUpdate) => Promise<void>;
};
//# sourceMappingURL=messages.d.ts.map