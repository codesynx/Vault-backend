import tdl from 'tdl';
import { getTdjson } from 'prebuilt-tdlib';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
let tdlConfigured = false;
async function getTdjsonPath() {
    // Use prebuilt-tdlib which provides the correct library for each platform
    try {
        const prebuiltPath = await getTdjson();
        logger.info({ path: prebuiltPath }, 'Using prebuilt TDLib library');
        return prebuiltPath;
    }
    catch (error) {
        // Fall back to local library for development (macOS only)
        const localPath = resolve(__dirname, '../../../libtdjson.dylib');
        if (existsSync(localPath)) {
            logger.info({ path: localPath }, 'Using local TDLib library');
            return localPath;
        }
        throw new Error('TDLib library not found. Install prebuilt-tdlib or build TDLib manually:\n' +
            '1. npm install prebuilt-tdlib\n' +
            'Or for macOS development:\n' +
            '1. brew install gperf cmake openssl\n' +
            '2. git clone https://github.com/tdlib/td.git /tmp/td\n' +
            '3. cd /tmp/td && mkdir build && cd build\n' +
            '4. cmake -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl ..\n' +
            '5. cmake --build . --target tdjson -- -j4\n' +
            '6. cp /tmp/td/build/libtdjson.dylib ' + resolve(__dirname, '../../../'));
    }
}
// Initialize TDLib once at app startup
export async function initializeTdlib() {
    if (tdlConfigured)
        return;
    const tdjsonPath = await getTdjsonPath();
    tdl.configure({
        tdjson: tdjsonPath,
        verbosityLevel: 1,
    });
    tdlConfigured = true;
    logger.info('TDLib configured globally');
}
export class TdlibClient {
    sessionPath;
    client = null;
    authState = 'authorizationStateWaitTdlibParameters';
    authStateDetails = null;
    updateHandlers = new Map();
    constructor(sessionPath) {
        this.sessionPath = sessionPath;
    }
    async initialize(params = {}) {
        logger.info({ sessionPath: this.sessionPath, timestamp: new Date().toISOString() }, '[DEBUG] TdlibClient.initialize() starting');
        // Ensure TDLib is configured before creating client
        await initializeTdlib();
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] TDLib configured, creating client');
        logger.info({
            databaseDirectory: this.sessionPath,
            filesDirectory: `${this.sessionPath}/files`,
            apiId: config.TELEGRAM_API_ID,
            apiHashLength: config.TELEGRAM_API_HASH?.length || 0,
            hasApiHash: !!config.TELEGRAM_API_HASH,
            device_model: params.device_model || 'Desktop',
            application_version: params.application_version || '1.0.0',
            timestamp: new Date().toISOString()
        }, '[DEBUG] Creating TDLib client with parameters');
        this.client = tdl.createClient({
            databaseDirectory: this.sessionPath,
            filesDirectory: `${this.sessionPath}/files`,
            apiId: config.TELEGRAM_API_ID,
            apiHash: config.TELEGRAM_API_HASH,
            tdlibParameters: {
                system_language_code: 'en',
                device_model: params.device_model || 'Desktop',
                application_version: params.application_version || '1.0.0',
            },
            skipOldUpdates: true,
        });
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] TDLib client created, setting up event handlers');
        this.client.on('update', (update) => {
            this.handleUpdate(update);
        });
        this.client.on('error', (error) => {
            logger.error({
                err: error,
                errMessage: error.message,
                errCode: error.code,
                errStack: error.stack,
                timestamp: new Date().toISOString()
            }, '[DEBUG] TDLib error event received');
        });
        // Wait for TDLib to be ready (reach authorizationStateWaitPhoneNumber or further)
        logger.info({ timestamp: new Date().toISOString() }, '[DEBUG] Waiting for TDLib to reach ready state');
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error({
                    authState: this.authState,
                    authStateDetails: JSON.stringify(this.authStateDetails),
                    timestamp: new Date().toISOString()
                }, '[DEBUG] TDLib initialization timeout');
                reject(new Error(`TDLib initialization timeout. Last state: ${this.authState}`));
            }, 30000);
            const handleAuthState = async () => {
                logger.info({
                    authState: this.authState,
                    authStateDetails: JSON.stringify(this.authStateDetails),
                    timestamp: new Date().toISOString()
                }, '[DEBUG] Checking TDLib ready state in initialize()');
                // Ready states are: WaitPhoneNumber, WaitCode, WaitPassword, Ready
                const readyStates = [
                    'authorizationStateWaitPhoneNumber',
                    'authorizationStateWaitCode',
                    'authorizationStateWaitPassword',
                    'authorizationStateReady',
                ];
                if (readyStates.includes(this.authState)) {
                    logger.info({ authState: this.authState, timestamp: new Date().toISOString() }, '[DEBUG] TDLib reached ready state');
                    clearTimeout(timeout);
                    this.off('updateAuthorizationState', handleAuthState);
                    resolve();
                }
            };
            this.on('updateAuthorizationState', handleAuthState);
            // Check immediately in case we already have the state
            handleAuthState();
        });
        logger.info({
            sessionPath: this.sessionPath,
            authState: this.authState,
            timestamp: new Date().toISOString()
        }, '[DEBUG] TDLib client initialized successfully');
    }
    handleUpdate(update) {
        const updateType = update._;
        // Log all updates for debugging
        if (updateType === 'updateAuthorizationState') {
            const authState = update.authorization_state;
            if (authState && authState._) {
                const previousState = this.authState;
                this.authState = authState._;
                this.authStateDetails = authState;
                logger.info({
                    previousState,
                    newState: this.authState,
                    details: JSON.stringify(authState),
                    timestamp: new Date().toISOString()
                }, '[DEBUG] Authorization state changed');
            }
            else {
                logger.warn({
                    update: JSON.stringify(update),
                    timestamp: new Date().toISOString()
                }, '[DEBUG] Received updateAuthorizationState without valid authorization_state');
            }
        }
        else {
            // Log other important updates
            const importantUpdates = ['updateConnectionState', 'updateOption', 'error'];
            if (importantUpdates.includes(updateType)) {
                logger.info({
                    updateType,
                    update: JSON.stringify(update),
                    timestamp: new Date().toISOString()
                }, '[DEBUG] Received important TDLib update');
            }
        }
        // Call registered handlers for this update type
        const handlers = this.updateHandlers.get(updateType);
        if (handlers && handlers.length > 0) {
            // Create a copy to avoid issues if handlers modify the array
            const handlersCopy = [...handlers];
            for (const handler of handlersCopy) {
                try {
                    handler(update);
                }
                catch (err) {
                    logger.error({ err, updateType, timestamp: new Date().toISOString() }, '[DEBUG] Update handler error');
                }
            }
        }
        // Call wildcard handlers
        const allHandlers = this.updateHandlers.get('*');
        if (allHandlers && allHandlers.length > 0) {
            const handlersCopy = [...allHandlers];
            for (const handler of handlersCopy) {
                try {
                    handler(update);
                }
                catch (err) {
                    logger.error({ err, updateType, timestamp: new Date().toISOString() }, '[DEBUG] Update handler error');
                }
            }
        }
    }
    on(updateType, handler) {
        const handlers = this.updateHandlers.get(updateType) || [];
        handlers.push(handler);
        this.updateHandlers.set(updateType, handlers);
    }
    off(updateType, handler) {
        const handlers = this.updateHandlers.get(updateType);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }
    async invoke(method, params = {}) {
        if (!this.client) {
            logger.error({ method, timestamp: new Date().toISOString() }, '[DEBUG] invoke() called but client not initialized');
            throw new Error('TDLib client not initialized');
        }
        // tdl uses '_' as the method identifier
        const request = { _: method, ...params };
        // Log the request (hide sensitive data like phone numbers in logs)
        const sanitizedParams = { ...params };
        if (sanitizedParams.phone_number) {
            sanitizedParams.phone_number = `${String(sanitizedParams.phone_number).slice(0, 4)}****`;
        }
        if (sanitizedParams.password) {
            sanitizedParams.password = '****';
        }
        if (sanitizedParams.code) {
            sanitizedParams.code = '****';
        }
        logger.info({
            method,
            params: JSON.stringify(sanitizedParams),
            timestamp: new Date().toISOString()
        }, '[DEBUG] TDLib invoke() called');
        try {
            const startTime = Date.now();
            const result = await this.client.invoke(request);
            const duration = Date.now() - startTime;
            logger.info({
                method,
                duration,
                resultType: result?._,
                timestamp: new Date().toISOString()
            }, '[DEBUG] TDLib invoke() completed successfully');
            return result;
        }
        catch (err) {
            const error = err;
            logger.error({
                method,
                params: JSON.stringify(sanitizedParams),
                errMessage: error.message,
                errCode: error.code,
                errType: error._,
                errFull: JSON.stringify(err),
                timestamp: new Date().toISOString()
            }, '[DEBUG] TDLib invoke() failed');
            throw err;
        }
    }
    getAuthState() {
        return this.authState;
    }
    getAuthStateDetails() {
        return this.authStateDetails;
    }
    async setPhoneNumber(phoneNumber) {
        logger.info({
            phoneNumberLength: phoneNumber.length,
            phoneNumberPrefix: phoneNumber.slice(0, 4),
            currentAuthState: this.authState,
            timestamp: new Date().toISOString()
        }, '[DEBUG] setPhoneNumber() called');
        try {
            await this.invoke('setAuthenticationPhoneNumber', {
                phone_number: phoneNumber,
            });
            logger.info({
                postCallAuthState: this.authState,
                timestamp: new Date().toISOString()
            }, '[DEBUG] setPhoneNumber() completed, waiting for state change');
        }
        catch (err) {
            logger.error({
                err: JSON.stringify(err),
                currentAuthState: this.authState,
                timestamp: new Date().toISOString()
            }, '[DEBUG] setPhoneNumber() threw an error');
            throw err;
        }
    }
    async resendCode() {
        logger.info({ currentAuthState: this.authState, timestamp: new Date().toISOString() }, '[DEBUG] resendCode() called');
        await this.invoke('resendAuthenticationCode');
    }
    async checkAuthCode(code) {
        logger.info({ currentAuthState: this.authState, timestamp: new Date().toISOString() }, '[DEBUG] checkAuthCode() called');
        await this.invoke('checkAuthenticationCode', {
            code,
        });
    }
    async checkPassword(password) {
        logger.info({ currentAuthState: this.authState, timestamp: new Date().toISOString() }, '[DEBUG] checkPassword() called');
        await this.invoke('checkAuthenticationPassword', {
            password,
        });
    }
    async getMe() {
        return this.invoke('getMe');
    }
    async getChats(limit = 100) {
        return this.invoke('getChats', {
            limit,
        });
    }
    async getChat(chatId) {
        return this.invoke('getChat', {
            chat_id: chatId,
        });
    }
    async getChatHistory(chatId, fromMessageId = 0, limit = 50) {
        return this.invoke('getChatHistory', {
            chat_id: chatId,
            from_message_id: fromMessageId,
            offset: 0,
            limit,
            only_local: false,
        });
    }
    async sendMessage(chatId, text, replyToMessageId, messageThreadId) {
        return this.invoke('sendMessage', {
            chat_id: chatId,
            message_thread_id: messageThreadId,
            reply_to: replyToMessageId
                ? { _: 'inputMessageReplyToMessage', message_id: replyToMessageId }
                : undefined,
            input_message_content: {
                _: 'inputMessageText',
                text: {
                    _: 'formattedText',
                    text,
                },
            },
        });
    }
    async getUser(userId) {
        return this.invoke('getUser', {
            user_id: userId,
        });
    }
    async getSupergroup(supergroupId) {
        return this.invoke('getSupergroup', {
            supergroup_id: supergroupId,
        });
    }
    async getBasicGroup(basicGroupId) {
        return this.invoke('getBasicGroup', {
            basic_group_id: basicGroupId,
        });
    }
    async getForumTopics(chatId, query = '', offsetDate = 0, offsetMessageId = 0, offsetMessageThreadId = 0, limit = 100) {
        return this.invoke('getForumTopics', {
            chat_id: chatId,
            query,
            offset_date: offsetDate,
            offset_message_id: offsetMessageId,
            offset_message_thread_id: offsetMessageThreadId,
            limit,
        });
    }
    async close() {
        if (this.client) {
            await this.invoke('close');
            this.client = null;
            logger.info('TDLib client closed');
        }
    }
}
//# sourceMappingURL=client.js.map