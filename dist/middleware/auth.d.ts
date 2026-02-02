import type { FastifyRequest, FastifyReply } from 'fastify';
import { type JwtPayload } from '../utils/jwt.js';
declare module 'fastify' {
    interface FastifyRequest {
        user?: JwtPayload;
        userId?: string;
    }
}
export declare function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void>;
//# sourceMappingURL=auth.d.ts.map