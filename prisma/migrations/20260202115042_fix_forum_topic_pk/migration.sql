-- CreateTable
CREATE TABLE "users" (
    "id" BIGINT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "username" TEXT,
    "phone_number" TEXT,
    "bio" TEXT,
    "is_contact" BOOLEAN NOT NULL DEFAULT false,
    "is_mutual_contact" BOOLEAN NOT NULL DEFAULT false,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_bot" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMP(3),
    "online_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "jwt_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "tdlib_session_path" TEXT,
    "device_info" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "username" TEXT,
    "other_user_id" BIGINT,
    "member_count" INTEGER,
    "description" TEXT,
    "invite_link" TEXT,
    "can_send_messages" BOOLEAN NOT NULL DEFAULT true,
    "is_muted" BOOLEAN NOT NULL DEFAULT false,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "is_forum" BOOLEAN NOT NULL DEFAULT false,
    "position_order" TEXT NOT NULL DEFAULT '0',
    "last_message_id" BIGINT,
    "last_message_at" TIMESTAMP(3),
    "last_message_preview" VARCHAR(255),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "last_read_inbox_id" BIGINT,
    "last_read_outbox_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_members" (
    "id" TEXT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "can_send_messages" BOOLEAN NOT NULL DEFAULT true,
    "can_delete_messages" BOOLEAN NOT NULL DEFAULT false,
    "can_invite_users" BOOLEAN NOT NULL DEFAULT false,
    "can_pin_messages" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "telegram_message_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "forum_topic_id" BIGINT,
    "sender_id" BIGINT NOT NULL,
    "content" TEXT NOT NULL,
    "content_type" TEXT NOT NULL DEFAULT 'text',
    "reply_to_message_id" TEXT,
    "reply_to_telegram_id" BIGINT,
    "forwarded_from_chat_id" BIGINT,
    "forwarded_from_user_id" BIGINT,
    "forwarded_from_message_id" BIGINT,
    "forwarded_at" TIMESTAMP(3),
    "telegram_created_at" TIMESTAMP(3) NOT NULL,
    "telegram_edited_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_on_telegram" BOOLEAN NOT NULL DEFAULT false,
    "deleted_on_telegram_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    "edit_history" JSONB,
    "is_outgoing" BOOLEAN NOT NULL DEFAULT false,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_states" (
    "id" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "last_synced_at" TIMESTAMP(3),
    "last_chat_list_sync" TIMESTAMP(3),
    "tdlib_update_pts" INTEGER,
    "tdlib_update_qts" INTEGER,
    "tdlib_update_date" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_states" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "auth_step" TEXT NOT NULL,
    "session_path" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_topics" (
    "id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "icon_color" INTEGER,
    "icon_custom_emoji_id" TEXT,
    "creation_date" TIMESTAMP(3) NOT NULL,
    "creator_user_id" BIGINT,
    "is_general" BOOLEAN NOT NULL DEFAULT false,
    "is_outgoing" BOOLEAN NOT NULL DEFAULT false,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "last_read_inbox_id" BIGINT,
    "last_read_outbox_id" BIGINT,
    "last_message_id" BIGINT,
    "last_message_at" TIMESTAMP(3),
    "last_message_preview" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_topics_pkey" PRIMARY KEY ("chat_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_jwt_token_key" ON "sessions"("jwt_token");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_key" ON "sessions"("refresh_token");

-- CreateIndex
CREATE INDEX "chats_position_order_idx" ON "chats"("position_order" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "chat_members_chat_id_user_id_key" ON "chat_members"("chat_id", "user_id");

-- CreateIndex
CREATE INDEX "messages_chat_id_telegram_created_at_idx" ON "messages"("chat_id", "telegram_created_at");

-- CreateIndex
CREATE INDEX "messages_sender_id_idx" ON "messages"("sender_id");

-- CreateIndex
CREATE INDEX "messages_deleted_on_telegram_idx" ON "messages"("deleted_on_telegram");

-- CreateIndex
CREATE INDEX "messages_archived_at_idx" ON "messages"("archived_at");

-- CreateIndex
CREATE INDEX "messages_forum_topic_id_idx" ON "messages"("forum_topic_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_chat_id_telegram_message_id_key" ON "messages"("chat_id", "telegram_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_states_user_id_key" ON "sync_states"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_states_phone_number_key" ON "auth_states"("phone_number");

-- CreateIndex
CREATE INDEX "forum_topics_chat_id_idx" ON "forum_topics"("chat_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_forum_topic_id_fkey" FOREIGN KEY ("chat_id", "forum_topic_id") REFERENCES "forum_topics"("chat_id", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_states" ADD CONSTRAINT "sync_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
