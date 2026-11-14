import { mergeConfig, type Plugin, type UserConfig } from 'vite';
import { resolve } from 'node:path';
import { createAdminLoginRedirectPlugin } from './admin-login-redirect-plugin';

// Strapi 5.51.2's BackButton otherwise depends on transient navigation history.
// Restrict the override to an occurrence opened explicitly from a seminar.
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
    plugins: [createAdminLoginRedirectPlugin(), occurrenceBackButton()],
    resolve: {
      alias: {
        '@': '/src',
        '@ikpk/native-relations': resolve(process.cwd(), 'node_modules/@strapi/content-manager/dist/admin/pages/EditView/components/FormInputs/Relations/Relations.mjs'),
      },
    },
  });
};
