import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const loadCommonjs = createRequire(import.meta.url);

test('панель Content Manager включает русские действия сохранения и публикации', () => {
  const sourcePath = path.join(import.meta.dirname, '../src/admin/app.tsx');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports }, { filename: sourcePath });
  const locales = module.exports.default.config.locales;
  assert.deepEqual(Array.from(locales), ['ru']);

  const catalog = loadCommonjs(
    path.join(import.meta.dirname, '../node_modules/@strapi/admin/dist/admin/admin/src/translations/ru.json.js'),
  );
  const ru = catalog.default ?? catalog;
  assert.equal(ru['global.save'], 'Сохранить');
  assert.equal(ru['app.utils.publish'], 'Опубликовать');
  const manager = loadCommonjs(
    path.join(import.meta.dirname, '../node_modules/@strapi/content-manager/dist/admin/translations/ru.json.js'),
  );
  const managerRu = manager.default ?? manager;
  assert.equal(typeof managerRu, 'object');
  assert.ok(Object.keys(managerRu).length > 0);
});
