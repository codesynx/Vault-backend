import { authRoutes } from './auth.js';
import { chatRoutes } from './chats.js';
import { messageRoutes } from './messages.js';
import { userRoutes } from './users.js';
import { websocketRoutes } from './websocket.js';
import { forumTopicRoutes } from './forumTopics.js';
export async function registerRoutes(app) {
    await app.register(authRoutes);
    await app.register(chatRoutes);
    await app.register(messageRoutes);
    await app.register(userRoutes);
    await app.register(websocketRoutes);
    await app.register(forumTopicRoutes);
}
//# sourceMappingURL=index.js.map