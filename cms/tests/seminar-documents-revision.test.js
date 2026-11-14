// RED cases from the agreed document requirements and the 2026-11-13 source audit.
// Field names are proposed adapters, not a storage prescription; keep the assertions
// if the implementation uses other names. This covers validation and aggregation, not HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkDocumentRecord as validateCms } from '../src/lib/publication-validation.ts';
import { checkDocumentRecord, aggregateCompliance } from '../../scripts/lib/cms-publication-validation.ts';

const base = { document: 'Удостоверение', issuer: 'ИКПК', priorEducation: 'medical' };
const aggregate = (documents) => aggregateCompliance([{ identifier: 'pk-1', documentsState: 'issued', documents }]).rows;

test('неизвестное выдающее лицо явно отмечено; пустое без признака отклонено', () => {
  for (const validate of [checkDocumentRecord, validateCms]) {
    assert.equal(validate({ ...base, issuer: '', issuerUnknown: true }).ok, true);
    assert.equal(validate({ ...base, issuer: '' }).ok, false);
  }
});

test('неуказанное образование и отсутствие требования остаются разными', () => {
  const rows = aggregate([
    { ...base, document: 'Сертификат', priorEducation: 'unspecified' },
    { ...base, priorEducation: 'none' },
  ]);
  assert.deepEqual(rows.map(({ document, priorEducation }) => [document, priorEducation]), [
    ['Сертификат', 'unspecified'], ['Удостоверение', 'none'],
  ]);
});

test('полный цикл, другой семинар и разные исходы не теряются в сводке', () => {
  const rows = aggregate([
    { ...base, completionScope: 'full-cycle', outcome: 'completed' },
    { ...base, document: 'Справка', completionScope: 'other-seminar', otherSeminarHref: '/course/pk-8#documents', outcome: 'assessment-failed' },
    { ...base, document: 'Справка', completionScope: 'other-seminar', otherSeminarHref: '/course/pk-8#documents', outcome: 'expelled' },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(({ document, completionScope, otherSeminarHref, outcome }) => ({ document, completionScope, otherSeminarHref, outcome })), [
    { document: 'Удостоверение', completionScope: 'full-cycle', otherSeminarHref: undefined, outcome: 'completed' },
    { document: 'Справка', completionScope: 'other-seminar', otherSeminarHref: '/course/pk-8#documents', outcome: 'assessment-failed' },
    { document: 'Справка', completionScope: 'other-seminar', otherSeminarHref: '/course/pk-8#documents', outcome: 'expelled' },
  ]);
});

test('НМО и реестр сохраняют вид утверждения и фрагменты ссылок', () => {
  const facts = [
    { nmo: { status: 'possible', href: 'https://example.org/nmo#conditions' }, trainingRegistries: [{ subject: 'training', href: 'https://example.org/registry#training' }] },
    { nmo: { status: 'awarded', href: 'https://example.org/nmo#awarded' } },
  ];
  const documentRegistry = { subject: 'document', href: 'https://example.org/registry#document' };
  const result = aggregateCompliance(facts.map((fact, i) => ({ identifier: `seminar-${i}`, documentsState: 'issued', documents: [{ ...base, ...(i ? { registries: [documentRegistry] } : {}) }], ...fact })));
  assert.equal(result.supplemental.length, 2);
  assert.deepEqual(result.supplemental.map((fact) => ({ nmo: fact.nmo, ...(fact.trainingRegistries ? { trainingRegistries: fact.trainingRegistries } : {}) })), facts);
  assert.deepEqual(result.rows[1].registries, [documentRegistry]);
});

test('схема CMS может хранить явно неуказанное образование и выдающее лицо', () => {
  const schema = JSON.parse(readFileSync(new URL('../src/components/seminar/document-record.json', import.meta.url), 'utf8')).attributes;
  assert.ok(schema.prior_education.enum.includes('unspecified'));
  assert.notEqual(schema.issuer.required, true);
  assert.ok(schema.issuer_unknown, 'признак неизвестного выдающего лица отсутствует');
});

test('происхождение переноса и подтверждение актуальности владельцем различимы', () => {
  const fields = JSON.parse(readFileSync(new URL('../src/api/seminar/content-types/seminar/schema.json', import.meta.url), 'utf8')).attributes;
  // Пример возможного представления: отдельный признак подтверждения владельцем.
  // Дата/источник/исполнитель переноса сами по себе этим признаком не являются.
  assert.ok(fields.documents_owner_verified, 'нет отдельного признака подтверждения владельцем');
  assert.notEqual(fields.documents_owner_verified.default, true);
  for (const name of ['documents_confirmation_date', 'documents_confirmation_source', 'documents_confirmation_author']) {
    assert.ok(fields[name], `отсутствует происхождение: ${name}`);
  }
});
