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
  // Иконка меню — обычный импорт, его компиляция в CommonJS зовёт `require`.
  // Песочница читает только `config.locales`, поэтому соседний модуль
  // транслируется так же и наружу не отдаётся.
  const require = (id) => {
    const imported = path.join(path.dirname(sourcePath), id);
    const importedPath = fs.existsSync(imported) ? imported : `${imported}.ts`;
    const importedModule = { exports: {} };
    const importedSource = ts.transpileModule(fs.readFileSync(importedPath, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText;
    vm.runInNewContext(
      importedSource,
      { module: importedModule, exports: importedModule.exports, require },
      { filename: importedPath },
    );
    return importedModule.exports;
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, require }, { filename: sourcePath });
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
  assert.equal(source.includes('addFields'), false);

  const schedule = JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dirname, '../src/api/schedule-entry/content-types/schedule-entry/schema.json'),
      'utf8',
    ),
  );
  assert.equal(schedule.attributes.startAt.customField, 'global::wall-clock-datetime');
  assert.equal(schedule.attributes.endAt.customField, 'global::wall-clock-datetime');
  const article = JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dirname, '../src/api/article/content-types/article/schema.json'),
      'utf8',
    ),
  );
  assert.equal(article.attributes.published_date.type, 'datetime');
  assert.equal(Object.hasOwn(article.attributes.published_date, 'customField'), false);
});
