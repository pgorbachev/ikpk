import path from 'node:path';
import { errors } from '@strapi/utils';
import {
  UPLOAD_ALLOWED_EXTENSIONS,
  UPLOAD_ALLOWED_MIME_TYPES,
} from '../../config/plugins';

const { ApplicationError } = errors;

const EXTENSION_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const satisfies Record<
  (typeof UPLOAD_ALLOWED_EXTENSIONS)[number],
  (typeof UPLOAD_ALLOWED_MIME_TYPES)[number]
>;

const REJECTION = 'имя файла не проходит проверку разрешённых расширений';

type UploadFile = {
  originalFilename?: unknown;
  detectedMimeType?: unknown;
};

type FileInfo = { name?: unknown };

type UploadPayload = {
  data?: { fileInfo?: FileInfo | FileInfo[] | null };
  files?: UploadFile | UploadFile[] | null;
};

type ReplacePayload = {
  data?: { fileInfo?: FileInfo | null };
  file?: UploadFile | null;
};

type UploadService = {
  upload: (payload: UploadPayload, ...rest: unknown[]) => Promise<unknown>;
  replace: (id: unknown, payload: ReplacePayload, ...rest: unknown[]) => Promise<unknown>;
};

export type UploadExtensionStrapi = {
  plugin(name: string): { service(name: string): UploadService };
};

const guardedServices = new WeakSet<object>();

/**
 * Расширение сохранённого имени. Значение вида `.jpg` — поле `ext`, которое
 * Strapi хранит рядом с именем; `path.extname` считает такую форму пустой.
 */
function extensionOf(filename: string): string {
  const base = path.basename(filename);
  if (/^\.[A-Za-z0-9]+$/.test(base)) return base.slice(1).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function assertExtension(
  filename: string,
  sniffedMime: string,
  allowedExtensions: readonly string[],
): void {
  const extension = extensionOf(filename);
  const expected = EXTENSION_MIME[extension as keyof typeof EXTENSION_MIME];
  if (!allowedExtensions.includes(extension) || expected !== sniffedMime) {
    throw new ApplicationError(REJECTION);
  }
}

function sniffedMimeOf(file: UploadFile): string {
  if (typeof file.detectedMimeType !== 'string') throw new ApplicationError(REJECTION);
  const sniffed = file.detectedMimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!sniffed) throw new ApplicationError(REJECTION);
  return sniffed;
}

function fileInfoAt(fileInfo: FileInfo | FileInfo[] | null | undefined, index: number): FileInfo {
  if (Array.isArray(fileInfo)) {
    const entry = fileInfo[index];
    return entry && typeof entry === 'object' ? entry : {};
  }
  if (index === 0 && fileInfo && typeof fileInfo === 'object') return fileInfo;
  return {};
}

function assertFile(file: UploadFile, info: FileInfo, allowedExtensions: readonly string[]): void {
  const sniffed = sniffedMimeOf(file);
  const original = typeof file.originalFilename === 'string' ? file.originalFilename : '';
  assertExtension(original, sniffed, allowedExtensions);
  if (typeof info.name === 'string' && info.name.length > 0) {
    assertExtension(info.name, sniffed, allowedExtensions);
  }
}

function assertUploadPayload(payload: UploadPayload | undefined, allowedExtensions: readonly string[]): void {
  if (!payload || payload.files == null) return;
  const files = Array.isArray(payload.files) ? payload.files : [payload.files];
  files.forEach((file, index) => {
    assertFile(file, fileInfoAt(payload.data?.fileInfo, index), allowedExtensions);
  });
}

/**
 * Вторая линия для прямого create `plugin::upload.file`: он выполняется уже
 * после записи провайдером. MIME вне списка типов остаётся существующей проверке.
 */
export function assertStoredUploadExtension(
  data: { mime?: unknown; name?: unknown; ext?: unknown },
  allowedExtensions: readonly string[] = UPLOAD_ALLOWED_EXTENSIONS,
): void {
  if (typeof data.mime !== 'string') return;
  const mime = data.mime.toLowerCase();
  if (!(UPLOAD_ALLOWED_MIME_TYPES as readonly string[]).includes(mime)) return;
  if (typeof data.name === 'string') assertExtension(data.name, mime, allowedExtensions);
  if (typeof data.ext === 'string') assertExtension(data.ext, mime, allowedExtensions);
}

/**
 * Admin `/upload`, content API `/api/upload` и замена (`?id=`) входят через эти
 * два метода, до того как `uploadFileAndPersist` записывает файл.
 */
export function registerUploadExtensionGuard(
  strapi: UploadExtensionStrapi,
  allowedExtensions: readonly string[] = UPLOAD_ALLOWED_EXTENSIONS,
): void {
  const service = strapi.plugin('upload').service('upload');
  if (guardedServices.has(service)) return;
  const originalUpload = service.upload.bind(service);
  const originalReplace = service.replace.bind(service);
  service.upload = async (payload, ...rest) => {
    assertUploadPayload(payload, allowedExtensions);
    return originalUpload(payload, ...rest);
  };
  service.replace = async (id, payload, ...rest) => {
    assertUploadPayload({ data: payload?.data, files: payload?.file ?? null }, allowedExtensions);
    return originalReplace(id, payload, ...rest);
  };
  guardedServices.add(service);
}
