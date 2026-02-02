import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { tdlibManager } from '../lib/tdlib/manager.js';
import { syncUser } from '../lib/tdlib/handlers/users.js';
import { signAccessToken, signRefreshToken, verifyToken } from '../utils/jwt.js';
import { logger } from '../utils/logger.js';
import { invalidateCache } from '../lib/redis.js';
const authSessions = new Map();
export async function startPhoneAuth(phoneNumber) {
    logger.info({ phoneNumber, timestamp: new Date().toISOString() }, '[DEBUG] Starting phone auth');
    let client;
    let sessionId;
    try {
        logger.info({ phoneNumber }, '[DEBUG] About to create auth client');
        const result = await tdlibManager.createAuthClient(phoneNumber);
        client = result.client;
        sessionId = result.sessionId;
        logger.info({ sessionId, phoneNumber }, '[DEBUG] Auth client created successfully');
    }
    catch (createErr) {
        logger.error({ phoneNumber, err: createErr, errMessage: createErr.message, errStack: createErr.stack }, '[DEBUG] Failed to create auth client');
        throw createErr;
    }
    const initialState = client.getAuthState();
    const initialStateDetails = client.getAuthStateDetails();
    logger.info({
        sessionId,
        initialState,
        initialStateDetails: JSON.stringify(initialStateDetails),
        timestamp: new Date().toISOString()
    }, '[DEBUG] Auth client created, checking initial state');
    authSessions.set(sessionId, {
        sessionId,
        phoneNumber,
        authStep: 'phone',
    });
    // Wait for TDLib to be ready and send phone number
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            const lastState = client.getAuthState();
            const lastStateDetails = client.getAuthStateDetails();
            client.off('updateAuthorizationState', onStateUpdate);
            logger.error({
                sessionId,
                lastState,
                lastStateDetails: JSON.stringify(lastStateDetails),
                phoneSentStatus: phoneSent,
                timestamp: new Date().toISOString()
            }, '[DEBUG] Auth timeout - verification code was not received in 60 seconds');
            reject(new Error(`Timeout waiting for verification code. Last state: ${lastState}`));
        }, 60000);
        let phoneSent = false;
        let stateChangeCount = 0;
        const onStateUpdate = async () => {
            stateChangeCount++;
            try {
                const state = client.getAuthState();
                const stateDetails = client.getAuthStateDetails();
                logger.info({
                    sessionId,
                    state,
                    stateDetails: JSON.stringify(stateDetails),
                    phoneSent,
                    stateChangeCount,
                    timestamp: new Date().toISOString()
                }, '[DEBUG] Auth state update received');
                if (state === 'authorizationStateWaitPhoneNumber' && !phoneSent) {
                    phoneSent = true;
                    logger.info({ sessionId, phoneNumber, timestamp: new Date().toISOString() }, '[DEBUG] State is WaitPhoneNumber - about to call setPhoneNumber');
                    try {
                        const startTime = Date.now();
                        await client.setPhoneNumber(phoneNumber);
                        const duration = Date.now() - startTime;
                        logger.info({ sessionId, duration, timestamp: new Date().toISOString() }, '[DEBUG] setPhoneNumber completed successfully');
                        // Check state immediately after setPhoneNumber
                        const postState = client.getAuthState();
                        const postStateDetails = client.getAuthStateDetails();
                        logger.info({
                            sessionId,
                            postState,
                            postStateDetails: JSON.stringify(postStateDetails),
                            timestamp: new Date().toISOString()
                        }, '[DEBUG] State immediately after setPhoneNumber');
                    }
                    catch (phoneErr) {
                        const error = phoneErr;
                        logger.error({
                            sessionId,
                            errMessage: error.message,
                            errCode: error.code,
                            errType: error._,
                            errStack: error.stack,
                            err: JSON.stringify(phoneErr),
                            timestamp: new Date().toISOString()
                        }, '[DEBUG] setPhoneNumber failed with error');
                        throw phoneErr;
                    }
                }
                else if (state === 'authorizationStateWaitCode') {
                    logger.info({ sessionId, timestamp: new Date().toISOString() }, '[DEBUG] Reached authorizationStateWaitCode - verification code should have been sent!');
                    const codeStateDetails = client.getAuthStateDetails();
                    const codeInfo = codeStateDetails?.code_info;
                    logger.info({
                        sessionId,
                        codeInfo: JSON.stringify(codeInfo),
                        fullStateDetails: JSON.stringify(codeStateDetails),
                        timestamp: new Date().toISOString()
                    }, '[DEBUG] Code info received from Telegram');
                    authSessions.set(sessionId, { ...authSessions.get(sessionId), authStep: 'code', codeInfo });
                    clearTimeout(timeout);
                    client.off('updateAuthorizationState', onStateUpdate);
                    resolve();
                }
                else if (state === 'authorizationStateClosed' || state === 'authorizationStateClosing') {
                    logger.error({ sessionId, state, timestamp: new Date().toISOString() }, '[DEBUG] TDLib session closed unexpectedly');
                    clearTimeout(timeout);
                    client.off('updateAuthorizationState', onStateUpdate);
                    reject(new Error('TDLib session closed unexpectedly'));
                }
                else {
                    logger.info({ sessionId, state, phoneSent, timestamp: new Date().toISOString() }, '[DEBUG] Waiting in intermediate state');
                }
            }
            catch (err) {
                const error = err;
                logger.error({
                    sessionId,
                    errMessage: error.message,
                    errStack: error.stack,
                    timestamp: new Date().toISOString()
                }, '[DEBUG] Error in state update handler');
                clearTimeout(timeout);
                client.off('updateAuthorizationState', onStateUpdate);
                reject(err);
            }
        };
        client.on('updateAuthorizationState', onStateUpdate);
        // Check current state immediately
        logger.info({ sessionId, timestamp: new Date().toISOString() }, '[DEBUG] Setting up state listener and checking initial state');
        onStateUpdate();
    });
    const session = authSessions.get(sessionId);
    logger.info({
        sessionId,
        phoneNumber,
        codeInfo: JSON.stringify(session?.codeInfo),
        timestamp: new Date().toISOString()
    }, '[DEBUG] Phone auth completed successfully - code should have been sent');
    return { sessionId, codeInfo: session?.codeInfo };
}
export async function resendCode(sessionId) {
    const session = authSessions.get(sessionId);
    if (!session) {
        throw new Error('Invalid session');
    }
    const client = tdlibManager.getAuthClient(sessionId);
    if (!client) {
        throw new Error('Auth client not found');
    }
    await client.resendCode();
    logger.info({ sessionId }, 'Resend code requested');
}
export async function verifyCode(sessionId, code) {
    const session = authSessions.get(sessionId);
    if (!session) {
        throw new Error('Invalid session');
    }
    const client = tdlibManager.getAuthClient(sessionId);
    if (!client) {
        throw new Error('Auth client not found');
    }
    await client.checkAuthCode(code);
    // Wait for state to update after code verification
    const newState = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            client.off('updateAuthorizationState', onStateUpdate);
            resolve(client.getAuthState());
        }, 5000);
        const onStateUpdate = () => {
            const state = client.getAuthState();
            if (state === 'authorizationStateWaitPassword' || state === 'authorizationStateReady') {
                clearTimeout(timeout);
                client.off('updateAuthorizationState', onStateUpdate);
                resolve(state);
            }
        };
        client.on('updateAuthorizationState', onStateUpdate);
        // Check immediately
        onStateUpdate();
    });
    if (newState === 'authorizationStateWaitPassword') {
        authSessions.set(sessionId, { ...session, authStep: 'password' });
        return { needsPassword: true };
    }
    if (newState === 'authorizationStateReady') {
        const result = await finalizeAuth(sessionId);
        return { ...result, needsPassword: false };
    }
    throw new Error('Unexpected auth state: ' + newState);
}
export async function verifyPassword(sessionId, password) {
    const session = authSessions.get(sessionId);
    if (!session) {
        throw new Error('Invalid session');
    }
    const client = tdlibManager.getAuthClient(sessionId);
    if (!client) {
        throw new Error('Auth client not found');
    }
    await client.checkPassword(password);
    const state = client.getAuthState();
    if (state !== 'authorizationStateReady') {
        throw new Error('Authentication failed');
    }
    return finalizeAuth(sessionId);
}
async function finalizeAuth(sessionId) {
    const client = tdlibManager.getAuthClient(sessionId);
    if (!client) {
        throw new Error('Auth client not found');
    }
    const me = (await client.getMe());
    const userId = String(me.id);
    await syncUser(me);
    await tdlibManager.promoteAuthClient(sessionId, userId);
    const dbSessionId = randomUUID();
    const accessToken = signAccessToken({ userId, sessionId: dbSessionId });
    const refreshToken = signRefreshToken({ userId, sessionId: dbSessionId });
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await prisma.session.create({
        data: {
            id: dbSessionId,
            userId: BigInt(userId),
            jwtToken: accessToken,
            refreshToken,
            expiresAt,
            tdlibSessionPath: `user_${userId}`,
        },
    });
    authSessions.delete(sessionId);
    logger.info({ userId }, 'User authenticated successfully');
    return {
        userId,
        tokens: {
            accessToken,
            refreshToken,
        },
    };
}
export async function getAuthStatus(sessionId) {
    const session = authSessions.get(sessionId);
    if (!session) {
        throw new Error('Invalid session');
    }
    return { step: session.authStep, codeInfo: session.codeInfo };
}
export async function refreshTokens(refreshToken) {
    let payload;
    try {
        payload = verifyToken(refreshToken);
    }
    catch {
        throw new Error('Invalid or expired refresh token');
    }
    const session = await prisma.session.findFirst({
        where: {
            id: payload.sessionId,
            userId: BigInt(payload.userId),
            refreshToken,
        },
    });
    if (!session) {
        throw new Error('Session not found or refresh token mismatch');
    }
    // Generate new tokens
    const newAccessToken = signAccessToken({ userId: payload.userId, sessionId: payload.sessionId });
    const newRefreshToken = signRefreshToken({ userId: payload.userId, sessionId: payload.sessionId });
    // Update session with new tokens
    await prisma.session.update({
        where: { id: session.id },
        data: {
            jwtToken: newAccessToken,
            refreshToken: newRefreshToken,
        },
    });
    logger.info({ userId: payload.userId, sessionId: payload.sessionId }, 'Tokens refreshed');
    return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
    };
}
export async function logout(userId, sessionId) {
    await prisma.session.deleteMany({
        where: {
            userId: BigInt(userId),
            id: sessionId,
        },
    });
    const remainingSessions = await prisma.session.count({
        where: { userId: BigInt(userId) },
    });
    if (remainingSessions === 0) {
        await tdlibManager.removeUserClient(userId);
        // Only delete sync state - messages, chats, and chat members are preserved as archive
        await prisma.syncState.deleteMany({
            where: { userId: BigInt(userId) },
        });
        logger.info({ userId }, 'User logged out, messages preserved as archive');
        // Clear only this user's Redis cache
        await Promise.all([
            invalidateCache(`chats:${userId}:*`),
            invalidateCache(`messages:${userId}:*`),
            invalidateCache(`user:${userId}`),
        ]);
        logger.info({ userId }, 'User cache cleared');
    }
    logger.info({ userId, sessionId }, 'User logged out');
}
//# sourceMappingURL=auth.service.js.map