import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Браузерные тесты ходят по СВОИМ адресам сайта, а не по тем, которые сайт
// только принимает и перенаправляет.
//
// Откуда взялся гейт: два теста в site.spec.ts обращались к `/kontakty/` и
// `/video/33/` — формам со слэшем на конце. Сборка статическая и
// `trailingSlash: 'never'`, поэтому предпросмотр отдаёт на такой адрес
// «404: Not Found (trailingSlash is set to "never")», элемент не появляется, и
// тест падает по таймауту ожидания локатора. Выглядит это как поломка карты или
// видео, хотя разметка на месте — на разбор ушло время, и в CI такой прогон
// красный при полностью рабочем сайте.
//
// В боевой раздаче обе формы живут: nginx отдаёт 301 со слэша на канонический
// адрес (254 таких правила сгенерированы из карты адресов). Именно поэтому
// ошибка не «сайт не работает», а «тест проверяет не то место»: он адресует
// источник редиректа, которого предпросмотр не знает.
//
// Общий признак вместо перечисления известных случаев: НИ ОДИН относительный
// адрес в браузерных тестах не должен быть источником редиректа — ни по слэшу
// на конце, ни по любому другому правилу из сгенерированной конфигурации.
const TESTS_DIR = import.meta.dirname;
const REDIRECTS = join(import.meta.dirname, '..', '..', 'deploy', 'nginx-redirects.conf');

// Ловим ЛЮБОЙ строковый литерал-адрес, а не только аргумент `page.goto(...)`.
// Первая версия гейта смотрела лишь на `goto('...')` — и пропустила 13 адресов в
// `a11y.spec.ts`, где они лежат в константе `TEMPLATES` и передаются в goto
// переменной. Из-за этого 10 шаблонов из 14 проверялись на странице 404: axe
// находил там ноль нарушений, и «36 проверок доступности» были зелёными,
// не проверяя ничего. Перечислять способы передачи адреса бессмысленно — их
// больше, чем можно предугадать; общий признак — сам вид адреса.
const PATH_LITERAL = /'(\/[A-Za-z0-9\-._~/%]*)'/g;

interface Address {
  file: string;
  line: number;
  path: string;
}

function collectAddresses(): Address[] {
  const files = readdirSync(TESTS_DIR).filter((n) => n.endsWith('.spec.ts'));
  expect(files.length, `в ${TESTS_DIR} не найдено ни одного *.spec.ts`).toBeGreaterThan(0);

  const found: Address[] = [];
  for (const file of files) {
    const lines = readFileSync(join(TESTS_DIR, file), 'utf-8').split('\n');
    lines.forEach((text, index) => {
      for (const m of text.matchAll(PATH_LITERAL)) found.push({ file, line: index + 1, path: m[1] });
    });
  }
  return found;
}

/** Источники редиректов: `location = /путь { return 301 /цель; }`. */
function redirectSources(): Set<string> {
  const conf = readFileSync(REDIRECTS, 'utf-8');
  const sources = new Set<string>();
  for (const m of conf.matchAll(/^\s*location\s*=\s*(\S+)\s*\{[^}]*return\s+30[12]/gm))
    sources.add(m[1]);
  return sources;
}

describe('адреса в браузерных тестах', () => {
  // Пустой список адресов или отсутствующая конфигурация — это «проверка не
  // выполнена», а не «дефектов нет». Без этого гейта переименование файлов
  // тестов молча обнулило бы обе проверки ниже.
  it('материал для проверки на месте', () => {
    expect(collectAddresses().length, 'ни одного адреса-литерала в браузерных тестах').toBeGreaterThan(
      0,
    );
    expect(existsSync(REDIRECTS), `нет конфигурации редиректов: ${REDIRECTS}`).toBe(true);
    expect(redirectSources().size, 'в конфигурации нет ни одного правила 301/302').toBeGreaterThan(
      0,
    );
  });

  it('ни один адрес не оканчивается слэшем', () => {
    const offenders = collectAddresses()
      .filter(({ path }) => path !== '/' && path.endsWith('/'))
      .map(({ file, line, path }) => `${file}:${line} → ${path}`);

    expect(
      offenders,
      `trailingSlash: 'never' — предпросмотр отдаёт на такой адрес 404, тест падает по таймауту:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('ни один адрес не является источником редиректа', () => {
    const sources = redirectSources();
    const offenders = collectAddresses()
      .filter(({ path }) => sources.has(path.split('?')[0].split('#')[0]))
      .map(({ file, line, path }) => `${file}:${line} → ${path}`);

    expect(
      offenders,
      `адрес отдаётся боевым nginx как 301, но предпросмотром — как 404:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
