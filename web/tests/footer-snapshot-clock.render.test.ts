import { afterEach, expect, it, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Footer from '../src/components/Footer.astro';
import * as data from '../src/lib/data.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('renders the footer year from the snapshot even under a later system year', async () => {
  vi.spyOn(data, 'getSnapshotReferenceDate').mockReturnValue('2026-09-20');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2035-01-01T12:00:00Z'));
  const container = await AstroContainer.create();
  const html = await container.renderToString(Footer);
  expect(html).toContain('© 2026 ikpk.su');
  expect(html).not.toContain('© 2035 ikpk.su');
});
