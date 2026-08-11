import { describe, it, expect } from 'vitest';
import { allDemoPages, readDemoPage } from './helpers/demo-dist';
import { getSeminars } from '../src/lib/data.js';
import { seminarTeacherLabel } from '../src/lib/home.js';

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
  const REQUIRED = [
    { name: 'позиционирование (h1)', match: /<h1[^>]*>/ },
    { name: 'ближайшие семинары', match: /Ближайшие семинары|upcoming/i },
    { name: 'три института', match: /Институт Апледжера/ },
    { name: 'преподаватели', match: /teacher-card|Преподаватели/i },
    { name: 'итоговый CTA', match: /cta-band|Записаться/i },
    { name: 'футер с контактами', match: /646-54-50/ },
  ];

  for (const id of DIRECTIONS) {
    it(`/preview/${id}: обязательные блоки на месте`, () => {
      const html = readDemoPage(previewPath(id));
      const missing = REQUIRED.filter(({ match }) => !match.test(html)).map((r) => r.name);
      expect(missing, `в прототипе ${id} нет блоков: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

// Подлинный фотоактив — только портреты преподавателей; остальное сток/CGI.
// Без пометки владелец примет сток за съёмку. В бою служебной разметке не место.
describe('прототипы: происхождение изображений', () => {
  it('на страницах прототипов есть пометки происхождения', () => {
    const previews = allDemoPages().filter((p) => p.startsWith('/preview/'));
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

// Направления различаются архитектурой подачи, не порядком секций (§7).
describe('прототипы: своя подача первого экрана', () => {
  it('editorial подаёт ближайшее событие строкой-анонсом', () => {
    const html = readDemoPage(previewPath('editorial'));
    expect(html, 'нет строки-анонса события').toContain('data-event-line');
    expect(html, 'нет editorial hero').toContain('data-hero="editorial"');

    const at = html.indexOf('data-event-line');
    const line = html.slice(at, at + 900);
    expect(line, 'в анонсе нет города').toMatch(/Санкт-Петербург|Москва|Онлайн|Уточняется|Челны|Новосибирск|Новгород/);
    expect(line, 'в анонсе нет цены или пометки «бесплатно»').toMatch(/₽|Бесплатно/);
  });

  it('faculty подаёт событие карточкой с преподавателем', () => {
    const html = readDemoPage(previewPath('faculty'));
    expect(html, 'нет faculty hero').toContain('data-hero="faculty"');
    expect(html, 'нет карточки события с преподавателем').toContain('data-event-teacher');
    expect(html, 'faculty не должен повторять строку editorial').not.toContain('data-event-line');
  });

  it('modular подаёт каталог: picker + сетка дат без строки editorial', () => {
    const html = readDemoPage(previewPath('modular'));
    expect(html, 'нет modular hero').toContain('data-hero="modular"');
    expect(html, 'нет модуля подбора').toContain('data-modular-picker');
    expect(html, 'нет сетки дат').toContain('data-upcoming="modular"');
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
    // dateLabel из formatScheduleDateRange: «5 сен» или «12–14 сен»
    expect(html, 'нет data-атрибута faculty-шапки').toContain('data-seminar-architecture="faculty"');
    expect(
      html.match(/sem-fa-pills[\s\S]*?<li[^>]*>\d{1,2}(?:[–-]\d{1,2})?\s+[а-яё]{3}</),
      'в pill-списке faculty нет даты',
    ).not.toBeNull();
  });

  it('undated не приписывает чужого преподавателя института', () => {
    // Сопоставление только через seminar.teachers — иначе Faculty врёт владельцу.
    for (const id of ['editorial', 'faculty', 'modular'] as const) {
      const html = readDemoPage(previewPath(id, '/seminar-undated'));
      const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]?.trim();
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
