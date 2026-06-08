// Белый список вложений + общая ошибка чата. Извлечено из исходного
// SmartStock chat/service.ts (только ChatError и assertAllowedAttachment),
// чтобы мессенджер не тянул весь ERP-слой чата.

export class ChatError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ─── Белый список типов вложений ─────────────────────────────────────────────
// Безопасный набор: изображения, PDF, офисные документы, текст, архивы.
// Проверяем И mime, И расширение имени файла (исполняемые .exe/.html и т.п.
// отсекаются на обоих уровнях). Размерный лимит (25 МБ) живёт в роуте.
const ALLOWED_ATTACHMENT_MIME = new Set<string>([
  // изображения
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // документы
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  // текст
  'text/plain',
  'text/csv',
  // архивы
  'application/zip',
]);

const ALLOWED_ATTACHMENT_EXT = new Set<string>([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'docx',
  'xlsx',
  'txt',
  'csv',
  'zip',
]);

// Многие клиенты (в т.ч. наш multipart-тест) шлют generic-mime для бинарных
// данных — он не считается «подозрительным» сам по себе, решение принимает
// расширение. Реально опасные mime (application/x-msdownload и пр.) в белый
// список не входят и отсекаются.
const NEUTRAL_MIME = new Set<string>(['application/octet-stream', '']);

// Извлечь расширение в нижнем регистре (без точки) из имени файла.
function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

// Проверка вложения по белому списку (mime + расширение). Бросает ChatError(400).
export function assertAllowedAttachment(mime: string, filename: string): void {
  const ext = fileExtension(filename);
  const normalizedMime = (mime || '').toLowerCase().split(';')[0].trim();

  // Расширение обязано быть в белом списке.
  if (!ALLOWED_ATTACHMENT_EXT.has(ext)) {
    throw new ChatError(400, 'UnsupportedFileType', 'Недопустимый тип файла');
  }
  // Mime обязан быть в белом списке либо нейтральным (octet-stream) — но
  // никогда из явно опасных типов (они просто не входят в белый список).
  if (!ALLOWED_ATTACHMENT_MIME.has(normalizedMime) && !NEUTRAL_MIME.has(normalizedMime)) {
    throw new ChatError(400, 'UnsupportedFileType', 'Недопустимый тип файла');
  }
}
