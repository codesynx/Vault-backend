import { verifyToken } from '../utils/jwt.js';
import { prisma } from '../lib/prisma.js';
export async function authMiddleware(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.status(401).send({ error: 'Unauthorized', message: 'Missing or invalid token' });
        return;
    }
    const token = authHeader.substring(7);
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
            reply.status(401).send({ error: 'Unauthorized', message: 'Session expired or invalid' });
            return;
        }
        await prisma.session.update({
            where: { id: session.id },
            data: { lastActiveAt: new Date() },
        });
        request.user = payload;
        request.userId = payload.userId;
    }
    catch {
        reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token' });
    }
}
//# sourceMappingURL=auth.js.map