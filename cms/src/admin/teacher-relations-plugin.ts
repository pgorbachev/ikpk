import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

const PINNED_CONTENT_MANAGER_VERSION = '5.51.2';
const PINNED_RELATIONS_SHA256 = '2f8e53e87c211496de198f203800e3f108fd09941834388e35507e2928874073';
const RELATIONS_MODULE_SUFFIX = '/@strapi/content-manager/dist/admin/pages/EditView/components/FormInputs/Relations/Relations.mjs';
const ORIGINAL_MARKER = 'const isFetchingMoreRelations = isLoading || isFetching;';
const TEACHER_PAGINATION = `${ORIGINAL_MARKER}
    const isTeacherRelationsField = targetModel === 'api::teacher.teacher' && targetField === 'teachers';
    React.useEffect(() => {
        if (!isTeacherRelationsField || isFetchingMoreRelations || !data?.pagination ||
            currentPage >= data.pagination.pageCount) return;
        setCurrentPage((page) => page + 1);
    }, [isTeacherRelationsField, isFetchingMoreRelations, data?.pagination?.pageCount, currentPage]);`;
const require = createRequire(import.meta.url);

function getRelationsModule(): string {
  const packageJsonPath = require.resolve('@strapi/content-manager/package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  if (packageJson.version !== PINNED_CONTENT_MANAGER_VERSION) {
    throw new Error(
      `Expected @strapi/content-manager ${PINNED_CONTENT_MANAGER_VERSION}, found ${packageJson.version ?? 'unknown'}`
    );
  }

  const modulePath = realpathSync(resolve(
    dirname(packageJsonPath),
    'dist/admin/pages/EditView/components/FormInputs/Relations/Relations.mjs'
  ));
  const source = readFileSync(modulePath, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== PINNED_RELATIONS_SHA256) {
    throw new Error('Pinned Strapi Relations.mjs source changed; review the teacher-list pagination transform before upgrading');
  }
  if (source.split(ORIGINAL_MARKER).length !== 2) {
    throw new Error('Pinned Strapi Relations.mjs must contain exactly one known pagination marker');
  }

  return modulePath;
}

/**
 * Strapi 5.51.2 limits the relation field to five rows per request and waits for a
 * manual “Load More”. For the schedule-entry teacher list, load every page before
 * showing the saved order so the existing publish action confirms the full list.
 */
export function createTeacherRelationsPlugin(): Plugin {
  let relationsPath = getRelationsModule();
  let transformCount = 0;

  return {
    name: 'ikpk-complete-teacher-relations',
    enforce: 'pre',
    buildStart() {
      relationsPath = getRelationsModule();
      transformCount = 0;
    },
    transform(code, id) {
      if (id.includes('\0')) return null;
      const sourcePath = id.split('?')[0];
      if (!sourcePath.replaceAll('\\', '/').endsWith(RELATIONS_MODULE_SUFFIX)) return null;

      const modulePath = realpathSync(resolve(sourcePath));
      if (modulePath !== relationsPath) return null;
      if (createHash('sha256').update(code).digest('hex') !== PINNED_RELATIONS_SHA256 ||
          code.split(ORIGINAL_MARKER).length !== 2) {
        this.error('Pinned Strapi Relations.mjs no longer matches the reviewed teacher-list pagination transform');
      }
      if (transformCount !== 0) {
        this.error('Pinned Strapi Relations.mjs was transformed more than once');
      }

      transformCount += 1;
      return { code: code.replace(ORIGINAL_MARKER, TEACHER_PAGINATION), map: null };
    },
    generateBundle() {
      if (transformCount !== 1) {
        this.error('Expected exactly one pinned Strapi Relations.mjs transform; refusing to build a partial teacher list');
      }
    },
  };
}
