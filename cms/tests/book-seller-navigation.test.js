import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';

const cmsRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('book editor navigation is injected under Content Manager only after the exact server capability succeeds', async () => {
  const module = await import(pathToFileURL(resolve(cmsRoot, 'src/admin/book-seller-menu-plugin.ts')).href);
  const plugin = module.bookSellerMenuLinkPlugin();
  assert.equal(plugin.name, 'ikpk-book-seller-menu-link');
  const source = `import { SubNav } from '@strapi/admin/strapi-admin';
    const collectionTypeLinks = useTypedSelector((state)=>state['content-manager'].app.collectionTypeLinks);`;
  const transformed = await plugin.transform(source,
    '/repo/cms/node_modules/@strapi/content-manager/dist/admin/components/LeftMenu.mjs');
  const code = typeof transformed === 'string' ? transformed : transformed.code;
  assert.match(code, /get\('\/admin\/site-books'\)\.then/);
  assert.match(code, /get\('\/admin\/site-student-document-form'\)\.then/);
  assert.match(code, /\.catch\(\(\) => \{[\s\S]*setCanEditBooks\(false\)/);
  assert.match(code, /const canOpenPages = canEditPhones \|\| canEditBooks \|\| canEditStudentDocumentForm/);
  assert.match(code, /title: 'Страницы', to: '\/content-manager\/collection-types\/site-pages'/);
  assert.match(code, /title: 'Все страницы'/);
  assert.doesNotMatch(code, /site-book-intro/);

  const app = readFileSync(resolve(cmsRoot, 'src/admin/app.tsx'), 'utf8');
  assert.match(app, /path: 'collection-types\/site-pages'/);
  assert.match(app, /path: 'collection-types\/site-book-intro'/);
  assert.match(app, /path: 'collection-types\/site-student-document-form'/);
  const viteConfig = readFileSync(resolve(cmsRoot, 'src/admin/vite.config.example.ts'), 'utf8');
  assert.match(viteConfig, /bookSellerMenuLinkPlugin\(\)/);
  assert.doesNotMatch(app, /addMenuLink\(\{[\s\S]*site-book-intro/);
  const landing = readFileSync(resolve(cmsRoot, 'src/admin/pages/SitePages.tsx'), 'utf8');
  assert.match(landing, /client\.get\('\/admin\/site-books'\)/);
  assert.match(landing, /capabilities\?\.books &&[\s\S]*navigate\('\/content-manager\/collection-types\/site-book-intro'\)/);
  assert.match(landing, /capabilities\?\.contacts &&[\s\S]*navigate\('\/content-manager\/collection-types\/site-contact-phones'\)/);
  assert.match(landing, /capabilities\?\.studentDocumentForm &&[\s\S]*navigate\('\/content-manager\/collection-types\/site-student-document-form'\)/);
  assert.match(landing, />\s*Оплата\s*</);
  const payment = readFileSync(resolve(cmsRoot, 'src/admin/pages/SiteStudentDocumentForm.tsx'), 'utf8');
  assert.match(payment, /<Typography variant="alpha" tag="h1">Оплата<\/Typography>/);
  assert.match(payment, /student_document_form_url/);
});
