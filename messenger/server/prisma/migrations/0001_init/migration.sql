-- Smartstack Messenger — начальная миграция.
-- Требуется расширение pgcrypto для gen_random_uuid() (в PG 13+ обычно доступно).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateTable organizations
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "messenger_user_limit" INTEGER NOT NULL DEFAULT 15,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable messenger_users
CREATE TABLE "messenger_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "messenger_id" TEXT NOT NULL,
    "display_name" TEXT,
    "password_hash" TEXT,
    "recovery_email" TEXT,
    "public_key" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "registered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messenger_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable messenger_conversations
CREATE TABLE "messenger_conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "is_group" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messenger_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable messenger_participants
CREATE TABLE "messenger_participants" (
    "conversation_id" UUID NOT NULL,
    "messenger_user_id" UUID NOT NULL,
    "last_read_at" TIMESTAMP(3),

    CONSTRAINT "messenger_participants_pkey" PRIMARY KEY ("conversation_id","messenger_user_id")
);

-- CreateTable messenger_messages
CREATE TABLE "messenger_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "attachment_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messenger_messages_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "messenger_users_messenger_id_key" ON "messenger_users"("messenger_id");
CREATE INDEX "messenger_users_organization_id_idx" ON "messenger_users"("organization_id");
CREATE INDEX "messenger_conversations_organization_id_idx" ON "messenger_conversations"("organization_id");
CREATE INDEX "messenger_participants_messenger_user_id_idx" ON "messenger_participants"("messenger_user_id");
CREATE INDEX "messenger_messages_conversation_id_created_at_idx" ON "messenger_messages"("conversation_id","created_at");

-- Foreign keys
ALTER TABLE "messenger_users" ADD CONSTRAINT "messenger_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messenger_conversations" ADD CONSTRAINT "messenger_conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messenger_participants" ADD CONSTRAINT "messenger_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "messenger_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messenger_participants" ADD CONSTRAINT "messenger_participants_messenger_user_id_fkey" FOREIGN KEY ("messenger_user_id") REFERENCES "messenger_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messenger_messages" ADD CONSTRAINT "messenger_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "messenger_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messenger_messages" ADD CONSTRAINT "messenger_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "messenger_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
