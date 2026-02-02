export declare function startPhoneAuth(phoneNumber: string): Promise<{
    sessionId: string;
    codeInfo?: Record<string, unknown>;
}>;
export declare function resendCode(sessionId: string): Promise<void>;
export declare function verifyCode(sessionId: string, code: string): Promise<{
    needsPassword: boolean;
    userId?: string;
    tokens?: {
        accessToken: string;
        refreshToken: string;
    };
}>;
export declare function verifyPassword(sessionId: string, password: string): Promise<{
    userId: string;
    tokens: {
        accessToken: string;
        refreshToken: string;
    };
}>;
export declare function getAuthStatus(sessionId: string): Promise<{
    step: string;
    codeInfo?: Record<string, unknown>;
}>;
export declare function refreshTokens(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
}>;
export declare function logout(userId: string, sessionId: string): Promise<void>;
//# sourceMappingURL=auth.service.d.ts.map