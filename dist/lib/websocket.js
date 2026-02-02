import { logger } from '../utils/logger.js';
class WebSocketManager {
    connections = new Map();
    addConnection(userId, socket) {
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
    removeConnection(userId, socket) {
        const userConnections = this.connections.get(userId);
        if (!userConnections)
            return;
        const filtered = userConnections.filter((conn) => conn.socket !== socket);
        if (filtered.length === 0) {
            this.connections.delete(userId);
        }
        else {
            this.connections.set(userId, filtered);
        }
        logger.info({ userId, remainingConnections: filtered.length }, 'WebSocket connection removed');
    }
    send(userId, event) {
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
    broadcast(event) {
        const message = JSON.stringify(event);
        for (const [, userConnections] of this.connections) {
            for (const conn of userConnections) {
                if (conn.socket.readyState === 1) {
                    conn.socket.send(message);
                }
            }
        }
    }
    getConnectionCount(userId) {
        if (userId) {
            return this.connections.get(userId)?.length || 0;
        }
        let total = 0;
        for (const conns of this.connections.values()) {
            total += conns.length;
        }
        return total;
    }
    getConnectedUserIds() {
        return Array.from(this.connections.keys());
    }
}
export const wsManager = new WebSocketManager();
//# sourceMappingURL=websocket.js.map