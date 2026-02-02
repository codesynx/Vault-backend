import type { TdUser, TdUpdate } from '../types.js';
export declare function syncUser(user: TdUser): Promise<void>;
export declare function createUserHandlers(): {
    updateUser: (update: TdUpdate) => Promise<void>;
    updateUserStatus: (update: TdUpdate) => Promise<void>;
};
//# sourceMappingURL=users.d.ts.map