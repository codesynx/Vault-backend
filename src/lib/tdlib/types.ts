export interface TdlibConfig {
  apiId: number;
  apiHash: string;
  databaseDirectory: string;
  filesDirectory: string;
}

export type AuthorizationState =
  | 'authorizationStateWaitTdlibParameters'
  | 'authorizationStateWaitPhoneNumber'
  | 'authorizationStateWaitCode'
  | 'authorizationStateWaitPassword'
  | 'authorizationStateReady'
  | 'authorizationStateLoggingOut'
  | 'authorizationStateClosing'
  | 'authorizationStateClosed';

export interface TdUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  usernames?: {
    editable_username?: string;
    active_usernames?: string[];
  };
  phone_number?: string;
  is_contact: boolean;
  is_mutual_contact: boolean;
  is_verified: boolean;
  is_bot: boolean;
}

export interface TdChatPosition {
  _: 'chatPosition';
  list: {
    _: string;
  };
  order: string;
  is_pinned: boolean;
  source?: unknown;
}

export interface TdChat {
  id: number;
  type: {
    _: string;
    user_id?: number;
    basic_group_id?: number;
    supergroup_id?: number;
    is_channel?: boolean;
  };
  title: string;
  last_message?: TdMessage;
  unread_count: number;
  last_read_inbox_message_id?: number;
  is_pinned: boolean;
  is_marked_as_unread: boolean;
  is_forum?: boolean;
  positions?: TdChatPosition[];
}

export interface TdForumTopicInfo {
  message_thread_id?: number;
  forum_topic_id?: number;
  name: string;
  icon?: {
    color: number;
    custom_emoji_id?: string;
  };
  creation_date: number;
  creator_id?: {
    _: string;
    user_id?: number;
    chat_id?: number;
  };
  is_general: boolean;
  is_outgoing: boolean;
  is_closed?: boolean;
  is_hidden?: boolean;
}

export interface TdForumTopic {
  info: TdForumTopicInfo;
  last_message?: TdMessage;
  is_pinned: boolean;
  unread_count: number;
  last_read_inbox_message_id: number;
  last_read_outbox_message_id: number;
  unread_mention_count: number;
  unread_reaction_count: number;
  notification_settings?: unknown;
  draft_message?: unknown;
}

export interface TdMessage {
  id: number;
  chat_id: number;
  message_thread_id?: number;
  sender_id: {
    _: string;
    user_id?: number;
    chat_id?: number;
  };
  content: {
    _: string;
    text?: {
      text: string;
    };
  };
  date: number;
  edit_date?: number;
  is_outgoing: boolean;
  is_topic_message?: boolean;
  reply_to?: {
    message_id?: number;
  };
  forward_info?: {
    origin?: {
      sender_user_id?: number;
      chat_id?: number;
    };
    date?: number;
  };
}

export interface TdUpdate {
  _: string;
  [key: string]: unknown;
}
