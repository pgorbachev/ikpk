/**
 * КРАСНЫЕ тесты по change `cms-content-authoring-and-migration`:
 *  - дельта `static-serving`: адреса админки системы управления и её API получают класс
 *    с `no-store`, и правило «всё остальное» их не покрывает;
 *  - требование `cms-content-authoring`: админка и её API раздаются только по TLS.
 *
 * Предмет — ТЕКСТ генерируемой конфигурации раздачи. Единственный её носитель в
 * репозитории — heredoc `NGINX` в `scripts/bootstrap-vps.sh`: файла конфигурации нет,
 * каталога `infra/` нет (проверено поиском по `add_header Cache-Control` и `listen 80`).
 *
 * Что здесь НЕ проверяется и почему: фактический заголовок в ответе, код 301 с
 * незащищённого протокола и признак `Secure` у cookie в живом ответе — это поведение
 * сервера, а не текста. nginx не является зависимостью проекта и в тестах не
 * поднимается; спека для таких сценариев требует свидетельства с живой раздачи.
 *
 * НАЗВАННОЕ ПЕРЕСЕЧЕНИЕ: `tests/serving-config.test.ts` проверяет тот же heredoc и имеет
 * свой, более полный разбор с моделью выбора `location`. Ответы обеих проверок обязаны
 * совпадать; здесь предмет узкий — классы системы управления и TLS, которых там нет.
 * Модель приоритета `location` здесь НЕ воспроизводится, и это названо, а не подразумевается.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const BOOTSTRAP = join(ROOT, 'scripts', 'bootstrap-vps.sh');
const HEREDOC = 'NGINX';

function bootstrapText(): string {
  expect(existsSync(BOOTSTRAP), `ПРОВЕРИТЬ НЕ УДАЛОСЬ: нет ${BOOTSTRAP}`).toBe(true);
  return readFileSync(BOOTSTRAP, 'utf-8');
}

/** Тело heredoc'а, порождающего vhost. Переименование разделителя = предмет исчез. */
function vhost(): string {
  const text = bootstrapText();
  const start = new RegExp(`<<'?${HEREDOC}'?\\s*\\n`).exec(text);
  expect(start, `ПРОВЕРИТЬ НЕ УДАЛОСЬ: heredoc ${HEREDOC} не найден`).not.toBeNull();
  const from = start!.index + start![0].length;
  const endMatch = new RegExp(`^${HEREDOC}\\s*$`, 'm').exec(text.slice(from));
  expect(endMatch, `ПРОВЕРИТЬ НЕ УДАЛОСЬ: heredoc ${HEREDOC} не закрыт`).not.toBeNull();
  const body = text.slice(from, from + endMatch!.index);
  expect(body.trim().length, `ПРОВЕРИТЬ НЕ УДАЛОСЬ: тело heredoc ${HEREDOC} пусто`).toBeGreaterThan(0);
  return body;
}

/**
 * Комментарии снимаются ДО разбора: скрипт печатает оператору инструкции с директивами
 * текстом, и подстрочный поиск принимал их за конфигурацию (та же природа дефекта, что
 * в `tests/repo-hygiene.test.ts:118-130`).
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|[^'"$])#.*$/, '$1'))
    .join('\n');
}

type Block = { header: string; body: string; directives: string[] };

/**
 * Разбор блоков по СЧЁТУ ФИГУРНЫХ СКОБОК, а не по регулярному выражению на весь текст:
 * вложенный блок иначе съедает закрывающую скобку родителя, и правило приписывается не
 * тому блоку.
 */
function blocks(text: string): Block[] {
  const clean = stripComments(text);
  const result: Block[] = [];
  for (let i = 0; i < clean.length; i += 1) {
    if (clean[i] !== '{') continue;
    const headerStart = Math.max(clean.lastIndexOf('{', i - 1), clean.lastIndexOf('}', i - 1), clean.lastIndexOf(';', i - 1)) + 1;
    const header = clean.slice(headerStart, i).trim();
    let depth = 1;
    let j = i + 1;
    for (; j < clean.length && depth > 0; j += 1) {
      if (clean[j] === '{') depth += 1;
      else if (clean[j] === '}') depth -= 1;
    }
    const body = clean.slice(i + 1, j - 1);
    result.push({
      header,
      body,
      directives: body
        .split(';')
        .map((d) => d.replace(/\s+/g, ' ').trim())
        .filter((d) => d.length > 0 && !d.includes('{')),
    });
  }
  return result;
}

