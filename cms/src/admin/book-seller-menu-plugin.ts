import type { Plugin } from 'vite';

export function bookSellerMenuLinkPlugin(): Plugin {
  let transformed = false;
  return {
    name: 'ikpk-book-seller-menu-link',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/@strapi/content-manager/dist/admin/components/LeftMenu.mjs')) return;
      const importMarker = "import { SubNav } from '@strapi/admin/strapi-admin';";
      const linkMarker = "    const collectionTypeLinks = useTypedSelector((state)=>state['content-manager'].app.collectionTypeLinks);";
      if (!code.includes(importMarker) || !code.includes(linkMarker)) {
        throw new Error('Strapi LeftMenu changed; update the Pages menu integration');
      }
      transformed = true;
      return code.replace(importMarker, "import { SubNav, useFetchClient } from '@strapi/admin/strapi-admin';")
        .replace(linkMarker, `    const nativeCollectionTypeLinks = useTypedSelector((state)=>state['content-manager'].app.collectionTypeLinks);
    const { get } = useFetchClient();
    const [canEditPhones, setCanEditPhones] = React.useState(false);
    const [canEditBooks, setCanEditBooks] = React.useState(false);
    React.useEffect(() => {
        let current = true;
        get('/admin/site-phones').then(() => {
            if (current) setCanEditPhones(true);
        }).catch(error => {
            if (current) setCanEditPhones(error?.status !== 403);
        });
        return () => { current = false; };
    }, [get]);
    React.useEffect(() => {
        let current = true;
        get('/admin/site-books').then(() => {
            if (current) setCanEditBooks(true);
        }).catch(() => {
            if (current) setCanEditBooks(false);
        });
        return () => { current = false; };
    }, [get]);
    const canOpenPages = canEditPhones || canEditBooks;
    const collectionTypeLinks = canOpenPages && !nativeCollectionTypeLinks.some(link => link.uid === 'api::page.page')
        ? [...nativeCollectionTypeLinks, { uid: 'ikpk-managed-pages', title: 'Страницы', to: '/content-manager/collection-types/site-pages' }]
        : nativeCollectionTypeLinks;`);
    },
    generateBundle() {
      if (!transformed) throw new Error('Strapi LeftMenu not found; update the Pages menu integration');
    },
  };
}
