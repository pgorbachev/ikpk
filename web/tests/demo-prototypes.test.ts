import { describe, it, expect } from 'vitest';
import { allDemoPages, readDemoPage } from './helpers/demo-dist';
import { getScheduleEntries, getSeminars } from '../src/lib/data.js';
import { getUpcomingSeminars, seminarTeacherLabel } from '../src/lib/home.js';
import { calendarToday, isCurrentOrFuture } from '../src/lib/schedule-window.js';

/**
 * Прототипы каркаса подачи (`/preview/{editorial,faculty,modular}`) — предмет ДЕМО-вывода.
 *
 * Переехали сюда из `tests/seo-package.test.ts`, где были обёрнуты в
 * `describe.skipIf(!isDemoBuildForPrototypes)`: тот файл читает боевой `dist/`, а прототипы
 * существуют только в демо-сборке, поэтому в CI (`npm run build` → `test:build`) все
 * проверки уходили в skip. Это и есть TD-14 («Прототипы каркаса не защищены в CI»).
 *
 * После разведения выводов (`dist/` / `dist-demo`) условие стало ненужным: этот файл
 * запускается конфигурацией `vitest.demo.config.ts` строго по собранному демо-выводу, где
 * прототипы есть всегда. Отсутствие вывода роняет прогон (см. `demoPages`), а не пропускает
 * его, поэтому `skipIf` не вернулся под другим именем.
 *
 * Тела проверок перенесены без изменений: поменялся только источник страниц
 * (`readPage`/`allPages` → `readDemoPage`/`allDemoPages`).
 */

// Сторож против вырождения: прототипы существуют только в демо-сборке, и опознаётся она
// по САМОМУ ЭЛЕМЕНТУ баннера, а не по имени CSS-класса (класс `.demo-banner` лежит в общем
// CSS независимо от режима — по нему признак был бы всегда истинным). Раньше это условие
// стояло в `skipIf` и гасило проверки; теперь оно УТВЕРЖДАЕТСЯ: вывод, не являющийся
// демо-сборкой, — это не повод пропустить проверки, а провал.
describe('демо-вывод — это действительно демо-сборка', () => {
  it('на главной есть баннер стенда', () => {
    expect(
      readDemoPage('/'),
      'в демо-выводе нет элемента баннера стенда: либо собрана боевая версия, либо ' +
        'прототипы ниже проверяли бы не тот вывод',
    ).toContain('data-demo-banner');
  });
});

function previewPath(id: string, suffix = ''): string {
  const bare = `/preview/${id}${suffix}`;
  return allDemoPages().includes(bare) ? bare : `${bare}/`;
}

