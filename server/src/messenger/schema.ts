import { z } from 'zod';

// Изменение лимита пользователей мессенджера.
export const setLimitSchema = z.object({
  limit: z.number().int().min(0).max(100000),
});

// Параметр id в пути.
export const idParamSchema = z.object({
  id: z.string().uuid(),
});

// Регистрация по ключу (публично).
export const registerSchema = z.object({
  messengerId: z.string().trim().min(4).max(32),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(6).max(128),
  recoveryEmail: z.string().trim().email().max(160).optional(),
});

// Вход по ключу+паролю (публично).
export const loginSchema = z.object({
  messengerId: z.string().trim().min(4).max(32),
  password: z.string().min(1).max(128),
});

// ── Переписка (по токену мессенджера) ──────────────────────────────────────
export const searchQuerySchema = z.object({ q: z.string().max(80).optional() });
export const createConvSchema = z.object({ participantId: z.string().uuid() });
export const convIdParamSchema = z.object({ id: z.string().uuid() });
export const sendMessageSchema = z.object({
  // Тело несёт уже шифротекст/конверт E2E (для группы — копию на каждого участника),
  // поэтому лимит большой, а не как у открытого текста.
  body: z.string().max(262144).optional(),
  attachmentUrl: z.string().max(500).optional(),
});
export const messagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// E2E: публикация своего публичного ключа.
export const setKeySchema = z.object({
  publicKey: z.string().trim().min(1).max(1000),
});

// Групповой диалог. id участников — UUID (как в createConvSchema), иначе
// не-UUID долетает до Postgres uuid-колонки и даёт 500 вместо чистого 400.
export const createGroupSchema = z.object({
  title: z.string().trim().min(1).max(100),
  participantIds: z.array(z.string().uuid()).min(1).max(100),
});
export const addMemberSchema = z.object({ userId: z.string().uuid() });
