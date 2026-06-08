// Абстракция файлового хранилища для загрузки бинарных объектов
// (фото товаров и т.п.). Интерфейс FileStorage скрывает конкретную
// реализацию: MinIO в проде, локальный диск в dev, in-memory в тестах.
//
// Выбор реализации делает фабрика resolveFileStorage() по доступности
// MINIO_ENDPOINT в окружении. Зависимость minio импортируется лениво,
// чтобы тесты/локальный режим не требовали установленного SDK на рантайме.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';

// Признак небезопасного ключа объекта (path traversal / абсолютный путь /
// диск Windows). Используется как дешёвый предварительный guard на уровне
// доменов (chat, updates) и переиспользуется здесь как defense-in-depth.
// Запрещаем: '..', ведущий '/' или '\\', и двоеточие (буква диска C:).
export function isUnsafeStorageKey(key: string): boolean {
  return (
    key.length === 0 ||
    key.includes('..') ||
    key.includes('\\') ||
    key.startsWith('/') ||
    key.includes(':')
  );
}

// Привести произвольное имя (номер документа, имя файла вложения) к безопасному
// сегменту ключа: только [A-Za-z0-9._-], остальное → '_', ограничение длины.
// Единый помощник для chat/documents/products вместо дублирующих регэкспов.
export function safeStorageName(name: string, maxLen = 200): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, maxLen);
}

// Контракт файлового хранилища: загрузить буфер и вернуть публичный URL.
export interface FileStorage {
  upload(
    bucket: string,
    key: string,
    buffer: Buffer,
    mime: string,
  ): Promise<string>;
  // Скачать объект обратно (для отдачи собранных установщиков, этап S3).
  // null — объект не найден.
  download(bucket: string, key: string): Promise<Buffer | null>;
}

// ── MinIO (S3-совместимое) ──────────────────────────────────────────────────
export interface MinioConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  // Базовый публичный URL, по которому отдаются объекты (для формирования ссылки).
  publicBaseUrl?: string;
}

export class MinioFileStorage implements FileStorage {
  // Ленивая инициализация клиента: minio тянем только при первом upload.
  private client: unknown = null;

  constructor(private readonly config: MinioConfig) {}

  private async getClient(): Promise<{
    bucketExists(b: string): Promise<boolean>;
    makeBucket(b: string): Promise<void>;
    putObject(
      b: string,
      k: string,
      buf: Buffer,
      size: number,
      meta: Record<string, string>,
    ): Promise<unknown>;
    getObject(b: string, k: string): Promise<NodeJS.ReadableStream>;
  }> {
    if (this.client) {
      return this.client as never;
    }
    // Ленивый импорт SDK (может отсутствовать в части окружений — это
    // опциональная зависимость; в local-режиме minio не нужен).
    // @ts-expect-error — пакет 'minio' опционален и может быть не установлен.
    const mod = (await import('minio')) as unknown as {
      Client: new (opts: MinioConfig) => unknown;
    };
    this.client = new mod.Client({
      endPoint: this.config.endPoint,
      port: this.config.port,
      useSSL: this.config.useSSL,
      accessKey: this.config.accessKey,
      secretKey: this.config.secretKey,
    });
    return this.client as never;
  }

  async upload(
    bucket: string,
    key: string,
    buffer: Buffer,
    mime: string,
  ): Promise<string> {
    const client = await this.getClient();
    const exists = await client.bucketExists(bucket).catch(() => false);
    if (!exists) {
      await client.makeBucket(bucket);
    }
    await client.putObject(bucket, key, buffer, buffer.length, {
      'Content-Type': mime,
    });
    const scheme = this.config.useSSL ? 'https' : 'http';
    const base =
      this.config.publicBaseUrl ??
      `${scheme}://${this.config.endPoint}:${this.config.port}`;
    return `${base}/${bucket}/${key}`;
  }

  async download(bucket: string, key: string): Promise<Buffer | null> {
    try {
      const client = await this.getClient();
      const stream = await client.getObject(bucket, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch {
      return null; // объект не найден / ошибка чтения
    }
  }
}

// ── Локальный диск ──────────────────────────────────────────────────────────
// Пишет в ./uploads/<bucket>/<key>, отдаёт относительный URL /uploads/...
export class LocalFileStorage implements FileStorage {
  constructor(
    private readonly rootDir: string = join(process.cwd(), 'uploads'),
    private readonly urlPrefix: string = '/uploads',
  ) {}

  // Защита от path traversal (defense-in-depth для всех вызывающих): итоговый
  // абсолютный путь обязан оставаться внутри rootDir. Любой выход за каталог
  // (../, абсолютный ключ, буква диска) → ошибка, файловая операция не выполняется.
  private safePath(bucket: string, key: string): string {
    const root = resolve(this.rootDir);
    const filePath = resolve(root, bucket, key);
    // Совпадение с корнем или вложенность (root + разделитель) — допустимо.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      throw new Error(`Недопустимый путь к объекту хранилища: ${bucket}/${key}`);
    }
    return filePath;
  }

  async upload(
    bucket: string,
    key: string,
    buffer: Buffer,
    _mime: string,
  ): Promise<string> {
    void _mime;
    const filePath = this.safePath(bucket, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return `${this.urlPrefix}/${bucket}/${key}`;
  }

  async download(bucket: string, key: string): Promise<Buffer | null> {
    // safePath бросает при traversal — НЕ глотаем как «файл не найден»,
    // чтобы атака была заметна, а не выглядела как пустой результат.
    const filePath = this.safePath(bucket, key);
    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }
}

// ── In-memory (тесты) ─────────────────────────────────────────────────────────
export class InMemoryFileStorage implements FileStorage {
  // Сохранённые объекты: ключ `${bucket}/${key}` → буфер.
  readonly objects = new Map<string, { buffer: Buffer; mime: string }>();

  async upload(
    bucket: string,
    key: string,
    buffer: Buffer,
    mime: string,
  ): Promise<string> {
    const path = `${bucket}/${key}`;
    this.objects.set(path, { buffer, mime });
    return `memory://${path}`;
  }

  async download(bucket: string, key: string): Promise<Buffer | null> {
    return this.objects.get(`${bucket}/${key}`)?.buffer ?? null;
  }
}

// Параметры фабрики (берутся из env, но передаются явно — тестируемость).
export interface FileStorageConfig {
  minioEndpoint?: string;
  minioPort?: number;
  minioUseSSL?: boolean;
  minioAccessKey?: string;
  minioSecretKey?: string;
}

// Выбор реализации: если FILE_STORAGE=local — всегда локальный диск; иначе если
// задан MINIO_ENDPOINT — MinIO, иначе локальный диск. Для локального хранилища
// каталог берётся из LOCAL_STORAGE_DIR (по умолчанию ./uploads).
export function resolveFileStorage(config: FileStorageConfig): FileStorage {
  const localDir = process.env.LOCAL_STORAGE_DIR;
  const forceLocal = (process.env.FILE_STORAGE ?? '').toLowerCase() === 'local';
  if (!forceLocal && config.minioEndpoint && config.minioEndpoint.length > 0) {
    return new MinioFileStorage({
      endPoint: config.minioEndpoint,
      port: config.minioPort ?? 9000,
      useSSL: config.minioUseSSL ?? false,
      accessKey: config.minioAccessKey ?? 'minioadmin',
      secretKey: config.minioSecretKey ?? 'minioadmin',
    });
  }
  return localDir ? new LocalFileStorage(resolve(localDir)) : new LocalFileStorage();
}
