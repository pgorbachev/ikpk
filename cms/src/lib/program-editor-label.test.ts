import assert from 'node:assert/strict';
import test from 'node:test';
import { decideProgramSlug, programEditorLabel, relationTarget } from './program-editor-label.ts';

test('подпись ставит институт слева от названия программы', () => {
  assert.equal(
    programEditorLabel('Институт Барраля', 'Специализированные'),
    'Институт Барраля — Специализированные',
  );
  assert.equal(programEditorLabel('  ', 'Специализированные'), 'Специализированные');
  assert.equal(programEditorLabel('Институт Барраля', ''), 'Институт Барраля');
});

test('заглушка course-group заменяется адресом из названия, явный адрес сохраняется', () => {
  assert.deepEqual(
    decideProgramSlug({
      name: 'Специализированные',
      existingSlug: null,
      existingName: null,
      incomingSlug: 'course-group',
      trustedImport: false,
      isCreate: true,
    }),
    { action: 'generate' },
  );
  assert.deepEqual(
    decideProgramSlug({
      name: 'Программа для теста',
      existingSlug: null,
      existingName: null,
      incomingSlug: 'programma-dlya-testa',
      trustedImport: false,
      isCreate: true,
    }),
    { action: 'incoming', slug: 'programma-dlya-testa' },
  );
  assert.deepEqual(
    decideProgramSlug({
      name: 'Новое название',
      existingSlug: 'specializirovannye',
      existingName: 'Специализированные',
      incomingSlug: 'drugoy-adres',
      trustedImport: false,
      isCreate: false,
    }),
    { action: 'keep', slug: 'specializirovannye' },
  );
});

test('пустое название не получает служебный адрес', () => {
  assert.deepEqual(
    decideProgramSlug({
      name: '   ',
      existingSlug: null,
      existingName: null,
      incomingSlug: 'course-group',
      trustedImport: false,
      isCreate: true,
    }),
    { action: 'clear' },
  );
});

test('связь читает выбранный documentId и понимает снятие', () => {
  assert.deepEqual(relationTarget({ connect: [{ documentId: 'inst' }] }), { documentId: 'inst' });
  assert.deepEqual(relationTarget({ set: [] }), { cleared: true });
  assert.deepEqual(relationTarget(undefined), { unchanged: true });
});
