import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ts from 'typescript';
import * as copy from '../src/seminar-management/refresh-status-copy.ts';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/admin/pages/SiteRefresh.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const success = () => ({ status: 'succeeded', message: 'Сайт обновлён. Опубликован весь снимок CMS, не только открытый семинар.', finishedAt: new Date().toISOString() });
const running = { status: 'running', message: 'Обновление запущено.', phase: 'build' };

function harness(client) {
  const intervals = new Map();
  let next = 0;
  globalThis.window = {
    setInterval: (fn) => { const id = ++next; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id), setTimeout: () => ++next, clearTimeout: () => {},
  };
  const module = { exports: {} };
  const fakeRequire = (name) => {
    if (name === '@strapi/strapi/admin') return { useFetchClient: () => client };
    if (name === '@strapi/design-system') return { Box: 'section', Button: 'button', Typography: 'span' };
    if (name.endsWith('seminar-management/refresh-status-copy')) return copy;
    return require(name);
  };
  new Function('require', 'module', 'exports', compiled)(fakeRequire, module, module.exports);
  return { Page: module.exports.SiteRefreshPage, intervals };
}
const rendered = (root) => JSON.stringify(root.toJSON());
const button = (root) => root.root.findAllByType('button').find((node) => node.children.includes('Обновить сайт'));

test('отправка скрывает старый успех и блокирует повторный запрос', async () => {
  const post = deferred(); let calls = 0;
  const { Page } = harness({ get: async () => ({ data: success() }), post: () => { calls++; return post.promise; } });
  let root;
  await act(async () => { root = TestRenderer.create(React.createElement(Page)); });
  assert.match(rendered(root), /Сайт обновлён/);
  await act(async () => { const click = button(root).props.onClick; click(); click(); });
  assert.equal(calls, 1);
  assert.equal(button(root).props.disabled, true);
  assert.match(rendered(root), /Отправляется запрос/);
  assert.doesNotMatch(rendered(root), /Сайт обновлён/);
  await act(async () => { post.resolve({ data: running }); await post.promise; });
  assert.match(rendered(root), /Обновление запущено/);
  assert.equal(button(root).props.disabled, true);
  await act(async () => root.unmount());
});

test('ошибка POST не возвращает прежнее подтверждение успеха', async () => {
  const post = deferred();
  const { Page } = harness({ get: async () => ({ data: success() }), post: () => post.promise });
  let root;
  await act(async () => { root = TestRenderer.create(React.createElement(Page)); });
  await act(async () => { button(root).props.onClick(); });
  await act(async () => { post.reject(new Error('offline')); await post.promise.catch(() => {}); });
  assert.match(rendered(root), /Не удалось получить ответ/);
  assert.doesNotMatch(rendered(root), /Сайт обновлён/);
  assert.equal(button(root).props.disabled, false);
  await act(async () => root.unmount());
});

test('запоздавший первоначальный GET не перезаписывает ответ POST', async () => {
  const get = deferred(), post = deferred();
  const { Page } = harness({ get: () => get.promise, post: () => post.promise });
  let root;
  await act(async () => { root = TestRenderer.create(React.createElement(Page)); });
  await act(async () => { button(root).props.onClick(); });
  await act(async () => { post.resolve({ data: running }); await post.promise; });
  await act(async () => { get.resolve({ data: success() }); await get.promise; });
  assert.match(rendered(root), /Обновление запущено/);
  assert.doesNotMatch(rendered(root), /Сайт обновлён/);
  await act(async () => root.unmount());
});

test('опрос активной операции показывает успех и прекращается', async () => {
  let calls = 0; const poll = deferred();
  const { Page, intervals } = harness({ get: () => ++calls === 1 ? Promise.resolve({ data: running }) : poll.promise, post: async () => ({ data: running }) });
  let root;
  await act(async () => { root = TestRenderer.create(React.createElement(Page)); });
  assert.equal(intervals.size, 1);
  await act(async () => { [...intervals.values()][0](); });
  await act(async () => { poll.resolve({ data: success() }); await poll.promise; });
  assert.match(rendered(root), /Сайт обновлён/);
  assert.equal(intervals.size, 0);
  assert.equal(button(root).props.disabled, false);
  await act(async () => root.unmount());
});

test('старый ответ опроса не отменяет более поздний успех', async () => {
  let calls = 0; const first = deferred(), second = deferred();
  const { Page, intervals } = harness({ get: () => ++calls === 1 ? Promise.resolve({ data: running }) : calls === 2 ? first.promise : second.promise });
  let root;
  await act(async () => { root = TestRenderer.create(React.createElement(Page)); });
  await act(async () => { const tick = [...intervals.values()][0]; tick(); tick(); });
  await act(async () => { second.resolve({ data: success() }); await second.promise; });
  await act(async () => { first.resolve({ data: running }); await first.promise; });
  assert.match(rendered(root), /Сайт обновлён/);
  assert.equal(button(root).props.disabled, false);
  assert.equal(intervals.size, 0);
  await act(async () => root.unmount());
});

test('медленный опрос применяется, даже если следующий уже запущен', async () => {
  let calls = 0; const first = deferred(), second = deferred();
  const { Page, intervals } = harness({ get: () => ++calls === 1 ? Promise.resolve({ data: running }) : calls === 2 ? first.promise : second.promise });
  let root;
  await act(async () => { root = TestRenderer.create(React.createElement(Page)); });
  await act(async () => { const tick = [...intervals.values()][0]; tick(); tick(); });
  await act(async () => { first.resolve({ data: success() }); await first.promise; });
  assert.match(rendered(root), /Сайт обновлён/);
  assert.equal(button(root).props.disabled, false);
  await act(async () => root.unmount());
});
