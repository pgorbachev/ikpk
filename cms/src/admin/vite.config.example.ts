import { mergeConfig, type Plugin, type UserConfig } from 'vite';
import { resolve } from 'node:path';
import { createAdminLoginRedirectPlugin } from './admin-login-redirect-plugin';

// Strapi 5.51.2's BackButton otherwise depends on transient navigation history.
// Restrict the override to an occurrence opened explicitly from a seminar.
// Opening the occurrence on its own page must keep the seminar it was created from.
function occurrenceCreateUrl(): Plugin {
  let transformed = false;
  const marker = 'const generateCreateUrl = (currentDocumentMeta)=>{\n    return `/content-manager/${currentDocumentMeta.collectionType}/${currentDocumentMeta.model}/create${currentDocumentMeta.params?.locale ? `?plugins[i18n][locale]=${currentDocumentMeta.params.locale}` : \'\'}`;\n};';
  return {
    name: 'ikpk-occurrence-create-url',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/FormInputs/Relations/RelationModal.mjs')) return;
      if (!code.includes(marker)) throw new Error('Strapi relation create URL changed; update the occurrence navigation integration');
      transformed = true;
      return code.replace(marker, `const generateCreateUrl = (currentDocumentMeta)=>{
    const base = \`/content-manager/\${currentDocumentMeta.collectionType}/\${currentDocumentMeta.model}/create\${currentDocumentMeta.params?.locale ? \`?plugins[i18n][locale]=\${currentDocumentMeta.params.locale}\` : ''}\`;
    if (currentDocumentMeta.model !== 'api::schedule-entry.schedule-entry') return base;
    const source = window.location.pathname.match(/\\/api::seminar\\.seminar\\/([a-z0-9]+)(?:\\/|$)/);
    if (!source) return base;
    return base + (base.includes('?') ? '&' : '?') + 'fromSeminar=' + source[1];
};`);
    },
    generateBundle() {
      if (!transformed) throw new Error('Strapi relation create URL was not found; update the occurrence navigation integration');
    },
  };
}

function occurrenceBackButton(): Plugin {
  let transformed = false;
  const marker = 'const handleClick = (e)=>{\n        e.preventDefault();\n        if (canGoBack) {';
  return {
    name: 'ikpk-occurrence-back-button',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/@strapi/admin/dist/admin/admin/src/features/BackButton.mjs')) return;
      if (!code.includes(marker)) throw new Error('Strapi BackButton changed; update the occurrence navigation integration');
      transformed = true;
      return code.replace(marker, `const handleClick = (e)=>{
        e.preventDefault();
        const source = new URLSearchParams(window.location.search).get('fromSeminar');
        if (window.location.pathname.includes('/api::schedule-entry.schedule-entry/') && source && /^[a-z0-9]+$/.test(source)) {
            navigate('/content-manager/collection-types/api::seminar.seminar/' + encodeURIComponent(source));
            return;
        }
        if (canGoBack) {`);
    },
    generateBundle() {
      if (!transformed) throw new Error('Strapi BackButton was not found; update the occurrence navigation integration');
    },
  };
}

export default (config: UserConfig) => {
  // Important: always return the modified config
  return mergeConfig(config, {
    cacheDir: resolve(process.cwd(), '.vite-cache/admin'),
    plugins: [createAdminLoginRedirectPlugin(), occurrenceBackButton(), occurrenceCreateUrl()],
    resolve: {
      alias: {
        '@': '/src',
        '@ikpk/native-relations': resolve(process.cwd(), 'node_modules/@strapi/content-manager/dist/admin/pages/EditView/components/FormInputs/Relations/Relations.mjs'),
        '@ikpk/document-context': resolve(process.cwd(), 'node_modules/@strapi/content-manager/dist/admin/hooks/useDocumentContext.mjs'),
      },
    },
  });
};
