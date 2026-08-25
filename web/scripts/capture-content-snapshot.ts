/**
 * Снятие снимка контента. В публикующем/compat-прогоне — шаг с доступом к CMS
 * (`CMS_URL` / `CMS_TOKEN`). Без живого API копирует закреплённую фикстуру.
 *
 * Имя скрипта входит в признак производителя снимка в проверках pipeline.
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSnapshotContract } from './lib/content-contract.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..');
const outDir = process.env.CONTENT_SNAPSHOT_DIR || join(webRoot, '.snapshot');

const cmsUrl = process.env.CMS_URL ?? process.env.STRAPI_URL ?? '';

function copyPinned(): void {
  const pinned = join(repoRoot, 'fixtures', 'content-snapshot');
  if (!existsSync(join(pinned, 'snapshot.json'))) {
    throw new Error(`нет закреплённого снимка ${pinned}`);
  }
  mkdirSync(outDir, { recursive: true });
  cpSync(join(pinned, 'snapshot.json'), join(outDir, 'snapshot.json'));
  const panels = join(pinned, 'collapsible_panels.json');
  if (existsSync(panels)) cpSync(panels, join(outDir, 'collapsible_panels.json'));
  const urlMap = join(pinned, 'url_map.csv');
  if (existsSync(urlMap)) cpSync(urlMap, join(outDir, 'url_map.csv'));
  const snap = JSON.parse(readFileSync(join(outDir, 'snapshot.json'), 'utf-8'));
  assertSnapshotContract(snap);
  console.log(`snapshot:capture → фикстура в ${outDir}`);
}

if (cmsUrl) {
  // Живой REST — после наполнения CMS соседним change. До тех пор фикстура.
  console.warn(
    `snapshot:capture: CMS_URL задан, живой захват ещё не подключён — используется закреплённая фикстура`,
  );
}
copyPinned();
