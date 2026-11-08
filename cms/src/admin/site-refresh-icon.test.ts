import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SITE_REFRESH_ICON_PATH, siteRefreshIconProps } from './site-refresh-icon.ts';

test('иконка обновления сайта принимает размер меню и не красится именем темы', () => {
  const props = siteRefreshIconProps({ width: 20, height: 20, fill: 'neutral500' });
  assert.equal(props.width, 20);
  assert.equal(props.height, 20);
  assert.equal(props.viewBox, '0 0 32 32');
  assert.equal(props.fill, 'none');
  assert.match(SITE_REFRESH_ICON_PATH, /^M16 3a13/);
});

test('пункт меню подключает эту иконку, а не уменьшенные стрелки обновления', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.tsx'), 'utf8');
  assert.match(source, /icon: SiteRefreshIcon/);
  assert.match(source, /siteRefreshIconProps/);
  assert.doesNotMatch(source, /width="1em"/);
  assert.doesNotMatch(source, /M12 6V3L8 7l4 4/);
});
