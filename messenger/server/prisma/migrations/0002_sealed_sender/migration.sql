-- Sealed-sender + типы сообщений (приватность «вариант 1»).
--
-- post_secret: общий секрет постинга диалога — отправка с ним идёт БЕЗ токена
--   личности, сервер не знает автора (личность внутри E2E-payload).
-- sender_id → NULLABLE: при sealed-отправке автор не сохраняется.
-- type: 'msg' | 'react' — видимый серверу тип (содержимое всё равно E2E).

ALTER TABLE "messenger_conversations" ADD COLUMN "post_secret" TEXT;

ALTER TABLE "messenger_messages" ALTER COLUMN "sender_id" DROP NOT NULL;
ALTER TABLE "messenger_messages" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'msg';
