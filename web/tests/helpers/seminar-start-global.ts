import { serveSeminarStartFixture } from './seminar-start-fixture';

export default async function globalSetup() {
  const fixture = await serveSeminarStartFixture();
  process.env.IKPK_START_FIXTURE = JSON.stringify({
    url: fixture.url, programPath: fixture.programPath, detailPaths: fixture.detailPaths,
  });
  return async () => { await fixture.close(); };
}
