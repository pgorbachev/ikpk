import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Tiptap custom field is registered as a text field on both sides of Strapi', async () => {
  const [server, admin, schema] = await Promise.all([
    read('../src/index.ts'),
    read('../src/admin/app.tsx'),
    read('../src/api/editor-prototype/content-types/editor-prototype/schema.json'),
  ]);

  assert.match(server, /name: 'tiptap-html'[\s\S]*type: 'text'/);
  assert.match(admin, /name: 'tiptap-html'[\s\S]*type: 'text'/);
  assert.deepEqual(JSON.parse(schema).attributes.body, {
    type: 'customField',
    customField: 'global::tiptap-html',
    required: true,
  });
});

test('editor stores HTML and provides table creation from the local Tiptap bundle', async () => {
  const input = await read('../src/admin/components/TiptapHtmlInput.tsx');

  assert.match(input, /value: updatedEditor\.getHTML\(\)/);
  assert.match(input, /insertTable\(\{ rows: 3, cols: 3, withHeaderRow: true \}\)/);
  assert.match(input, /from '@tiptap\/extension-table'/);
  assert.doesNotMatch(input, /https?:\/\//);
});
