import { serveSeminarStartFixture } from './seminar-start-fixture';

export default async function globalSetup() {
  const fixture = await serveSeminarStartFixture('month');
  process.env.IKPK_MONTH_FIXTURE = JSON.stringify({
    url: fixture.url, outDir: fixture.outDir, entries: fixture.entries,
  });
  return async () => { await fixture.close(); };
}