// План 005 §4.4: позиционирование, событие, доверие, институты, аудитории,
// семинары, преподаватели, видео, новости, CTA. Гейт — состав, не оформление.
describe('прототипы каркаса', () => {
  const DIRECTIONS = ['editorial', 'faculty', 'modular'];
  // Блок ближайших семинаров — четвёртое место с той же зависимостью от горизонта
  // снапшота, что и блоки анонсов ниже: без будущих событий его нечем наполнить, и он
  // исчезает. Держать его в безусловно обязательных значило бы оставить мину под
  // публикацией ровно там, где она уже обезврежена рядом. Найдено измерением: сдвиг
  // снапшота на пять лет назад ронял эти три проверки даже после починки блоков анонсов.
  const ALWAYS = [
    { name: 'позиционирование (h1)', match: /<h1[^>]*>/ },
    { name: 'три института', match: /Институт Апледжера/ },
    { name: 'преподаватели', match: /teacher-card|Преподаватели/i },
    { name: 'итоговый CTA', match: /cta-band|Записаться/i },
    { name: 'футер с контактами', match: /646-54-50/ },
  ];
  const UPCOMING_BLOCK = { name: 'ближайшие семинары', match: /Ближайшие семинары|upcoming/i };

  for (const id of DIRECTIONS) {
    it(`/preview/${id}: обязательные блоки на месте`, () => {
      const html = readDemoPage(previewPath(id));
      const required = hasUpcoming ? [...ALWAYS, UPCOMING_BLOCK] : ALWAYS;
      const missing = required.filter(({ match }) => !match.test(html)).map((r) => r.name);
      expect(missing, `в прототипе ${id} нет блоков: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

// Подлинный фотоактив — только портреты преподавателей; остальное сток/CGI.
// Без пометки владелец примет сток за съёмку. В бою служебной разметке не место.
describe('прототипы: происхождение изображений', () => {
  it('на страницах прототипов есть пометки происхождения', () => {
    const previews = allDemoPages().filter((p) => p.startsWith('/preview/'));

    // Проверка утверждает ОТСУТСТВИЕ страниц без пометки, а отсутствие тривиально верно
    // для пустого списка: пока эта строка не появилась, исчезновение всех /preview из
    // вывода давало зелёный «нарушений нет» вместо «предмета нет». Проверено мутацией:
    // `rm -rf dist-demo/preview` (16 страниц → 0) — проверка проходила.
    // Точный состав страниц закреплён в «у каждого каркаса есть прототипы семинара…»,
    // здесь достаточно непустоты, чтобы число не пришлось держать в двух местах.
    expect(
      previews,
      'в демо-выводе нет ни одной страницы /preview — проверять пометки происхождения не на чем',
    ).not.toEqual([]);

    const missing = previews.filter((p) => !readDemoPage(p).includes('data-provenance-legend'));
    expect(missing, `в прототипах нет пометок происхождения:\n${missing.join('\n')}`).toEqual([]);
  });

  it('служебная пометка не попадает в боевые страницы', () => {
    const leaked = allDemoPages()
      .filter((p) => !p.startsWith('/preview/'))
      .filter((p) => readDemoPage(p).includes('data-provenance-legend'));
    expect(leaked.slice(0, 5), `пометка прототипа на боевой странице:\n${leaked.slice(0, 5).join('\n')}`).toEqual([]);
  });
});

/**
 * Блоки анонсов рендерятся УСЛОВНО: `EventLine.astro`, `EventTeacher.astro` и
 * `UpcomingModular.astro` стоят под `{next && …}`, где `next` — из
 * `getUpcomingSeminars(limit, now = new Date())`. Данные у нас снапшот, поэтому
 * требование «маркер есть» — мина под публикацией: когда последнее событие снапшота
 * уйдёт в прошлое, гейт покраснеет на ИСПРАВНОМ коде и остановит выкладку боевого
 * сайта, а сообщение соврёт («нет строки-анонса события»).
 *
 * Поэтому ожидание выводится из тех же данных той же чистой функцией, а не берётся
 * календарём: есть будущие события — маркер обязан быть; нет — обязан отсутствовать.
 * Оба исхода проверяются, так что гейт продолжает ловить сломанный прототип и молчит
 * там, где виноват ход времени. Это тот же приём, что в `src/lib/schedule-window.ts`.
 *
 * Остаточная связь названа честно: сборка вызывает `getUpcomingSeminars()` в момент
 * сборки, а тест — в момент прогона. Разойтись они могут только на событии, истекающем
 * между сборкой и проверкой (в CI это секунды). Известное отклонение записано в
 * `docs/tech-debt.md`.
 */
const upcoming = getUpcomingSeminars(1);
const hasUpcoming = upcoming.length > 0;
const next = upcoming[0];

/**
 * Предусловие шапки `/preview/<id>/seminar`: она показывает даты, только если есть
 * активное текущее/будущее событие С преподавателем (`seminar.astro` фильтрует именно
 * так), иначе рендерит ветку «даты набора уточняются».
 */
const hasDatedFutureWithTeacher = getScheduleEntries().some(
  (e) =>
    e.status === 'active' &&
    Boolean(e.startAt) &&
    isCurrentOrFuture(e, calendarToday()) &&
    Boolean(e.teachers?.length),
);

/**
 * Astro экранирует текст, и в выводе действительно есть три `<h1>` с `&quot;` (названия
 * вида «Вебинар "С чего начинается КСТ?"»). Без обратного преобразования сравнение с
 * названием из данных развалилось бы при первом рефреше, выбравшем такой семинар, —
 * проверено: 3 из 126 названий содержат кавычки.
 */
function decodeEntities(text: string): string {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

// Направления различаются архитектурой подачи, не порядком секций (§7).
describe('прототипы: своя подача первого экрана', () => {
  it('editorial подаёт ближайшее событие строкой-анонсом', () => {
    const html = readDemoPage(previewPath('editorial'));
    expect(html, 'нет editorial hero').toContain('data-hero="editorial"');

    if (!hasUpcoming) {
      expect(
        html,
        'в данных нет будущих событий, но строка-анонс отрендерена: блок должен ' +
          'исчезать вместе с событием',
      ).not.toContain('data-event-line');
      return;
    }

    expect(html, 'нет строки-анонса события').toContain('data-event-line');

    const at = html.indexOf('data-event-line');
    const line = html.slice(at, at + 900);
    // Город и цена сверяются с КОНКРЕТНЫМ ближайшим событием, а не с белым списком
    // значений: список из шести городов отставал бы от данных молча при первом же
    // рефреше каталога.
    expect(line, `в анонсе нет города ближайшего события (${next.cityName})`).toContain(
      next.cityName,
    );
    expect(line, `в анонсе нет цены ближайшего события (${next.priceLabel})`).toContain(
      next.priceLabel,
    );
  });

  it('faculty подаёт событие карточкой с преподавателем', () => {
    const html = readDemoPage(previewPath('faculty'));
    expect(html, 'нет faculty hero').toContain('data-hero="faculty"');
    if (hasUpcoming) {
      expect(html, 'нет карточки события с преподавателем').toContain('data-event-teacher');
    } else {
      expect(
        html,
        'в данных нет будущих событий, но карточка события отрендерена',
      ).not.toContain('data-event-teacher');
    }
    expect(html, 'faculty не должен повторять строку editorial').not.toContain('data-event-line');
  });

  it('modular подаёт каталог: picker + сетка дат без строки editorial', () => {
    const html = readDemoPage(previewPath('modular'));
    expect(html, 'нет modular hero').toContain('data-hero="modular"');
    expect(html, 'нет модуля подбора').toContain('data-modular-picker');
    if (hasUpcoming) {
      expect(html, 'нет сетки дат').toContain('data-upcoming="modular"');
    } else {
      expect(html, 'в данных нет будущих событий, но сетка дат отрендерена').not.toContain(
        'data-upcoming="modular"',
      );
    }
    expect(html, 'нет траектории ступеней').toContain('data-tracks="modular"');
    expect(html, 'modular не должен повторять строку editorial').not.toContain('data-event-line');
  });

  it('в остальных направлениях строки-анонса нет — подача отличается', () => {
    for (const id of ['faculty', 'modular']) {
      expect(readDemoPage(previewPath(id)), `${id} повторяет подачу editorial`).not.toContain(
        'data-event-line',
      );
    }
  });

  it('у каждого каркаса есть прототипы семинара (с датой и без) и расписания', () => {
    for (const id of ['editorial', 'faculty', 'modular']) {
      for (const suffix of ['', '/seminar', '/seminar-undated', '/schedule']) {
        const path = previewPath(id, suffix);
        expect(allDemoPages().includes(path), `нет /preview/${id}${suffix}`).toBe(true);
      }
      const undatedPath = previewPath(id, '/seminar-undated');
      const datedPath = previewPath(id, '/seminar');
      expect(readDemoPage(datedPath)).toContain(`data-seminar-architecture="${id}"`);
      expect(readDemoPage(undatedPath)).toContain('data-undated');
      expect(readDemoPage(undatedPath)).toContain(`data-seminar-architecture="${id}"`);
    }
  });

  it('faculty с датой показывает дату в шапке', () => {
    const html = readDemoPage(previewPath('faculty', '/seminar'));
    expect(html, 'нет data-атрибута faculty-шапки').toContain('data-seminar-architecture="faculty"');

    // Та же мина, что у блоков анонсов: `/preview/<id>/seminar` берёт ближайшее активное
    // датированное событие с преподавателем, а при его отсутствии шапка рендерит ветку
    // `data-undated`. Ожидание выводится из данных, поэтому уход снапшота в прошлое
    // переводит проверку на другую ветку, а не роняет публикацию.
    if (!hasDatedFutureWithTeacher) {
      expect(
        html,
        'в данных нет будущих датированных событий с преподавателем, но шапка показывает ' +
          'даты вместо ветки «даты набора уточняются»',
      ).toContain('data-undated');
      return;
    }

    // dateLabel из formatScheduleDateRange: «5 сен» или «12–14 сен»
    expect(
      html.match(/sem-fa-pills[\s\S]*?<li[^>]*>\d{1,2}(?:[–-]\d{1,2})?\s+[а-яё]{3}</),
      'в pill-списке faculty нет даты',
    ).not.toBeNull();
  });

  it('undated не приписывает чужого преподавателя института', () => {
    // Сопоставление только через seminar.teachers — иначе Faculty врёт владельцу.
    for (const id of ['editorial', 'faculty', 'modular'] as const) {
      const html = readDemoPage(previewPath(id, '/seminar-undated'));
      const h1 = decodeEntities(html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]?.trim() ?? '');
      expect(h1, `${id}: нет h1 семинара`).toBeTruthy();
      const seminar = getSeminars().find((s) => s.name === h1);
      expect(seminar, `${id}: семинар «${h1}» не найден в данных`).toBeTruthy();
      const label = seminarTeacherLabel(seminar!.teachers);
      const short = label.split(',')[0].trim();

      if (id === 'faculty' || id === 'modular') {
        if (!short) {
          expect(html, `${id}: без teachers не должно быть «Ведёт»`).not.toMatch(/Ведёт\s/);
        } else {
          expect(html, `${id}: нет имени из seminar.teachers (${short})`).toContain(short);
        }
      }

      // Типичная подмена: первый с фото у института при другом ведущем.
      if (short && !short.includes('Пилявский')) {
        expect(html, `${id}: чужой Пилявский при ведущем ${short}`).not.toMatch(
          /Ведёт Пилявский Сергей Орестович/,
        );
      }
    }
  });
});
