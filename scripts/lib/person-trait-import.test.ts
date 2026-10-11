import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METHOD_AUTHOR_LEGACY_IDS } from './person-trait.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPTS = join(ROOT, 'scripts');
const TEACHERS = JSON.parse(readFileSync(join(ROOT, 'discovery/entities/teachers.json'), 'utf8')) as {
  legacy_id: string | number;
  name: string;
}[];
const METHOD_AUTHOR_IDS = METHOD_AUTHOR_LEGACY_IDS;
const SCHREINER_ID = '63';
const ADMIN_EDITED_ID = '85';
const EXISTING_NULL_TRAIT_ID = '80';
const EXISTING_MISSING_TRAIT_ID = '79';
const ADMIN_TRAIT = 'method-author';
const cachePath = join(SCRIPTS, '.media-cache.json');
const hadMediaCache = existsSync(cachePath);
const previousMediaCache = hadMediaCache ? readFileSync(cachePath) : undefined;

type CapturedRequest = { method: string; legacyId: string; data: Record<string, unknown> };
const creates: CapturedRequest[] = [];
const updates: CapturedRequest[] = [];
let adminRecord: Record<string, unknown>;
const existingRecords = new Map<string, Record<string, unknown>>();
let nextId = 1;
let server: ReturnType<typeof createServer>;
let baseUrl = '';

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

function respond(res: import('node:http').ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

beforeAll(async () => {
  const sourceSchreiner = TEACHERS.find((teacher) => String(teacher.legacy_id) === SCHREINER_ID);
  const sourceAdminEdited = TEACHERS.find((teacher) => String(teacher.legacy_id) === ADMIN_EDITED_ID);
  expect(sourceSchreiner, 'в discovery нет принятого исключения — Шрайнера').toBeDefined();
  expect(sourceAdminEdited, 'в discovery нет seeded-персоны для проверки сохранения правки администратора').toBeDefined();
  for (const id of METHOD_AUTHOR_IDS) {
    expect(TEACHERS.some((teacher) => String(teacher.legacy_id) === id), `в discovery нет специалиста ${id}`).toBe(true);
  }

  adminRecord = {
    id: 700,
    documentId: 'admin-edited-person',
    legacy_id: ADMIN_EDITED_ID,
    name: sourceAdminEdited!.name,
    trait: ADMIN_TRAIT,
    publishedAt: '2026-10-01T00:00:00.000Z',
  };
  existingRecords.set(EXISTING_NULL_TRAIT_ID, {
    id: 701,
    documentId: 'existing-null-trait',
    legacy_id: EXISTING_NULL_TRAIT_ID,
    name: TEACHERS.find((teacher) => String(teacher.legacy_id) === EXISTING_NULL_TRAIT_ID)!.name,
    trait: null,
    publishedAt: '2026-10-01T00:00:00.000Z',
  });
  existingRecords.set(EXISTING_MISSING_TRAIT_ID, {
    id: 702,
    documentId: 'existing-missing-trait',
    legacy_id: EXISTING_MISSING_TRAIT_ID,
    name: TEACHERS.find((teacher) => String(teacher.legacy_id) === EXISTING_MISSING_TRAIT_ID)!.name,
    publishedAt: '2026-10-01T00:00:00.000Z',
  });

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const [, apiPrefix, apiName, documentId] = url.pathname.split('/');
    if (apiPrefix !== 'api' || !apiName) return respond(res, { data: [] });

    if (req.method === 'GET') {
      const legacyId = url.searchParams.get('filters[legacy_id][$eq]');
      if (apiName === 'teachers' && url.searchParams.get('status') !== 'draft') {
        const existing = legacyId === ADMIN_EDITED_ID
          ? adminRecord
          : existingRecords.get(String(legacyId));
        if (existing) return respond(res, { data: [existing] });
      }
      return respond(res, { data: [] });
    }

    const payload = await bodyOf(req);
    const data = payload.data as Record<string, unknown>;
    if (req.method === 'POST') {
      if (apiName === 'teachers') {
        creates.push({ method: req.method, legacyId: String(data.legacy_id), data });
      }
      return respond(res, {
        data: { ...data, id: nextId++, documentId: `${apiName}-${nextId}`, publishedAt: '2026-10-01T00:00:00.000Z' },
      });
    }
    if (req.method === 'PUT' && apiName === 'teachers') {
      updates.push({ method: req.method, legacyId: String(data.legacy_id), data });
      if (documentId === adminRecord.documentId) {
        adminRecord = { ...adminRecord, ...data };
        return respond(res, { data: adminRecord });
      }
      const existing = [...existingRecords.values()].find((record) => record.documentId === documentId);
      if (existing) {
        const updated = { ...existing, ...data };
        existingRecords.set(String(updated.legacy_id), updated);
        return respond(res, { data: updated });
      }
    }
    return respond(res, { data: { ...data, id: nextId++, documentId: `${apiName}-${nextId}` } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock Strapi не получил TCP-порт');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'import.ts', '--skip-media', '--allow-partial'], {
      cwd: SCRIPTS,
      env: { ...process.env, STRAPI_URL: baseUrl, STRAPI_API_TOKEN: 'test-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-100_000); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-100_000); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
  if (result.code !== 0) {
    throw new Error(`импортёр завершился с кодом ${result.code}\n${result.stderr}\n${result.stdout.slice(-5000)}`);
  }
}, 70_000);

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (hadMediaCache && previousMediaCache) writeFileSync(cachePath, previousMediaCache);
  else if (existsSync(cachePath)) unlinkSync(cachePath);
});

describe('D10: trait в живом пути импорта', () => {
  it('CREATE сохраняет разовое первичное деление 11 авторов методик и Шрайнера как преподавателя', () => {
    expect(METHOD_AUTHOR_IDS.size, 'принятое первичное деление должно содержать 11 методистов').toBe(11);
    const createdById = new Map(creates.map((request) => [request.legacyId, request.data]));
    for (const teacher of TEACHERS) {
      const id = String(teacher.legacy_id);
      if ([ADMIN_EDITED_ID, EXISTING_NULL_TRAIT_ID, EXISTING_MISSING_TRAIT_ID].includes(id)) continue;
      const created = createdById.get(id);
      expect(created, `импортёр не создал персону ${id} (${teacher.name})`).toBeDefined();
      const expected = METHOD_AUTHOR_IDS.has(id) ? 'method-author' : 'teacher';
      expect(created!.trait, `CREATE ${id} (${teacher.name}) не передал trait=${expected} в Strapi`).toBe(expected);
    }
  });

  it('UPDATE существующей персоны оставляет trait администратора без изменения', () => {
    const adminUpdate = updates.find((update) => update.legacyId === ADMIN_EDITED_ID);
    expect(adminUpdate, 'импортёр не обновил seeded-персону с ручной правкой администратора').toBeDefined();
    expect(adminUpdate!.data).not.toHaveProperty('trait');
    expect(adminRecord.trait, 'повторный импорт перезаписал ручное значение trait администратора').toBe(ADMIN_TRAIT);
  });

  it('первый импорт классифицирует существующие записи с null или отсутствующим trait', () => {
    for (const id of [EXISTING_NULL_TRAIT_ID, EXISTING_MISSING_TRAIT_ID]) {
      const update = updates.find((request) => request.legacyId === id);
      const expected = METHOD_AUTHOR_IDS.has(id) ? 'method-author' : 'teacher';
      expect(update?.data.trait, `UPDATE ${id} не восстановил первичную классификацию`).toBe(expected);
      expect(existingRecords.get(id)?.trait).toBe(expected);
    }
  });
});
