import { serveSeminarStartFixture } from './seminar-start-fixture';

export default async function globalSetup() {
  const fixture = await serveSeminarStartFixture('layout');
  process.env.IKPK_LAYOUT_FIXTURE_URL = fixture.url;
  return async () => { await fixture.close(); };
}
