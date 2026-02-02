import { z } from 'zod';
import { startPhoneAuth, verifyCode, resendCode, verifyPassword, getAuthStatus, logout, refreshTokens, } from '../services/auth.service.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
const phoneSchema = z.object({
    phoneNumber: z.string().min(10).max(15),
});
const codeSchema = z.object({
    sessionId: z.string().uuid(),
    code: z.string().min(4).max(8),
});
const passwordSchema = z.object({
    sessionId: z.string().uuid(),
    password: z.string().min(1),
});
const statusSchema = z.object({
    sessionId: z.string().uuid(),
});
const resendSchema = z.object({
    sessionId: z.string().uuid(),
});
const refreshSchema = z.object({
    refreshToken: z.string(),
});
// Stricter rate limit config for auth endpoints
const authRateLimit = {
    config: {
        rateLimit: {
            max: 5,
            timeWindow: '1 minute',
        },
    },
};
export async function authRoutes(app) {
    app.post('/api/auth/phone', authRateLimit, async (request, reply) => {
        logger.info({
            body: request.body,
            timestamp: new Date().toISOString()
        }, '[DEBUG] POST /api/auth/phone - request received');
        try {
            const { phoneNumber } = phoneSchema.parse(request.body);
            logger.info({
                phoneNumberLength: phoneNumber.length,
                phoneNumberPrefix: phoneNumber.slice(0, 4),
                timestamp: new Date().toISOString()
            }, '[DEBUG] POST /api/auth/phone - phone number validated, calling startPhoneAuth');
            const result = await startPhoneAuth(phoneNumber);
            logger.info({
                sessionId: result.sessionId,
                hasCodeInfo: !!result.codeInfo,
                codeInfo: JSON.stringify(result.codeInfo),
                timestamp: new Date().toISOString()
            }, '[DEBUG] POST /api/auth/phone - startPhoneAuth completed successfully');
            return reply.send(result);
        }
        catch (error) {
            const err = error;
            logger.error({
                error: JSON.stringify(error),
                errorMessage: err.message,
                errorCode: err.code,
                errorStack: err.stack,
                timestamp: new Date().toISOString()
            }, '[DEBUG] POST /api/auth/phone - failed');
            return reply.status(400).send({
                error: 'AuthError',
                message: error instanceof Error ? error.message : 'Phone authentication failed',
            });
        }
    });
    app.post('/api/auth/code', authRateLimit, async (request, reply) => {
        try {
            const { sessionId, code } = codeSchema.parse(request.body);
            const result = await verifyCode(sessionId, code);
            return reply.send(result);
        }
        catch (error) {
            logger.error({ error }, 'Code verification failed');
            return reply.status(400).send({
                error: 'AuthError',
                message: error instanceof Error ? error.message : 'Code verification failed',
            });
        }
    });
    app.post('/api/auth/resend', authRateLimit, async (request, reply) => {
        try {
            const { sessionId } = resendSchema.parse(request.body);
            await resendCode(sessionId);
            return reply.send({ success: true });
        }
        catch (error) {
            logger.error({ error, message: error.message, code: error.code }, 'Resend code failed');
            return reply.status(400).send({
                error: 'AuthError',
                message: error.message || 'Resend code failed',
                code: error.code
            });
        }
    });
    app.post('/api/auth/password', authRateLimit, async (request, reply) => {
        try {
            const { sessionId, password } = passwordSchema.parse(request.body);
            const result = await verifyPassword(sessionId, password);
            return reply.send(result);
        }
        catch (error) {
            logger.error({ error }, 'Password verification failed');
            return reply.status(400).send({
                error: 'AuthError',
                message: error instanceof Error ? error.message : 'Password verification failed',
            });
        }
    });
    app.get('/api/auth/status', async (request, reply) => {
        try {
            const { sessionId } = statusSchema.parse(request.query);
            const result = await getAuthStatus(sessionId);
            return reply.send(result);
        }
        catch (error) {
            return reply.status(400).send({
                error: 'AuthError',
                message: error instanceof Error ? error.message : 'Invalid session',
            });
        }
    });
    app.post('/api/auth/refresh', async (request, reply) => {
        try {
            const { refreshToken } = refreshSchema.parse(request.body);
            const tokens = await refreshTokens(refreshToken);
            return reply.send(tokens);
        }
        catch (error) {
            logger.error({ error }, 'Token refresh failed');
            return reply.status(401).send({
                error: 'AuthError',
                message: error instanceof Error ? error.message : 'Token refresh failed',
            });
        }
    });
    app.post('/api/auth/logout', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            if (!request.user) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
            await logout(request.user.userId, request.user.sessionId);
            return reply.send({ success: true });
        }
        catch (error) {
            logger.error({ error }, 'Logout failed');
            return reply.status(500).send({
                error: 'LogoutError',
                message: 'Logout failed',
            });
        }
    });
    app.get('/api/me', { preHandler: authMiddleware }, async (request, reply) => {
        try {
            if (!request.userId) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
            const { prisma } = await import('../lib/prisma.js');
            const user = await prisma.user.findUnique({
                where: { id: BigInt(request.userId) },
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    username: true,
                    phoneNumber: true,
                },
            });
            if (!user) {
                return reply.status(404).send({ error: 'User not found' });
            }
            return reply.send({
                id: user.id.toString(),
                firstName: user.firstName,
                lastName: user.lastName,
                username: user.username,
                phoneNumber: user.phoneNumber,
            });
        }
        catch (error) {
            logger.error({ error }, 'Get user failed');
            return reply.status(500).send({ error: 'Internal server error' });
        }
    });
}
//# sourceMappingURL=auth.js.map