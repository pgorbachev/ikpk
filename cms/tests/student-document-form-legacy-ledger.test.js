import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { completedStep } from '../scripts/run-data-migrations.mjs';

const OLD = '645ec7800d64cd531f54c4a24945c6f1fbd31512052165b84f17bbf6427a7f21';
const sha = value => createHash('sha256').update(value).digest('hex');
const current = {
  id: 'book-seller-page-v1', phase: 'after-sync', kind: 'data', handler: 'book-seller',
  path: 'data-steps/book-seller.mjs', sha256: sha('updated helper accepts the new nullable page column'),
};

function database({ step = current, row = {}, lineageId = 'lineage-a', operationId = 'new-operation',
  lineage = { lineage_id: lineageId, source_snapshot_sha256: sha('source'), source_schema_sha256: sha('schema') },
  operation = { lineage_id: lineageId, source_snapshot_sha256: sha('prior-source'), source_schema_sha256: sha('prior-schema') } } = {}) {
  const oldRow = { operation_id: 'prior-operation', payload_sha256: OLD,
    result_json: JSON.stringify({ createdPages: 2, createdSeoComponents: 2, createdPageLinks: 2 }),
    completed_at: '2026-01-01T00:00:00.000Z', ...row };
  return {
    oldRow,
    prepare(sql) {
      return { get: (...args) => {
        if (sql.includes('ikpk_data_migration_history')) return oldRow;
        if (sql.includes('ikpk_migration_lineage')) return lineage;
        if (sql.includes('ikpk_migration_operations')) return args[0] === oldRow.operation_id ? operation : null;
        throw new Error(`unexpected query: ${sql}`);
      } };
    },
  };
}

test('inherits the exact historical book seed record without rewriting its SHA', () => {
  const db = database();
  const before = structuredClone(db.oldRow);
  assert.equal(completedStep(db, 'lineage-a', current, 'new-operation'), db.oldRow);
  assert.deepEqual(db.oldRow, before);
  assert.equal(db.oldRow.payload_sha256, OLD);
});

test('legacy digest is refused for wrong tuple, same operation, mismatched result, or broken lineage binding', () => {
  const cases = [
    { step: { ...current, path: 'data-steps/other.mjs' } },
    { operationId: 'prior-operation' },
    { row: { result_json: '{"createdPages":99}' } },
    { lineage: { lineage_id: 'another-lineage', source_snapshot_sha256: sha('s'), source_schema_sha256: sha('c') } },
    { operation: { lineage_id: 'another-lineage', source_snapshot_sha256: sha('s'), source_schema_sha256: sha('c') } },
    { row: { payload_sha256: sha('unexpected') } },
  ];
  for (const options of cases) assert.throws(() => {
    const db = database(options);
    completedStep(db, 'lineage-a', options.step ?? current, options.operationId ?? 'new-operation');
  }, /different SHA-256/);
});
