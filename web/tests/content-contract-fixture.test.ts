import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSnapshotContract } from '../scripts/lib/content-contract.ts';
import type { Snapshot } from '../scripts/lib/content-snapshot.ts';
import { assertStudentDocumentFormSnapshot } from '../scripts/lib/student-document-form-snapshot.ts';
import { primaryNav } from '../src/lib/navigation';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PINNED = join(REPO_ROOT, 'fixtures', 'content-snapshot', 'snapshot.json');

// РЕГРЕСС: контракт объявлял сломанной связь ВСЕХ 126 семинаров с их программами, потому что
// сравнивал `course_group_legacy_id` семинара с множеством СЛУГОВ программ. Поле называется
// `…_legacy_id`, и сравнивать его надо с `legacy_id`.
//
// Общий контракт используется и live capture, и prepare. Этот файл фиксирует поведение
// валидатора на целой закреплённой фикстуре и на одиночных мутациях.
describe('закреплённая фикстура и её собственный контракт', () => {
  const snapshot = JSON.parse(readFileSync(PINNED, 'utf-8')) as Snapshot;

  it('фикстура проходит контракт, который к ней применяют', () => {
    const { violations } = validateSnapshotContract(snapshot);
    const summary = violations
      .slice(0, 5)
      .map((v) => `${v.type}/${v.recordId}: ${v.rule}${v.field ? ` (${v.field})` : ''}`)
      .join('\n');
    expect(violations, `нарушений ${violations.length}:\n${summary}`).toEqual([]);
  });

  it('отказывает в публикации при отсутствующем или подменённом URL формы документов', () => {
    for (const value of [undefined, '', 'https://b24-cbqwqo.bitrix24site.ru.evil.test/crm_form_k5ush/',
      'http://b24-cbqwqo.bitrix24site.ru/crm_form_k5ush/', 'https://b24-cbqwqo.bitrix24site.ru/wrong/']) {
      const broken = structuredClone(snapshot) as Snapshot;
      const page = broken.content.types.static_pages?.find(record => record.slug === 'oplata');
      if (value === undefined) delete page?.student_document_form_url;
      else if (page) page.student_document_form_url = value;
      expect(validateSnapshotContract(broken).violations).toContainEqual(expect.objectContaining({
        type: 'static_pages', recordId: 'oplata', field: 'student_document_form_url', rule: 'invalid-value',
      }));
    }
  });

  it('частичный валидатор допускает отсутствующий тип, а строгая проверка снимка отказывает', () => {
    const broken = structuredClone(snapshot) as Snapshot;
    delete broken.content.types.static_pages;
    expect(validateSnapshotContract(broken).violations).toEqual([]); // partial validator deliberately accepts partial snapshots
    expect(() => assertStudentDocumentFormSnapshot(broken.content.types.static_pages)).toThrow(/единственную действительную/);
  });

  it('capture fails closed for missing, duplicate and invalid /oplata values', () => {
    const page = snapshot.content.types.static_pages?.find(record => record.slug === 'oplata');
    expect(() => assertStudentDocumentFormSnapshot(undefined)).toThrow(/снимок не записан/);
    expect(() => assertStudentDocumentFormSnapshot([])).toThrow(/снимок не записан/);
    expect(() => assertStudentDocumentFormSnapshot([page!, page!])).toThrow(/единственную действительную/);
    expect(() => assertStudentDocumentFormSnapshot([{ ...page!, student_document_form_url: 'https://evil.test/' }]))
      .toThrow(/снимок не записан/);
    expect(() => assertStudentDocumentFormSnapshot([page!])).not.toThrow();
  });

  it('the shared desktop and mobile navigation source exposes the documents link and demo rewrites it', async () => {
    const learning = primaryNav.find(item => item.label === 'Обучение');
    const form = learning?.children?.find(item => item.label === 'Заполнение документов');
    expect(form?.external).toBe(true);
    expect(form?.href).toMatch(/^https:\/\/b24-cbqwqo\.bitrix24site\.ru\/crm_form_/);
    vi.stubEnv('DEMO_FORMS', 'stub');
    vi.resetModules();
    const demo = await import('../src/lib/navigation');
    const demoForm = demo.primaryNav.find(item => item.label === 'Обучение')?.children?.find(item => item.label === 'Заполнение документов');
    expect(demoForm?.href).toBe('/demo-zayavka');
    expect(demoForm?.external).toBe(false);
    vi.stubEnv('DEMO_FORMS', 'forms-test.example');
    vi.resetModules();
    const hostDemo = await import('../src/lib/navigation');
    const hostForm = hostDemo.primaryNav.find(item => item.label === 'Обучение')?.children?.find(item => item.label === 'Заполнение документов');
    expect(hostForm?.href).toMatch(/^https:\/\/forms-test\.example\/crm_form_/);
    expect(hostForm?.external).toBe(true);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Защита от вакуумности: контракт, которому нечего проверять, зелён по совпадению.
  it('в фикстуре есть, что проверять', () => {
    const types = (snapshot as unknown as { content: { types: Record<string, unknown[]> } }).content
      .types;
    expect(Object.keys(types).length, 'типов контента нет — проверка вакуумна').toBeGreaterThan(0);
    expect(types.seminars?.length ?? 0, 'семинаров нет — связь проверять не на чем').toBeGreaterThan(0);
    expect(types.course_groups?.length ?? 0, 'программ нет — связь проверять не на чем').toBeGreaterThan(0);
  });

  it('связь преподавателя с институтом необязательна, но заданная связь проверяется', () => {
    const withoutMembership = structuredClone(snapshot) as Snapshot;
    withoutMembership.content.types.teachers = [{ id: 'optional-membership', trait: 'teacher' }];
    expect(validateSnapshotContract(withoutMembership).violations.filter((v) => v.type === 'teachers')).toEqual([]);

    const brokenMembership = structuredClone(snapshot) as Snapshot;
    brokenMembership.content.types.teachers = [
      { id: 'broken-membership', institute_legacy_id: 'not-an-institute', trait: 'teacher' },
    ];
    expect(validateSnapshotContract(brokenMembership).violations).toContainEqual(
      expect.objectContaining({ type: 'teachers', recordId: 'broken-membership', rule: 'broken-relation' }),
    );
  });
});
