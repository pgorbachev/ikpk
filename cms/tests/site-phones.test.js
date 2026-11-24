import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPublication } from '../src/lib/publication-validation.ts';
import { checkPublication as checkPairedPublication } from '../../scripts/lib/cms-publication-validation.ts';

const page = {
  identifier: 'kontakty', title: 'Новое название', body: '<p>Адрес</p>',
  seo_title: 'Контакты', seo_description: 'Адрес центра',
  center_phone: '+7 (812) 555-01-01', manager_phone: '+79815550202',
};

for (const [name, check] of [['CMS', checkPublication], ['paired release', checkPairedPublication]]) {
  const publish = (changes) => check({ type: 'static-page', record: { ...page, ...changes } });

  test(name + ' publishes both valid phone formats and ordinary pages without phones', () => {
    assert.equal(publish({}).ok, true);
    assert.equal(publish({ identifier: 'other', center_phone: null, manager_phone: null }).ok, true);
  });

  for (const [field, label] of [['center_phone', /центр|center_phone/i], ['manager_phone', /менеджер|manager_phone/i]]) {
    test(name + ' refuses an invalid ' + field + ' and explains +7 format', () => {
      for (const invalid of [null, '', '8 (812) 555-01-01', '+78125550', '+781255501011', '+7abc8125550101', 'tel:+78125550101', '+7８１２5550101']) {
        const result = publish({ [field]: invalid });
        assert.equal(result.ok, false, field + ' accepted ' + JSON.stringify(invalid));
        assert.match(result.message, label);
        assert.match(result.message, /\+7/);
      }
    });
  }
}