/** Значение `Cache-Control`, объявленное блоком, если объявлено. */
function cacheControl(block: Block): string | undefined {
  for (const directive of block.directives) {
    const match = /^add_header\s+Cache-Control\s+"([^"]*)"/i.exec(directive);
    if (match) return match[1];
  }
  return undefined;
}

const CMS_ADDRESS = /admin|\/api\b|strapi|cms/i;

describe('дельта static-serving: класс адресов системы управления', () => {
  it('предмет проверки существует: тело heredoc разбирается и содержит блоки', () => {
    const parsed = blocks(vhost());
    expect(parsed.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: ни одного блока не разобрано').toBeGreaterThan(0);
    expect(
      parsed.some((b) => /^server$/.test(b.header)),
      'ПРОВЕРИТЬ НЕ УДАЛОСЬ: блока server в vhost нет',
    ).toBe(true);
  });

  // Scenario: Ответ админки не разрешён к хранению
  it('адрес административной панели получает ровно no-store', () => {
    const parsed = blocks(vhost());
    const admin = parsed.filter(
      (b) => /^location\b/.test(b.header) && /admin/i.test(b.header) && cacheControl(b) !== undefined,
    );
    expect(
      admin.length,
      'ни одно правило раздачи не назначает политику адресам админки: они получат умолчание',
    ).toBeGreaterThan(0);
    for (const block of admin) {
      expect(cacheControl(block), `${block.header}: значение не равно no-store дословно`).toBe('no-store');
    }
  });

  // Scenario: Ответ API системы управления не разрешён к хранению
  it('адрес API системы управления получает ровно no-store', () => {
    const parsed = blocks(vhost());
    const api = parsed.filter(
      (b) => /^location\b/.test(b.header) && /\/api\b/.test(b.header) && cacheControl(b) !== undefined,
    );
    expect(api.length, 'ни одно правило не назначает политику адресам API системы управления').toBeGreaterThan(
      0,
    );
    for (const block of api) {
      expect(cacheControl(block), `${block.header}: значение не равно no-store дословно`).toBe('no-store');
    }
  });

  // Scenario: Правило «всё остальное» не покрывает систему управления
  it('ни одно правило не назначает адресам системы управления public', () => {
    const parsed = blocks(vhost());
    const cmsRules = parsed.filter((b) => /^location\b/.test(b.header) && CMS_ADDRESS.test(b.header));
    // Пустое множество — это «класса нет», а не «нарушений нет»: адрес без класса
    // наследует умолчание страниц, то есть получает `public`. Поэтому существование
    // класса утверждается ДО утверждения о его значении.
    expect(
      cmsRules.length,
      'правил для адресов системы управления нет вовсе: они наследуют умолчание с public',
    ).toBeGreaterThan(0);
    const offenders = cmsRules.filter((b) => (cacheControl(b) ?? '').includes('public'));
    expect(
      offenders.map((b) => `${b.header} → ${cacheControl(b)}`),
      'адресам системы управления назначен public: промежуточный кеш вправе хранить ответ с данными сотрудника',
    ).toEqual([]);
  });

  // Слово `public` в значении класса состояния и класса системы управления не появляется
  // вовсе: `public` — положительное разрешение разделяемому кешу хранить ответ.
  it('ни одно правило no-store не содержит слова public', () => {
    const parsed = blocks(vhost());
    const noStore = parsed.filter((b) => (cacheControl(b) ?? '').includes('no-store'));
    expect(noStore.length, 'правил no-store нет вовсе — проверять нечего').toBeGreaterThan(0);
    for (const block of noStore) {
      expect(cacheControl(block), `${block.header}: no-store вместе с public`).not.toMatch(/public/);
    }
  });
});

describe('админка и её API раздаются только по TLS', () => {
  // Scenario: незащищённый запрос к админке не отдаёт панель
  it('vhost слушает защищённый порт', () => {
    const parsed = blocks(vhost());
    const listens = parsed.flatMap((b) => b.directives.filter((d) => /^listen\b/.test(d)));
    expect(listens.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: директив listen нет вовсе').toBeGreaterThan(0);
    expect(
      listens.some((d) => /\b443\b/.test(d) && /\bssl\b/.test(d)),
      `защищённого listen нет: ${listens.join(' | ')} — панель отдаст пароль администратора открытым текстом`,
    ).toBe(true);
  });

  it('запрос по незащищённому протоколу перенаправляется или отклоняется', () => {
    const text = stripComments(vhost());
    const redirects = /return\s+30[18]\s+https:/i.test(text);
    const rejects = /return\s+(403|444|421)\b/.test(text);
    expect(
      redirects || rejects,
      'незащищённый запрос обслуживается как обычный: ни перенаправления на https, ни отказа',
    ).toBe(true);
  });

  // Scenario: cookie сессии не уходит по незащищённому соединению.
  // Файловая часть: конфигурация сессии Strapi объявляет передачу только по TLS.
  // Признак в живом ответе — ручное свидетельство.
  it('конфигурация сессии системы управления требует защищённого соединения', () => {
    const candidates = ['middlewares.ts', 'admin.ts', 'server.ts'].map((f) =>
      join(ROOT, 'cms', 'config', f),
    );
    const present = candidates.filter((f) => existsSync(f));
    expect(present.length, 'ПРОВЕРИТЬ НЕ УДАЛОСЬ: конфигурации cms/config нет').toBeGreaterThan(0);
    const source = present.map((f) => readFileSync(f, 'utf-8')).join('\n');
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');
    expect(
      /secure\s*:\s*(true|env\.bool)/.test(withoutComments),
      'признак «только по защищённому соединению» у cookie сессии не задан конфигурацией',
    ).toBe(true);
  });

  // Следствие требования: выбор между именем и сертификатом на адрес зафиксирован
  // вместе со сроком действия, потому что у сертификатов на адрес он заведомо короткий
  // и обновление обязано быть автоматическим.
  it('автоматическое обновление сертификата предусмотрено скриптом развёртывания', () => {
    const text = stripComments(bootstrapText());
    // Признак — ВЫЗОВ команды, а не упоминание. Слово «certbot» сегодня встречается
    // дважды: в комментарии и в тексте инструкции оператору, которую скрипт печатает.
    // Проверка по упоминанию проходила бы на скрипте, не делающем ничего.
    const invokesCertbot = /^\s*(sudo\s+)?(certbot|acme\.sh)\b/m.test(text);
    const schedulesRenewal = /systemctl\s+(enable|start)\s+\S*certbot|crontab|certbot\.timer/i.test(text);
    expect(
      invokesCertbot || schedulesRenewal,
      'выпуск и обновление сертификата только упомянуты текстом: TLS остаётся необязательным шагом инструкции',
    ).toBe(true);
  });
});

/*
 * СЦЕНАРИИ ДЕЛЬТЫ static-serving БЕЗ НОВОЙ АВТОМАТИЧЕСКОЙ ПРОВЕРКИ ЗДЕСЬ
 *
 * Требование `Кеш-политика задана классами адресов` пришло сюда целиком (`MODIFIED`
 * заменяет требование, а не дополняет), поэтому в его составе четырнадцать сценариев,
 * появившихся раньше этого change: файл с хешем в имени, данные поиска, загрузчик
 * поиска, шрифт, страница без расширения, главная, иконка сайта, корневой `.svg`,
 * `.svg` вне корня, карта сайта и её части, адрес карты с перенаправлением, страница
 * карты для человека, адрес вне классов, адрес состояния развёрнутой раздачи.
 *
 * Ни один из них этот change не меняет: он добавляет ОДИН класс — админку и её API.
 * Их проверки уже существуют в `tests/serving-config.test.ts` (текст конфигурации) и
 * требуют свидетельства с живой раздачи для фактических заголовков. Переписывать их
 * здесь значило бы завести вторую проверку над одним предметом с риском разойтись в
 * ответах — ровно то, от чего предупреждает `AGENTS.md`.
 */
