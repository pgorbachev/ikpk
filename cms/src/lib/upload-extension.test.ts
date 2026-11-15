import assert from 'node:assert/strict';
import test from 'node:test';
import { UPLOAD_ALLOWED_EXTENSIONS } from '../../config/plugins';
import { assertStoredUploadExtension, registerUploadExtensionGuard } from './upload-extension';

type UploadFile = {
  originalFilename?: string;
  detectedMimeType?: string;
  mimetype?: string;
};

type FileInfo = { name?: string };

type UploadPayload = {
  data?: { fileInfo?: FileInfo | FileInfo[] };
  files: UploadFile | UploadFile[];
};

type ReplacePayload = {
  data?: { fileInfo?: FileInfo };
  file: UploadFile;
};

/**
 * Admin `/upload`, content API `/api/upload`, and replace (`?id=`) all call
 * `upload` or `replace` on this service. The write stands in for the provider
 * call inside that service, which is what lands a file in public/uploads.
 */
function makeUploadService() {
  const writes: string[] = [];
  const service = {
    async upload(payload: UploadPayload) {
      const files = Array.isArray(payload.files) ? payload.files : [payload.files];
      for (const file of files) writes.push(`upload:${file.originalFilename ?? ''}`);
      return files;
    },
    async replace(id: unknown, payload: ReplacePayload) {
      writes.push(`replace:${String(id)}:${payload.file.originalFilename ?? ''}`);
      return payload.file;
    },
  };
  const strapi = {
    plugin(name: string) {
      assert.equal(name, 'upload');
      return { service: () => service };
    },
  };
  registerUploadExtensionGuard(strapi);
  return { service, writes };
}

const accepted = [
  ['photo.JPG', 'image/jpeg'],
  ['a.jpeg', 'image/jpeg'],
  ['b.png', 'image/png'],
  ['c.webp', 'image/webp'],
] as const;

test('image extension allowlist is jpg, jpeg, png, and webp', () => {
  assert.deepEqual([...UPLOAD_ALLOWED_EXTENSIONS], ['jpg', 'jpeg', 'png', 'webp']);
});

test('accepts a name on the image extension allowlist when it matches the sniffed MIME', async () => {
  const { service, writes } = makeUploadService();
  for (const [name, mime] of accepted) {
    const stored = await service.upload({
      data: {},
      files: { originalFilename: name, detectedMimeType: mime, mimetype: 'application/octet-stream' },
    });
    assert.equal(stored[0]?.originalFilename, name);
  }
  assert.deepEqual(writes, accepted.map(([name]) => `upload:${name}`));
});

test('rejects a name outside the image extension allowlist before the provider write', async () => {
  const cases = [
    ['page.html', 'image/webp'],
    ['app.js', 'image/png'],
    ['icon.svg', 'image/webp'],
    ['page.htm', 'image/png'],
    ['photo', 'image/webp'],
    ['', 'image/png'],
  ] as const;
  for (const [name, mime] of cases) {
    const { service, writes } = makeUploadService();
    await assert.rejects(
      () => service.upload({
        data: {},
        files: { originalFilename: name, detectedMimeType: mime, mimetype: 'image/jpeg' },
      }),
      /разрешённых расширений/,
    );
    assert.deepEqual(writes, []);
  }
});

test('rejects a fileInfo.name override outside the image extension allowlist', async () => {
  const { service, writes } = makeUploadService();
  await assert.rejects(
    () => service.upload({
      data: { fileInfo: { name: 'page.html' } },
      files: { originalFilename: 'photo.jpg', detectedMimeType: 'image/jpeg', mimetype: 'text/html' },
    }),
    /разрешённых расширений/,
  );
  assert.deepEqual(writes, []);
});

