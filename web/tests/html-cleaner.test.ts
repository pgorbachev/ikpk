import { describe, it, expect } from 'vitest';
import { cleanBodyHtml, stripH1, stripLegacySeminarTail } from '../src/lib/html-cleaner.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 1 – Article page
// articles-form_ wrappers + typography_ classes + se-root → clean semantic HTML
// ─────────────────────────────────────────────────────────────────────────────
describe('Fixture 1: Article HTML', () => {
  const input = `<div class="articles-form_articleContainer__13oDC">
  <div class="articles-form_articleSectionContent__hTEtt">
    <article class="articles-form_articlesFirstContent__bkDcu">
      <div class="articles-form_imageWrapper__2GmCm">
        <img src="https://storage.yandexcloud.net/ikpk-image/photo.webp" alt="">
      </div>
      <div class="articles-form_articleTitleWrapper__bF2N_">
        <h1 class="typography_large_2__K1ZaE typography_secondary__kNyf_ articles-form_articleTitle__pBIaI">Article Title</h1>
        <p class="typography_body_2__aP_ck typography_secondary__kNyf_">20 янв., 2025</p>
      </div>
      <div class="articles-form_articleContent__Ohnck se-root">
        <h2 class="typography_h2__Dgg2h typography_secondary__kNyf_">Section Title</h2>
        <p>Actual content with <a href="/link">a link</a> and <strong>bold</strong>.</p>
        <ul><li>Item 1</li><li>Item 2</li></ul>
      </div>
    </article>
  </div>
  <div class="subscribe-news-form_wrapper___xXSq">
    <h2>Подпишитесь</h2>
    <input class="text-field_root__sCrCb" type="email">
    <button class="button_primary__q1q5a subscribe-news-form_button__60WzQ" type="submit">Подписаться</button>
  </div>
</div>`;

  it('removes subscribe-news-form wrapper entirely', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('Подпишитесь');
    expect(result).not.toContain('subscribe-news-form_');
    expect(result).not.toContain('Подписаться');
  });

  it('removes articles-form_ layout wrappers but keeps content', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('articles-form_');
    expect(result).toContain('20 янв., 2025');
    expect(result).toContain('Section Title');
    expect(result).toContain('Actual content with');
    expect(result).toContain('<a href="/link">a link</a>');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<ul>');
  });

  it('strips typography_ classes from headings and paragraphs', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('typography_');
    expect(result).toContain('<h2>Section Title</h2>');
    expect(result).toContain('<p>20 янв., 2025</p>');
  });

  it('preserves the image', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('ikpk-image/photo.webp');
  });

  it('removes h1 tags', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('<h1');
    expect(result).not.toContain('Article Title');
  });

  it('leaves no CSS Module class attributes', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toMatch(/class="[^"]*__[^"]*"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 2 – Seminar page
// seminar-form_ wrappers + collapsible_ sections → details/summary
// ─────────────────────────────────────────────────────────────────────────────
describe('Fixture 2: Seminar HTML', () => {
  const input = `<div class="seminar-form_container__zE_wL">
  <section>
    <h1 class="typography_large_2__K1ZaE typography_secondary__kNyf_">Seminar Name</h1>
    <div class="seminar-form_description___Pbn6 se-root">
      <p>Seminar description text.</p>
    </div>
    <ul class="seminar-data-collapse-section_collapsibleList__w0XmH">
      <li id="2">
        <div class="card_root__RBQQU seminar-data-collapse-section_collapsibleCard__b9V75">
          <div class="" data-state="closed">
            <button aria-controls="radix-:Rq:" aria-expanded="false" class="collapsible_trigger__hquru" data-state="closed" type="button">
              <div class="collapsible_triggerRow__wjc15">
                <div class="collapsible_titleBox__taV8r">
                  <h2 class="collapsible_title__FV6yb" data-collapsible-title="true">Учебный план</h2>
                </div>
                <div class="collapsible_iconWrapper__4v4Jm"><svg></svg></div>
              </div>
            </button>
          </div>
        </div>
      </li>
    </ul>
    <div class="seminar-form_actionControl__ilu5q">
      <h3 class="typography_h3__XWX0L typography_secondary__kNyf_">Расписание</h3>
    </div>
  </section>
</div>`;

  it('removes seminar-form_ layout wrappers', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('seminar-form_');
  });

  it('converts collapsible trigger to <details><summary>', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('<details>');
    expect(result).toContain('<summary>Учебный план</summary>');
  });

  it('removes the collapsible trigger button', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('collapsible_trigger');
    expect(result).not.toContain('<button');
  });

  it('preserves seminar description content', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('Seminar description text.');
  });

  it('preserves heading text from typography-classed h3', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('<h3>Расписание</h3>');
  });

  it('strips all CSS Module classes', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toMatch(/class="[^"]*__[^"]*"/);
  });

  it('removes h1 tag', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('<h1');
  });

  it('can strip legacy seminar schedule tail before cleaning', () => {
    const result = cleanBodyHtml(stripLegacySeminarTail(input));
    expect(result).not.toContain('<h3>Расписание</h3>');
    expect(result).not.toContain('Показать все');
    expect(result).not.toContain('К сожалению, данный курс');
    expect(result).toContain('Seminar description text.');
    expect(result).toContain('<details>');
  });

  it('removes residual broken closing-tag text nodes', () => {
    const broken = '<ul><li><div><details><summary>Рекомендации</summary></details></div>/li</li></ul>';
    const result = cleanBodyHtml(broken);
    expect(result).not.toContain('</div>/li<');
    expect(result).toContain('<summary>Рекомендации</summary>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 3 – Kontakty page
// contacts_ wrapper + subscribe-news-form orphans (remove) + actual contact info (keep)
// ─────────────────────────────────────────────────────────────────────────────
describe('Fixture 3: Kontakty page', () => {
  const input = `<div class="contacts_contactsContainer__b2Drc">
  <section class="contacts_sectionContactsContent__vlgCb">
    <h1 class="typography_large_3__0B0dD typography_secondary__kNyf_">Контакты</h1>
    <div class="card_root__RBQQU contacts_card__RuEi4">
      <address class="contacts_selectionBlock__P_ts2">
        <div class="contacts_infoItem__Fggkv">
          <a class="contacts_infoText__B8R5I" href="tel:+78126465450">+7 (812) 646-54-50</a>
        </div>
        <div class="contacts_infoItem__Fggkv">
          <a class="contacts_infoText__B8R5I" href="mailto:info@ikpk.su">info@ikpk.su</a>
        </div>
      </address>
    </div>
  </section>
</div>
<div class="text-field_root__sCrCb"><div class="PhoneInputCountrySelectArrow"></div></div>
<input aria-label="Выбрать страну" autocomplete="tel" class="PhoneInputInput" type="tel" value="">
<div class="checkbox_checkboxWrapper__j_4lz">
  <label><span class="subscribe-news-form_agreementText__T_KaY">Я согласен с <a href="#">политикой</a></span></label>
</div>
<button class="button_primary__q1q5a subscribe-news-form_button__60WzQ" type="submit">Подписаться</button>
</div></form></div></section></div>`;

  it('removes the subscribe form orphan elements', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('subscribe-news-form_');
    expect(result).not.toContain('PhoneInput');
    expect(result).not.toContain('text-field_root');
    expect(result).not.toContain('checkbox_checkboxWrapper');
    expect(result).not.toContain('Подписаться');
  });

  it('keeps the actual contact information', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('+7 (812) 646-54-50');
    expect(result).toContain('info@ikpk.su');
    expect(result).toContain('href="tel:+78126465450"');
    expect(result).toContain('href="mailto:info@ikpk.su"');
  });

  it('unwraps contacts_ layout wrappers', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('contacts_');
  });

  it('removes orphaned closing tags', () => {
    const result = cleanBodyHtml(input);
    // Should not have standalone </form> since it was orphaned
    expect(result).not.toContain('</form>');
  });

  it('leaves no CSS Module class attributes', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toMatch(/class="[^"]*__[^"]*"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 4 – Svedeniya (educational-organization) page
// educational-organization_ wrappers + collapsible sections
// ─────────────────────────────────────────────────────────────────────────────
describe('Fixture 4: Svedeniya (educational-organization) page', () => {
  const input = `<div class="educational-organization_educationalOrganizationContainer__5_NA8">
  <section class="educational-organization_infoSection__NN77w">
    <h1 class="typography_large_2__K1ZaE typography_secondary__kNyf_">Сведения об образовательной организации</h1>
    <ul class="educational-organization_collapsibleList__XVgPo">
      <li id="1">
        <div class="card_root__RBQQU educational-organization_collapsibleCard__foEeC">
          <div class="" data-state="closed">
            <button aria-controls="radix-:R3:" aria-expanded="false" class="collapsible_trigger__hquru" data-state="closed" type="button">
              <div class="collapsible_triggerRow__wjc15">
                <div class="collapsible_titleBox__taV8r">
                  <h2 class="collapsible_title__FV6yb" data-collapsible-title="true">Основные сведения</h2>
                </div>
                <div class="collapsible_iconWrapper__4v4Jm"><svg></svg></div>
              </div>
            </button>
          </div>
        </div>
      </li>
      <li id="2">
        <div class="card_root__RBQQU educational-organization_collapsibleCard__foEeC">
          <div class="" data-state="open">
            <button aria-controls="radix-:R5:" aria-expanded="true" class="collapsible_trigger__hquru" data-state="open" type="button">
              <div class="collapsible_triggerRow__wjc15">
                <div class="collapsible_titleBox__taV8r">
                  <h2 class="collapsible_title__FV6yb" data-collapsible-title="true">Структура и органы управления</h2>
                </div>
              </div>
            </button>
            <div class="collapsible_collapsibleContent__uVFtn collapsible_content__H89vO" data-state="open">
              <div class="collapsible_text__MYCAb">
                <p>Директор: Иванов Иван Иванович</p>
              </div>
            </div>
          </div>
        </div>
      </li>
    </ul>
  </section>
</div>`;

  it('unwraps educational-organization_ layout wrappers', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('educational-organization_');
  });

  it('converts closed collapsible to <details> without open attribute', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('<details><summary>Основные сведения</summary></details>');
  });

  it('converts open collapsible to <details open> with content', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('<summary>Структура и органы управления</summary>');
    expect(result).toContain('Директор: Иванов Иван Иванович');
  });

  it('removes all collapsible trigger buttons', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('collapsible_trigger');
  });

  it('strips all CSS Module classes', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toMatch(/class="[^"]*__[^"]*"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 5 – Cooperation page
// cooperation_ wrapper with preserved text content
// ─────────────────────────────────────────────────────────────────────────────
describe('Fixture 5: Cooperation page', () => {
  const input = `<div class="cooperation_withUs___vdp6">
  <div class="cooperation_withUsContainer__RD1GF">
    <article class="cooperation_withUsContent__e_f2F">
      <div class="cooperation_withUsInfo__03u5Q">
        <h1 class="typography_large_2__K1ZaE typography_secondary__kNyf_">Сотрудничество с нами</h1>
        <p class="typography_body_1__ZIAlu typography_secondary__kNyf_">ООО «Институт» приглашает к сотрудничеству.</p>
      </div>
    </article>
  </div>
</div>`;

  it('unwraps cooperation_ layout wrappers', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('cooperation_');
  });

  it('preserves the cooperation description text', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('ООО «Институт» приглашает к сотрудничеству.');
  });

  it('strips typography_ classes leaving bare <p> tag', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('<p>ООО «Институт» приглашает к сотрудничеству.</p>');
  });

  it('removes h1 tag', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('<h1');
    expect(result).not.toContain('Сотрудничество с нами');
  });

  it('leaves no CSS Module class attributes', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toMatch(/class="[^"]*__[^"]*"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 6 – Edge case: button/checkbox OUTSIDE form containers must survive
// ─────────────────────────────────────────────────────────────────────────────
describe('Fixture 6: Non-form button and checkbox preserved', () => {
  const input = `<div class="content-block">
  <p>Regular paragraph with a link: <a href="/page">click here</a>.</p>
  <button class="button_primary__q1q5a" type="button">Schedule a meeting</button>
  <label class="checkbox_label__tO_zD">
    <input type="checkbox" name="terms">
    Accept terms
  </label>
  <h2 class="typography_h2__Dgg2h typography_secondary__kNyf_">Another Section</h2>
  <p class="typography_body_2__aP_ck typography_secondary__kNyf_">More content here.</p>
</div>`;

  it('preserves button outside any form container', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('Schedule a meeting');
  });

  it('preserves label/checkbox outside any form container', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('Accept terms');
    expect(result).toContain('<input');
    expect(result).toContain('type="checkbox"');
  });

  it('preserves links and paragraphs', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('<a href="/page">click here</a>');
    expect(result).toContain('Regular paragraph with a link');
  });

  it('strips CSS Module classes from button', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('button_primary__q1q5a');
    // The button element itself should remain
    expect(result).toContain('<button');
    expect(result).toContain('Schedule a meeting');
  });

  it('strips typography_ classes from h2 and p', () => {
    const result = cleanBodyHtml(input);
    expect(result).toContain('<h2>Another Section</h2>');
    expect(result).toContain('<p>More content here.</p>');
  });

  it('does NOT treat subscribe-news-form links as navigation links', () => {
    // A regular <a> not in a subscribe form must be kept
    const result = cleanBodyHtml(input);
    expect(result).toContain('href="/page"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture 7 – Residual UI and spacer wrappers inside extra content
// ─────────────────────────────────────────────────────────────────────────────
describe('Fixture 7: Residual UI cleanup for extra content', () => {
  const input = `<div class="content-shell">
  <h2>Дополнительная информация</h2>
  <div style="height:140px">
    <h2>Институт Барраля</h2>
    <p>Содержательный абзац без наложения.</p>
  </div>
  <button type="button">Показать еще</button>
  <h3>Часто задаваемые вопросы</h3>
  <p>Ответ.</p>
</div>`;

  it('unwraps inline spacer wrappers that would otherwise clip content', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('style="height:140px"');
    expect(result).toContain('<h2>Институт Барраля</h2>');
    expect(result).toContain('Содержательный абзац без наложения.');
  });

  it('removes residual show-more controls from scraped content', () => {
    const result = cleanBodyHtml(input);
    expect(result).not.toContain('Показать еще');
    expect(result).toContain('<h3>Часто задаваемые вопросы</h3>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripH1 backwards-compatibility export
// ─────────────────────────────────────────────────────────────────────────────
describe('stripH1 export', () => {
  it('strips h1 tags and is still exported', () => {
    const html = '<h1 class="foo">Title</h1><p>Body</p>';
    expect(stripH1(html)).toBe('<p>Body</p>');
  });
});
