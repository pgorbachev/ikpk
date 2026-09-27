import { describe, expect, it } from 'vitest';
import { readDeclared } from './helpers/provision-contract';

describe('режим форм для обновления сайта из CMS', () => {
  it('стенд объявляет заглушку, а production не наследует её', () => {
    expect(readDeclared('stand').get('SITE_DEMO_FORMS')).toBe('stub');
    expect(readDeclared('prod').get('SITE_DEMO_FORMS')).toBeUndefined();
  });
});
