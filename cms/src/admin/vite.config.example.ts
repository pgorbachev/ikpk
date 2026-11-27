import { mergeConfig, type Plugin, type UserConfig } from 'vite';
import { resolve } from 'node:path';
import { createAdminLoginRedirectPlugin } from './admin-login-redirect-plugin';
import { bookSellerMenuLinkPlugin } from './book-seller-menu-plugin';

// Strapi 5.51.2's BackButton otherwise depends on transient navigation history.
// Restrict the override to an occurrence opened explicitly from a seminar.
// Opening the occurrence on its own page must keep the seminar it was created from.
function occurrenceCreateUrl(): Plugin {
  let transformed = false;
  const modalBack = 'disabled: state.documentHistory.length < 2,\n                                                onClick: ()=>{\n                                                    dispatch({\n                                                        type: \'GO_BACK\',';
  const marker = 'const generateCreateUrl = (currentDocumentMeta)=>{\n    return `/content-manager/${currentDocumentMeta.collectionType}/${currentDocumentMeta.model}/create${currentDocumentMeta.params?.locale ? `?plugins[i18n][locale]=${currentDocumentMeta.params.locale}` : \'\'}`;\n};';
  return {
    name: 'ikpk-occurrence-create-url',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/FormInputs/Relations/RelationModal.mjs')) return;
      if (!code.includes(marker)) throw new Error('Strapi relation create URL changed; update the occurrence navigation integration');
      if (!code.includes(modalBack)) throw new Error('Strapi relation modal back button changed; update the occurrence navigation integration');
      transformed = true;
      return code.replace(modalBack, `disabled: state.documentHistory.length < 2 && !(currentDocumentMeta.model === 'api::schedule-entry.schedule-entry' && /\\/api::seminar\\.seminar\\/[a-z0-9]+(?:\\/|$)/.test(window.location.pathname)),
                                                onClick: ()=>{
                                                    dispatch({
                                                        type: state.documentHistory.length < 2 ? 'CLOSE_MODAL' : 'GO_BACK',`)
        .replace(marker, `const generateCreateUrl = (currentDocumentMeta)=>{
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

function contactEditorRedirect(): Plugin {
  let transformed = false;
  return {
    name: 'ikpk-contact-editor-redirect',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/@strapi/content-manager/dist/admin/pages/EditView/EditViewPage.mjs')) return;
      const routerImport = "import { useParams, useLocation } from 'react-router-dom';";
      const hookMarker = '    const location = useLocation();';
      const documentMarker = '    const hasDraftAndPublished = schema?.options?.draftAndPublish ?? false;';
      const renderMarker = '    const handleTabChange = (status)=>{';
      if (!code.includes(routerImport) || !code.includes(hookMarker) || !code.includes(documentMarker) || !code.includes(renderMarker)) {
        throw new Error('Strapi EditView changed; update the contacts editor integration');
      }
      transformed = true;
      return code.replace("useRBAC, Page,", "useRBAC, useFetchClient, Page,")
        .replace(routerImport, "import { useParams, useLocation, Navigate } from 'react-router-dom';")
        .replace(hookMarker, hookMarker + "\n    const { origin } = useParams();\n    const { get } = useFetchClient();")
        .replace(documentMarker, `    const isContact = model === 'api::page.page' && id && !origin && document?.slug === 'kontakty';
    const isBookPage = model === 'api::page.page' && id && !origin && document?.slug === 'knigi-i-uchebnye-materialy';
    const contactRef = React.useRef(null);
    if (!isContact) contactRef.current = null;
    else if (!contactRef.current || contactRef.current.id !== id) contactRef.current = { id };
    const contact = contactRef.current;
    const bookRef = React.useRef(null);
    if (!isBookPage) bookRef.current = null;
    else if (!bookRef.current || bookRef.current.id !== id) bookRef.current = { id };
    const bookPage = bookRef.current;
    const [access, setAccess] = React.useState(null);
    const [bookAccess, setBookAccess] = React.useState(null);
    React.useEffect(() => {
        if (!contact) return;
        let current = true;
        get('/admin/site-phones').then(() => {
            if (current) setAccess({ contact, value: 'allowed' });
        }).catch(error => {
            if (current) setAccess({ contact, value: error?.status === 403 ? 'denied' : 'error' });
        });
        return () => { current = false; };
    }, [get, contact]);
    React.useEffect(() => {
        if (!bookPage) return;
        let current = true;
        get('/admin/site-books').then(() => {
            if (current) setBookAccess({ bookPage, value: 'allowed' });
        }).catch(error => {
            if (current) setBookAccess({ bookPage, value: error?.status === 403 ? 'denied' : 'error' });
        });
        return () => { current = false; };
    }, [get, bookPage]);
` + documentMarker)
        .replace(renderMarker, `    if (isBookPage && (!bookAccess || bookAccess.bookPage !== bookPage)) return /*#__PURE__*/ jsx(Page.Loading, {});
    if (isBookPage && bookAccess?.bookPage === bookPage && bookAccess.value === 'allowed') {
        return /*#__PURE__*/ jsx(Navigate, { to: '/content-manager/collection-types/site-book-intro', replace: true });
    }
    if (isContact) {
        if (!access || access.contact !== contact) return /*#__PURE__*/ jsx(Page.Loading, {});
        if (access.value === 'error') return /*#__PURE__*/ jsx(Page.Error, {});
        if (access.value === 'allowed') return /*#__PURE__*/ jsx(Navigate, { to: '/content-manager/collection-types/site-contact-phones', replace: true });
    }
` + renderMarker);
    },
    generateBundle() {
      if (!transformed) throw new Error('Strapi EditView not found; update the contacts editor integration');
    },
  };
}

export default (config: UserConfig) => {
  // Important: always return the modified config
  return mergeConfig(config, {
    cacheDir: resolve(process.cwd(), '.vite-cache/admin'),
    plugins: [
      createAdminLoginRedirectPlugin(), occurrenceBackButton(), occurrenceCreateUrl(),
      contactEditorRedirect(), bookSellerMenuLinkPlugin(),
      {
        name: 'ikpk-page-edit-form',
        enforce: 'pre',
        resolveId(source: string, importer?: string) {
          if (source === './components/FormLayout.mjs' &&
            importer?.endsWith('/@strapi/content-manager/dist/admin/pages/EditView/EditViewPage.mjs')) {
            return resolve(process.cwd(), 'src/admin/components/PageEditForm.tsx');
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': '/src',
        '@ikpk/native-form-layout': resolve(process.cwd(), 'node_modules/@strapi/content-manager/dist/admin/pages/EditView/components/FormLayout.mjs'),
        '@ikpk/native-relations': resolve(process.cwd(), 'node_modules/@strapi/content-manager/dist/admin/pages/EditView/components/FormInputs/Relations/Relations.mjs'),
        '@ikpk/document-context': resolve(process.cwd(), 'node_modules/@strapi/content-manager/dist/admin/hooks/useDocumentContext.mjs'),
        '@ikpk/strapi-date-time-input': resolve(process.cwd(), 'node_modules/@strapi/admin/dist/admin/admin/src/components/FormInputs/DateTime.mjs'),
      },
    },
  });
};
