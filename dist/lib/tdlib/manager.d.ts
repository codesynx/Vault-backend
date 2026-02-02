import { TdlibClient } from './client.js';
declare class TdlibManager {
    private clients;
    private authClients;
    getOrCreateClient(userId: string): Promise<TdlibClient>;
    createAuthClient(phoneNumber: string): Promise<{
        client: TdlibClient;
        sessionId: string;
    }>;
    getAuthClient(sessionId: string): TdlibClient | undefined;
    promoteAuthClient(sessionId: string, userId: string): Promise<TdlibClient>;
    removeAuthClient(sessionId: string): Promise<void>;
    removeUserClient(userId: string): Promise<void>;
    getClient(userId: string): TdlibClient | undefined;
    handleTdlibError(userId: string, error: unknown): Promise<never>;
    closeAll(): Promise<void>;
    restoreClients(): Promise<void>;
}
export declare const tdlibManager: TdlibManager;
export {};
//# sourceMappingURL=manager.d.ts.map