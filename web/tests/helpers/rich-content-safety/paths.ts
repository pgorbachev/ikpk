import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Корень git-репозитория (каталог с `openspec/` и `web/`). */
export const REPO_ROOT = join(here, '..', '..', '..', '..');

export const WEB_ROOT = join(REPO_ROOT, 'web');
export const WEB_SRC = join(WEB_ROOT, 'src');
export const ENTITIES_DIR = join(REPO_ROOT, 'discovery', 'entities');
export const CMS_API_DIR = join(REPO_ROOT, 'cms', 'src', 'api');
export const FIXTURES_DIR = join(here, '..', '..', 'fixtures', 'rich-content-safety');
export const MEDIA_MANIFEST = join(WEB_SRC, 'lib', 'media-manifest.json');
export const PACKAGE_LOCK = join(WEB_ROOT, 'package-lock.json');

export const CHARACTERIZATION_SHA = '2d48e84db36c013fabcbbe9ba389e1f4debca639';
export const PLANNING_MERGE_SHA = '4cda9b18b98c24ff510dd04e50fe0968449bf1b9';

export const KNOWN_REMOTE_UPLOAD =
  'https://ikpk.su/api/upload/file/0acd713c-1477-4c6c-93ad-1596d2a17304';
export const LOCAL_UPLOAD_WEBP = '/media/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp';
export const LOCAL_UPLOAD_ORIGINAL = join(
  REPO_ROOT,
  'media-originals',
  'uploads',
  '0acd713c-1477-4c6c-93ad-1596d2a17304.webp',
);
