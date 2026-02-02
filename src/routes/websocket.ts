import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyToken } from '../utils/jwt.js';
import { prisma } from '../lib/prisma.js';
import { wsManager } from '../lib/websocket.js';
import { logger } from '../utils/logger.js';

interface WebSocketQuery {
  token?: string;
}

export async function websocketRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/ws',
    { websocket: true },
    async (socket, request: FastifyRequest<{ Querystring: WebSocketQuery }>) => {
      const { token } = request.query;

      if (!token) {
        socket.send(JSON.stringify({ type: 'error', data: { message: 'Missing token' } }));
        socket.close(4001, 'Missing token');
        return;
      }

      let userId: string;

      try {
        const payload = verifyToken(token);

        const session = await prisma.session.findFirst({
          where: {
            userId: BigInt(payload.userId),
            jwtToken: token,
            expiresAt: { gt: new Date() },
          },
        });

        if (!session) {
          socket.send(
            JSON.stringify({ type: 'error', data: { message: 'Session expired or invalid' } })
          );
          socket.close(4002, 'Invalid session');
          return;
        }

        userId = payload.userId;

        await prisma.session.update({
          where: { id: session.id },
          data: { lastActiveAt: new Date() },
        });
      } catch (err) {
        logger.error({ err }, 'WebSocket authentication failed');
        socket.send(JSON.stringify({ type: 'error', data: { message: 'Invalid token' } }));
        socket.close(4003, 'Invalid token');
        return;
      }

      wsManager.addConnection(userId, socket);

      socket.on('message', (rawMessage: any) => {
        try {
          const message = JSON.parse(rawMessage.toString());
          handleClientMessage(userId, message);
        } catch {
          logger.warn('Received invalid WebSocket message');
        }
      });

      socket.on('close', () => {
        wsManager.removeConnection(userId, socket);
      });

      socket.on('error', (err: any) => {
        logger.error({ err, userId }, 'WebSocket error');
        wsManager.removeConnection(userId, socket);
      });
    }
  );
}

interface ClientMessage {
  type: string;
  data?: unknown;
}

function handleClientMessage(userId: string, message: ClientMessage): void {
  switch (message.type) {
    case 'ping':
      wsManager.send(userId, { type: 'connected', data: { userId } });
      break;

    default:
      logger.debug({ userId, messageType: message.type }, 'Unknown client message type');
  }
}
