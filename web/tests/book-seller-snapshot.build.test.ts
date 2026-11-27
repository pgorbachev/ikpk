import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, WEB_ROOT } from './helpers/cms-content-publication-contract';

const PINNED = join(REPO_ROOT, 'fixtures', 'content-snapshot');
const ASTRO = join(WEB_ROOT, 'node_modules', '.bin', 'astro');
const BOOK_SLUG = 'knigi-i-uchebnye-materialy';
let scratch: string | undefined;

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function root(): string {
  const buildWorkspace = join(WEB_ROOT, '.astro');
  mkdirSync(buildWorkspace, { recursive: true });
  scratch ??= mkdtempSync(join(buildWorkspace, 'ikpk-book-snapshot-'));
  return scratch;
}

function snapshotWithBook(texts: string[], conflicts: Array<Partial<Record<string, string>>> = []): string {
  const dir = join(root(), `snapshot-${texts.length}-${Math.random().toString(16).slice(2)}`);
  cpSync(PINNED, dir, { recursive: true });
  const path = join(dir, 'snapshot.json');
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  const pages = snapshot.content.types.static_pages as Record<string, unknown>[];
  const base = {
    legacy_id: BOOK_SLUG,
    legacy_url: `https://ikpk.su/${BOOK_SLUG}`,
    title: 'Книги и учебные материалы',
    slug: BOOK_SLUG,
    seo_title: 'Книги и учебные материалы — ИКПК',
    seo_description: 'Книжные новинки издательского дома ИКПК.',
    body_html: '',
  };
  snapshot.content.types.static_pages = [
    ...pages.filter((page) => page.slug !== BOOK_SLUG),
    ...texts.map((body_text) => ({ ...base, body_text })),
    ...conflicts.map((conflict) => ({ ...base, body_text: 'конфликтующая запись', ...conflict })),
  ];
  writeFileSync(path, `${JSON.stringify(snapshot)}\n`);
  return dir;
}

function build(snapshotDir: string, name: string): string {
  const outDir = join(root(), `dist-${name}`);
  const env: NodeJS.ProcessEnv = { ...process.env, CONTENT_SNAPSHOT_DIR: snapshotDir, PAYMENT_ROLE: 'ci' };
  for (const key of ['DEMO_PROFILE', 'DEMO_OUTPUT', 'DEMO_FORMS', 'PAYMENT_ENDPOINT_PROD', 'PAYMENT_ENDPOINT_STAND']) {
    delete env[key];
  }
  execFileSync(ASTRO, ['--config', 'astro.config.mjs', 'build', '--outDir', outDir], {
    cwd: WEB_ROOT,
    env,
    stdio: 'pipe',
    maxBuffer: 8 * 1024 * 1024,
  });
  return outDir;
}

function booksHtml(outDir: string): string {
  return readFileSync(join(outDir, BOOK_SLUG, 'index.html'), 'utf8');
}

describe('страница книг из опубликованного снимка CMS', () => {
  it('собирает HTML из каждого из двух опубликованных текстов и экранирует его как текст', () => {
    const first = 'Издательский дом ИКПК выпускает книги. Продавец — ИП Первый & Партнёры.';
    const second = 'Продавец — ИП Второй <script>alert(1)</script> & партнёры.';
    const firstHtml = booksHtml(build(snapshotWithBook([first]), 'first'));
    const secondHtml = booksHtml(build(snapshotWithBook([second]), 'second'));

    expect(firstHtml).toContain('Продавец — ИП Первый &amp; Партнёры.');
    expect(secondHtml).toContain('Продавец — ИП Второй &lt;script&gt;alert(1)&lt;/script&gt; &amp; партнёры.');
    expect(secondHtml).not.toContain('<script>alert(1)</script>');
    expect(firstHtml).not.toContain('ИП Второй');
    expect(secondHtml).not.toContain('ИП Первый');
  }, 120_000);

  it.each([
    ['отсутствует', []],
    ['дублируется', ['первый продавец', 'второй продавец']],
  ])('отказывает в сборке, если опубликованная Page книг %s', (_case, texts) => {
    const dir = snapshotWithBook(texts);
    const outDir = join(root(), `dist-invalid-${texts.length}-${Math.random().toString(16).slice(2)}`);
    const env: NodeJS.ProcessEnv = { ...process.env, CONTENT_SNAPSHOT_DIR: dir, PAYMENT_ROLE: 'ci' };
    delete env.DEMO_PROFILE;
    delete env.DEMO_OUTPUT;
    expect(() => execFileSync(ASTRO, ['--config', 'astro.config.mjs', 'build', '--outDir', outDir], {
      cwd: WEB_ROOT,
      env,
      stdio: 'pipe',
      maxBuffer: 8 * 1024 * 1024,
    })).toThrow();
    expect(existsSync(join(outDir, BOOK_SLUG, 'index.html'))).toBe(false);
  }, 120_000);

  it.each([
    ['тот же slug с другим legacy_id', { slug: BOOK_SLUG, legacy_id: 'other' }],
    ['тот же legacy_id с другим slug', { slug: 'other', legacy_id: BOOK_SLUG }],
  ])('отказывает, если опубликованная запись совпадает только по %s', (_case, conflict) => {
    const dir = snapshotWithBook(['единственная валидная запись'], [conflict]);
    const outDir = join(root(), `dist-conflict-${Math.random().toString(16).slice(2)}`);
    const env: NodeJS.ProcessEnv = { ...process.env, CONTENT_SNAPSHOT_DIR: dir, PAYMENT_ROLE: 'ci' };
    delete env.DEMO_PROFILE;
    delete env.DEMO_OUTPUT;
    expect(() => execFileSync(ASTRO, ['--config', 'astro.config.mjs', 'build', '--outDir', outDir], {
      cwd: WEB_ROOT,
      env,
      stdio: 'pipe',
      maxBuffer: 8 * 1024 * 1024,
    })).toThrow();
    expect(existsSync(join(outDir, BOOK_SLUG, 'index.html'))).toBe(false);
  }, 120_000);
});
