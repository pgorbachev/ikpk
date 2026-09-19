import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deployCheck, pages, required, tree } from './helpers';

it('CRM form destinations match the explicitly selected deployment mode', () => {
  expect(required('PUBLICATION_DESTINATION_ID').length).toBeGreaterThan(0);
  deployCheck('form_links_match_mode', tree(), required('DEPLOY_MODE'), process.env.DEMO_FORMS ?? '');
});
it('analytics and robots match production or stand mode', () => {
  const mode = required('DEPLOY_MODE'); expect(['prod', 'stand']).toContain(mode);
  const robots = readFileSync(join(tree(), 'robots.txt'), 'utf8');
  const home = readFileSync(join(tree(), 'index.html'), 'utf8');
  const counter = /mc\.yandex\.ru\/metrika|top-fwz1\.mail\.ru\/js\/code\.js/;
  if (mode === 'stand') {
    expect(robots).toMatch(/^Disallow:\s*\/\s*$/m);
    for (const page of pages()) expect(page.html, page.route).not.toMatch(counter);
  } else {
    expect(robots).not.toMatch(/^Disallow:\s*\/\s*$/m);
    expect(robots).toMatch(/^Sitemap:\s*https:\/\/ikpk\.su\//m);
    expect(home).toMatch(counter);
  }
});
it('chat configuration is explicitly declared and matches the artifact', () => {
  deployCheck('chat_widget_matches_mode', tree(), required('DEPLOY_MODE'), required('CHAT_LOADER_SRC'));
});
it('payment role is declared independently of the CRM mode', () => {
  const role = required('PAYMENT_ROLE'); expect(['ci', 'stand', 'prod']).toContain(role);
  deployCheck('payment_endpoint_matches', tree(), role === 'ci' ? '' : required('PUBLICATION_PAYMENT_ENDPOINT'), role);
});
