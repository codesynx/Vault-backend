import type { AuthorizationState } from './types.js';
interface TdUpdate {
    _: string;
    [key: string]: unknown;
}
export declare function initializeTdlib(): Promise<void>;
export declare class TdlibClient {
    private sessionPath;
    private client;
    private authState;
    private authStateDetails;
    private updateHandlers;
    constructor(sessionPath: string);
    initialize(params?: {
        device_model?: string;
        application_version?: string;
    }): Promise<void>;
    private handleUpdate;
    on(updateType: string, handler: (update: TdUpdate) => void): void;
    off(updateType: string, handler: (update: TdUpdate) => void): void;
    invoke<T>(method: string, params?: Record<string, unknown>): Promise<T>;
    getAuthState(): AuthorizationState;
    getAuthStateDetails(): TdUpdate | null;
    setPhoneNumber(phoneNumber: string): Promise<void>;
    resendCode(): Promise<void>;
    checkAuthCode(code: string): Promise<void>;
    checkPassword(password: string): Promise<void>;
    getMe(): Promise<unknown>;
    getChats(limit?: number): Promise<unknown>;
    getChat(chatId: number): Promise<unknown>;
    getChatHistory(chatId: number, fromMessageId?: number, limit?: number): Promise<unknown>;
    sendMessage(chatId: number, text: string, replyToMessageId?: number, messageThreadId?: number): Promise<unknown>;
    getUser(userId: number): Promise<unknown>;
    getSupergroup(supergroupId: number): Promise<unknown>;
    getBasicGroup(basicGroupId: number): Promise<unknown>;
    getForumTopics(chatId: number, query?: string, offsetDate?: number, offsetMessageId?: number, offsetMessageThreadId?: number, limit?: number): Promise<unknown>;
    close(): Promise<void>;
}
export {};
//# sourceMappingURL=client.d.ts.map