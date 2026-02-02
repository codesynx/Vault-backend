import tdl, { type Client } from 'tdl';
import { getTdjson } from 'prebuilt-tdlib';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { AuthorizationState } from './types.js';

// Generic update type for TDLib updates
interface TdUpdate {
  _: string;
  [key: string]: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

let tdlConfigured = false;

async function getTdjsonPath(): Promise<string> {
  // Use prebuilt-tdlib which provides the correct library for each platform
  try {
    const prebuiltPath = await getTdjson();
    logger.info({ path: prebuiltPath }, 'Using prebuilt TDLib library');
    return prebuiltPath;
  } catch (error) {
    // Fall back to local library for development (macOS only)
    const localPath = resolve(__dirname, '../../../libtdjson.dylib');
    if (existsSync(localPath)) {
      logger.info({ path: localPath }, 'Using local TDLib library');
      return localPath;
    }

    throw new Error(
      'TDLib library not found. Install prebuilt-tdlib or build TDLib manually:\n' +
      '1. npm install prebuilt-tdlib\n' +
      'Or for macOS development:\n' +
      '1. brew install gperf cmake openssl\n' +
      '2. git clone https://github.com/tdlib/td.git /tmp/td\n' +
      '3. cd /tmp/td && mkdir build && cd build\n' +
      '4. cmake -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl ..\n' +
      '5. cmake --build . --target tdjson -- -j4\n' +
      '6. cp /tmp/td/build/libtdjson.dylib ' + resolve(__dirname, '../../../')
    );
  }
}

// Initialize TDLib once at app startup
export async function initializeTdlib(): Promise<void> {
  if (tdlConfigured) return;

  const tdjsonPath = await getTdjsonPath();
  tdl.configure({
    tdjson: tdjsonPath,
    verbosityLevel: 1,
  });
  tdlConfigured = true;
  logger.info('TDLib configured globally');
}

export class TdlibClient {
  private client: Client | null = null;
  private authState: AuthorizationState = 'authorizationStateWaitTdlibParameters';
  private authStateDetails: TdUpdate | null = null;
  private updateHandlers: Map<string, ((update: TdUpdate) => void)[]> = new Map();

  constructor(private sessionPath: string) { }

  async initialize(params: { device_model?: string; application_version?: string } = {}): Promise<void> {
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
      this.handleUpdate(update as TdUpdate);
    });

    this.client.on('error', (error: Error & { code?: number }) => {
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
    await new Promise<void>((resolve, reject) => {
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

  private handleUpdate(update: TdUpdate): void {
    const updateType = update._ as string;

    // Log all updates for debugging
    if (updateType === 'updateAuthorizationState') {
      const authState = update.authorization_state as { _: AuthorizationState;[key: string]: unknown } | undefined;
      if (authState && authState._) {
        const previousState = this.authState;
        this.authState = authState._;
        this.authStateDetails = authState as TdUpdate;
        logger.info({
          previousState,
          newState: this.authState,
          details: JSON.stringify(authState),
          timestamp: new Date().toISOString()
        }, '[DEBUG] Authorization state changed');
      } else {
        logger.warn({
          update: JSON.stringify(update),
          timestamp: new Date().toISOString()
        }, '[DEBUG] Received updateAuthorizationState without valid authorization_state');
      }
    } else {
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
        } catch (err) {
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
        } catch (err) {
          logger.error({ err, updateType, timestamp: new Date().toISOString() }, '[DEBUG] Update handler error');
        }
      }
    }
  }

  on(updateType: string, handler: (update: TdUpdate) => void): void {
    const handlers = this.updateHandlers.get(updateType) || [];
    handlers.push(handler);
    this.updateHandlers.set(updateType, handlers);
  }

  off(updateType: string, handler: (update: TdUpdate) => void): void {
    const handlers = this.updateHandlers.get(updateType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  async invoke<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) {
      logger.error({ method, timestamp: new Date().toISOString() }, '[DEBUG] invoke() called but client not initialized');
      throw new Error('TDLib client not initialized');
    }

    // tdl uses '_' as the method identifier
    const request = { _: method, ...params } as Parameters<Client['invoke']>[0];

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
        resultType: (result as { _?: string })?._,
        timestamp: new Date().toISOString()
      }, '[DEBUG] TDLib invoke() completed successfully');

      return result as T;
    } catch (err: unknown) {
      const error = err as Error & { code?: number; _?: string; message?: string };
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

  getAuthState(): AuthorizationState {
    return this.authState;
  }

  getAuthStateDetails(): TdUpdate | null {
    return this.authStateDetails;
  }

  async setPhoneNumber(phoneNumber: string): Promise<void> {
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
    } catch (err) {
      logger.error({
        err: JSON.stringify(err),
        currentAuthState: this.authState,
        timestamp: new Date().toISOString()
      }, '[DEBUG] setPhoneNumber() threw an error');
      throw err;
    }
  }

  async resendCode(): Promise<void> {
    logger.info({ currentAuthState: this.authState, timestamp: new Date().toISOString() }, '[DEBUG] resendCode() called');
    await this.invoke('resendAuthenticationCode');
  }

  async checkAuthCode(code: string): Promise<void> {
    logger.info({ currentAuthState: this.authState, timestamp: new Date().toISOString() }, '[DEBUG] checkAuthCode() called');
    await this.invoke('checkAuthenticationCode', {
      code,
    });
  }

  async checkPassword(password: string): Promise<void> {
    logger.info({ currentAuthState: this.authState, timestamp: new Date().toISOString() }, '[DEBUG] checkPassword() called');
    await this.invoke('checkAuthenticationPassword', {
      password,
    });
  }

  async getMe(): Promise<unknown> {
    return this.invoke('getMe');
  }

  async getChats(limit: number = 100): Promise<unknown> {
    return this.invoke('getChats', {
      limit,
    });
  }

  async getChat(chatId: number): Promise<unknown> {
    return this.invoke('getChat', {
      chat_id: chatId,
    });
  }

  async getChatHistory(
    chatId: number,
    fromMessageId: number = 0,
    limit: number = 50
  ): Promise<unknown> {
    return this.invoke('getChatHistory', {
      chat_id: chatId,
      from_message_id: fromMessageId,
      offset: 0,
      limit,
      only_local: false,
    });
  }

  async sendMessage(chatId: number, text: string, replyToMessageId?: number, messageThreadId?: number): Promise<unknown> {
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

  async getUser(userId: number): Promise<unknown> {
    return this.invoke('getUser', {
      user_id: userId,
    });
  }

  async getSupergroup(supergroupId: number): Promise<unknown> {
    return this.invoke('getSupergroup', {
      supergroup_id: supergroupId,
    });
  }

  async getBasicGroup(basicGroupId: number): Promise<unknown> {
    return this.invoke('getBasicGroup', {
      basic_group_id: basicGroupId,
    });
  }

  async getForumTopics(
    chatId: number,
    query: string = '',
    offsetDate: number = 0,
    offsetMessageId: number = 0,
    offsetMessageThreadId: number = 0,
    limit: number = 100
  ): Promise<unknown> {
    return this.invoke('getForumTopics', {
      chat_id: chatId,
      query,
      offset_date: offsetDate,
      offset_message_id: offsetMessageId,
      offset_message_thread_id: offsetMessageThreadId,
      limit,
    });
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.invoke('close');
      this.client = null;
      logger.info('TDLib client closed');
    }
  }
}
