import type { TdUpdate, TdForumTopic } from '../types.js';
import type { TdlibClient } from '../client.js';
export declare function syncForumTopic(chatId: number, topic: TdForumTopic): Promise<number>;
export declare function createForumTopicHandlers(client: TdlibClient): {
    updateForumTopicInfo: (update: TdUpdate) => Promise<void>;
    updateChatActiveStories: (_update: TdUpdate) => Promise<void>;
    updateForumTopicClosed: (update: TdUpdate) => Promise<void>;
    updateForumTopicHidden: (update: TdUpdate) => Promise<void>;
    updateForumTopicUnreadCount: (update: TdUpdate) => Promise<number>;
};
//# sourceMappingURL=forumTopics.d.ts.map