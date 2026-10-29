import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

const PINNED_CONTENT_MANAGER_VERSION = '5.51.2';
const PINNED_RELATIONS_SHA256 = '2f8e53e87c211496de198f203800e3f108fd09941834388e35507e2928874073';
const RELATIONS_MODULE_SUFFIX = '/@strapi/content-manager/dist/admin/pages/EditView/components/FormInputs/Relations/Relations.mjs';
const ORIGINAL_QUERY_MARKER = 'const { data, isLoading, isFetching } = useGetRelationsQuery({';
const ORIGINAL_SCOPE_MARKER = "const [targetField] = props.name.split('.').slice(-1);";
const ORIGINAL_STATUS_MARKER = 'const isFetchingMoreRelations = isLoading || isFetching;';
const ORIGINAL_LIST_MARKER = '            /*#__PURE__*/ jsx(MemoizedRelationsList, {\n                data: relations,';
const ORIGINAL_LIST_PROPS_MARKER = 'const RelationsList = ({ data, serverData, disabled, name, isLoading, relationType, targetModel, documentParams, mainField })=>{';
const ORIGINAL_HEIGHT_MARKER = 'const dynamicListHeight = data.length > RELATIONS_TO_DISPLAY ? Math.min(data.length, RELATIONS_TO_DISPLAY) * (RELATION_ITEM_HEIGHT + RELATION_GUTTER) + RELATION_ITEM_HEIGHT / 2 : Math.min(data.length, RELATIONS_TO_DISPLAY) * (RELATION_ITEM_HEIGHT + RELATION_GUTTER);';
const require = createRequire(import.meta.url);

function replaceExactlyOnce(source: string, marker: string, replacement: string): string {
  if (source.split(marker).length !== 2) {
    throw new Error(`Pinned Strapi Relations.mjs must contain exactly one transform marker: ${marker.slice(0, 80)}`);
  }
  return source.replace(marker, replacement);
}

function transformRelations(source: string): string {
  let output = source;
  output = replaceExactlyOnce(output, "import { jsxs, jsx } from 'react/jsx-runtime';", `import { jsxs, jsx } from 'react/jsx-runtime';\nimport { invalidateTeacherRelationsStatus, setTeacherRelationsStatus } from '${resolve(process.cwd(), 'src/admin/teacher-relations-state.ts')}';`);
  output = replaceExactlyOnce(output, ORIGINAL_SCOPE_MARKER, `${ORIGINAL_SCOPE_MARKER}\n    const databaseClient = window.strapi?.flags?.ikpkDatabaseClient;\n    const isSqliteOrUnknown = databaseClient !== 'postgres' && databaseClient !== 'mysql';\n    const isTeacherRelationsField = isSqliteOrUnknown && !componentUID && model === 'api::schedule-entry.schedule-entry' && targetModel === 'api::teacher.teacher' && targetField === 'teachers';`);
  output = replaceExactlyOnce(output, ORIGINAL_QUERY_MARKER, 'const { data, isLoading, isFetching, isError } = useGetRelationsQuery({');
  output = replaceExactlyOnce(output, ORIGINAL_STATUS_MARKER, `${ORIGINAL_STATUS_MARKER}
    React.useLayoutEffect(() => {
        if (!isTeacherRelationsField || !documentId) return;
        setTeacherRelationsStatus(documentId, 'loading');
        return () => invalidateTeacherRelationsStatus(documentId);
    }, [isTeacherRelationsField, documentId]);
    React.useLayoutEffect(() => {
        if (!isTeacherRelationsField || !documentId) return;
        if (isFetchingMoreRelations) {
            setTeacherRelationsStatus(documentId, 'loading');
            return;
        }
        if (isError || !data?.pagination) {
            setTeacherRelationsStatus(documentId, 'error');
            return;
        }
        if (data.results.length >= data.pagination.total) {
            setTeacherRelationsStatus(documentId, 'ready');
            return;
        }
        if (data.pagination.page !== currentPage || currentPage >= data.pagination.pageCount) {
            setTeacherRelationsStatus(documentId, 'error');
            return;
        }
        setTeacherRelationsStatus(documentId, 'loading');
        setCurrentPage(currentPage + 1);
    }, [isTeacherRelationsField, documentId, isFetchingMoreRelations, isError, data, currentPage]);`);
  output = replaceExactlyOnce(output, ORIGINAL_LIST_MARKER, `            isTeacherRelationsField && isError ? /*#__PURE__*/ jsx(Typography, { tag: 'p', color: 'danger600', role: 'alert', children: 'Не удалось загрузить полный список преподавателей проведения.' }) : null,
            /*#__PURE__*/ jsx(MemoizedRelationsList, {
                data: relations,
                isTeacherRelationsField: isTeacherRelationsField,`);
  output = replaceExactlyOnce(output, ORIGINAL_LIST_PROPS_MARKER, 'const RelationsList = ({ data, serverData, disabled, name, isLoading, relationType, targetModel, documentParams, mainField, isTeacherRelationsField })=>{');
  output = replaceExactlyOnce(output, ORIGINAL_HEIGHT_MARKER, `const dynamicListHeight = isTeacherRelationsField ? data.length * (RELATION_ITEM_HEIGHT + RELATION_GUTTER) : ${ORIGINAL_HEIGHT_MARKER.slice('const dynamicListHeight = '.length)}`);
  return output;
}

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
  for (const marker of [ORIGINAL_QUERY_MARKER, ORIGINAL_SCOPE_MARKER, ORIGINAL_STATUS_MARKER, ORIGINAL_LIST_MARKER, ORIGINAL_LIST_PROPS_MARKER, ORIGINAL_HEIGHT_MARKER]) {
    if (source.split(marker).length !== 2) {
      throw new Error(`Pinned Strapi Relations.mjs must contain exactly one transform marker: ${marker.slice(0, 80)}`);
    }
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
      if (createHash('sha256').update(code).digest('hex') !== PINNED_RELATIONS_SHA256) {
        this.error('Pinned Strapi Relations.mjs no longer matches the reviewed teacher-list pagination transform');
      }
      if (transformCount !== 0) {
        this.error('Pinned Strapi Relations.mjs was transformed more than once');
      }

      transformCount += 1;
      try {
        return { code: transformRelations(code), map: null };
      } catch (error) {
        this.error(error instanceof Error ? error.message : 'Failed to transform the pinned Strapi relations module');
      }
    },
    generateBundle() {
      if (transformCount !== 1) {
        this.error('Expected exactly one pinned Strapi Relations.mjs transform; refusing to build a partial teacher list');
      }
    },
  };
}