test('rejects when either the original name or the fileInfo.name override is outside the allowlist', async () => {
  const { service, writes } = makeUploadService();
  await assert.rejects(
    () => service.upload({
      data: { fileInfo: { name: 'photo.jpg' } },
      files: { originalFilename: 'page.html', detectedMimeType: 'image/jpeg' },
    }),
    /разрешённых расширений/,
  );
  await assert.rejects(
    () => service.upload({
      data: { fileInfo: [{ name: 'cover.png' }, { name: 'app.js' }] },
      files: [
        { originalFilename: 'a.png', detectedMimeType: 'image/png' },
        { originalFilename: 'b.png', detectedMimeType: 'image/png' },
      ],
    }),
    /разрешённых расширений/,
  );
  assert.deepEqual(writes, []);
});

test('accepts a display name without an extension and a jpeg label on a png replacement', async () => {
  const { service, writes } = makeUploadService();
  const titled = await service.upload({
    data: { fileInfo: { name: 'Фото обложки' } },
    files: { originalFilename: 'cover.png', detectedMimeType: 'image/png' },
  });
  assert.equal(titled[0]?.originalFilename, 'cover.png');
  const replaced = await service.replace('9', {
    data: { fileInfo: { name: 'photo.jpg' } },
    file: { originalFilename: 'cover.png', detectedMimeType: 'image/png' },
  });
  assert.equal(replaced.originalFilename, 'cover.png');
  assert.deepEqual(writes, ['upload:cover.png', 'replace:9:cover.png']);
});

test('rejects an extension that does not match the sniffed MIME', async () => {
  const { service, writes } = makeUploadService();
  await assert.rejects(
    () => service.upload({
      data: { fileInfo: { name: 'photo.jpg' } },
      files: { originalFilename: 'photo.jpg', detectedMimeType: 'image/png', mimetype: 'image/jpeg' },
    }),
    /разрешённых расширений/,
  );
  await assert.rejects(
    () => service.upload({
      data: {},
      files: { originalFilename: 'photo.jpg', mimetype: 'image/jpeg' },
    }),
    /разрешённых расширений/,
  );
  assert.deepEqual(writes, []);
});

test('rejects replace when the name is outside the image extension allowlist', async () => {
  const { service, writes } = makeUploadService();
  await assert.rejects(
    () => service.replace('42', {
      data: { fileInfo: { name: 'icon.svg' } },
      file: { originalFilename: 'photo.jpg', detectedMimeType: 'image/jpeg' },
    }),
    /разрешённых расширений/,
  );
  await assert.rejects(
    () => service.replace('42', {
      data: {},
      file: { originalFilename: 'page.htm', detectedMimeType: 'image/webp' },
    }),
    /разрешённых расширений/,
  );
  const stored = await service.replace('7', {
    data: { fileInfo: { name: 'cover.PNG' } },
    file: { originalFilename: 'b.png', detectedMimeType: 'image/png' },
  });
  assert.equal(stored.originalFilename, 'b.png');
  assert.deepEqual(writes, ['replace:7:b.png']);
});

test('lifecycle rejects a stored name outside the image extension allowlist', () => {
  assert.doesNotThrow(() => assertStoredUploadExtension({
    mime: 'image/jpeg',
    name: 'photo.JPG',
    ext: '.jpg',
  }, UPLOAD_ALLOWED_EXTENSIONS));
  assert.throws(
    () => assertStoredUploadExtension({ mime: 'image/webp', name: 'page.html', ext: '.html' }, UPLOAD_ALLOWED_EXTENSIONS),
    /разрешённых расширений/,
  );
  assert.doesNotThrow(() => assertStoredUploadExtension({
    mime: 'image/png',
    name: 'Фото обложки',
    ext: '.png',
  }, UPLOAD_ALLOWED_EXTENSIONS));
  assert.doesNotThrow(() => assertStoredUploadExtension({
    mime: 'image/png',
    name: 'photo.jpg',
    ext: '.png',
  }, UPLOAD_ALLOWED_EXTENSIONS));
  assert.throws(
    () => assertStoredUploadExtension({ mime: 'image/png', name: 'b.png', ext: '.jpg' }, UPLOAD_ALLOWED_EXTENSIONS),
    /разрешённых расширений/,
  );
});
