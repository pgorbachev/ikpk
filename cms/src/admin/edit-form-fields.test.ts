import assert from 'node:assert/strict';
import test from 'node:test';
import { hideUnneededEditFields } from './edit-form-fields.ts';

const field = (name: string) => ({ name, size: 6 });
const makeLayout = (names: string[], metadatas: Record<string, unknown> = {}) => ({
  layout: [[names.map(field)]],
  metadatas,
  components: {
    'shared.seo': {
      layout: [[field('seo_title'), field('seo_description')], [field('noindex'), field('og_image')]],
      settings: { displayName: 'SEO' },
    },
    'shared.other': { layout: [[field('description')]], settings: { displayName: 'Other' } },
  },
  settings: { displayName: 'Fixture' },
  options: {},
});

function names(rows: unknown): string[] {
  return (rows as { name: string }[][][]).flat(2).map((item) => item.name);
}

test('Schedule Entry hides oldPrice and description while keeping adjacent fields and values metadata', () => {
  const source = makeLayout(['seminar', 'price', 'oldPrice', 'description', 'additionalText'], {
    entry_status: {}, seminar: {}, price: {}, oldPrice: {}, description: {}, additionalText: {},
  });
  const result = hideUnneededEditFields({ layout: source, query: { status: 'draft' } });

  assert.deepEqual(names(result.layout.layout), ['seminar', 'price', 'additionalText']);
  assert.deepEqual(result.layout.metadatas, source.metadatas);
  assert.equal(result.layout.components['shared.other'].layout[0][0].name, 'description');
});

test('Seminar hides documents_owner_verified without hiding its description or other fields', () => {
  const source = makeLayout(['name', 'description', 'documents_state', 'documents_owner_verified', 'duration'], {
    name: {}, description: {}, documents_state: {}, documents_owner_verified: {}, duration: {},
  });
  const result = hideUnneededEditFields({ layout: source, query: {} });

  assert.deepEqual(names(result.layout.layout), ['name', 'description', 'documents_state', 'duration']);
  assert.equal(result.layout.metadatas.documents_owner_verified, source.metadatas.documents_owner_verified);
});

test('shared SEO hides noindex while preserving SEO text, og_image, and other component layouts', () => {
  const source = makeLayout(['name', 'description'], { name: {}, description: {} });
  const result = hideUnneededEditFields({ layout: source, query: {} });

  assert.deepEqual(names(result.layout.layout), ['name', 'description']);
  assert.deepEqual(names([result.layout.components['shared.seo'].layout]), ['seo_title', 'seo_description', 'og_image']);
  assert.deepEqual(names([result.layout.components['shared.other'].layout]), ['description']);
});
