/**
 * Полные test-owned матрицы инвариантов oracle-гейта.
 * Не импортирует runtime policy.
 */
import { AUTHENTICATED_FORMS, EXACT_RUTUBE_SRC, RUTUBE_IFRAME_ATTRS, exactRutubeIframe } from './closed-matrix.js';
import type { OccurrenceTag } from './hazard-scan.js';
import { LOCAL_UPLOAD_WEBP } from './paths.js';

export const MATRIX_SINK = { knownSinkIds: ['article-body'] as string[] };

const BASE = LOCAL_UPLOAD_WEBP;
const DERIV_480 = '/media/_w/480/uploads/0acd713c-1477-4c6c-93ad-1596d2a17304.webp';
const PDF = '/media/uploads/054a303b-52c0-4575-b0e1-4347cfd52c3d.pdf';
const MISSING = '/media/uploads/00000000-0000-0000-0000-000000000000.webp';
const MISSING_DERIV = '/media/_w/480/uploads/missing-derivative.webp';

/** Существуют base raster и его 480 derivative; всё остальное — нет. */
export function matrixMediaExists(urlPath: string): boolean {
  return urlPath === BASE || urlPath === DERIV_480;
}

export const MATRIX_OPTS = { ...MATRIX_SINK, mediaFileExists: matrixMediaExists };

export interface HtmlCase {
  id: string;
  html: string;
  accept: boolean;
}

function img(src: string, extra = ''): string {
  return `<img src="${src}" alt=""${extra}>`;
}

/** Все разрешённые и запрещённые формы img[src], img[srcset] и iframe[src]. */
export const SRC_SRCSET_CASES: HtmlCase[] = [
  { id: 'img-src-raster-webp', html: img(BASE), accept: true },
  { id: 'img-src-https-external', html: img('https://evil.test/x.webp'), accept: false },
  { id: 'img-src-http-external', html: img('http://evil.test/x.webp'), accept: false },
  { id: 'img-src-ftp', html: img('ftp://evil.test/x.webp'), accept: false },
  { id: 'img-src-javascript', html: img('javascript:alert(1)'), accept: false },
  { id: 'img-src-data', html: img('data:image/webp;base64,xx'), accept: false },
  { id: 'img-src-vbscript', html: img('vbscript:msg'), accept: false },
  { id: 'img-src-file', html: img('file:///etc/passwd'), accept: false },
  { id: 'img-src-protocol-relative', html: img('//evil.test/x.webp'), accept: false },
  { id: 'img-src-images', html: img('/images/foo.webp'), accept: false },
  { id: 'img-src-dotdot', html: img('../media/uploads/x.webp'), accept: false },
  { id: 'img-src-derivative-as-base', html: img(DERIV_480), accept: false },
  { id: 'img-src-missing', html: img(MISSING), accept: false },
  { id: 'img-src-pdf', html: img(PDF), accept: false },
  { id: 'img-src-gif', html: img('/media/uploads/x.gif'), accept: false },
  { id: 'img-src-svg', html: img('/media/legacy/hero-main.svg'), accept: false },
  { id: 'img-srcset-canonical-480w', html: img(BASE, ` srcset="${DERIV_480} 480w"`), accept: true },
  { id: 'img-srcset-descriptor-mismatch', html: img(BASE, ` srcset="${DERIV_480} 2400w"`), accept: false },
  { id: 'img-srcset-x-descriptor', html: img(BASE, ` srcset="${DERIV_480} 2x"`), accept: false },
  { id: 'img-srcset-missing-descriptor', html: img(BASE, ` srcset="${DERIV_480}"`), accept: false },
  { id: 'img-srcset-duplicate-url', html: img(BASE, ` srcset="${DERIV_480} 480w, ${DERIV_480} 480w"`), accept: false },
  { id: 'img-srcset-external', html: img(BASE, ' srcset="https://evil.test/x.webp 480w"'), accept: false },
  { id: 'img-srcset-protocol-relative', html: img(BASE, ' srcset="//evil.test/x.webp 480w"'), accept: false },
  { id: 'img-srcset-forbidden-scheme', html: img(BASE, ' srcset="javascript:alert(1) 480w"'), accept: false },
  { id: 'img-srcset-missing-derivative', html: img(BASE, ` srcset="${MISSING_DERIV} 480w"`), accept: false },
  { id: 'img-srcset-base-as-candidate', html: img(BASE, ` srcset="${BASE} 480w"`), accept: false },
  { id: 'img-srcset-empty', html: img(BASE, ' srcset=""'), accept: false },
  { id: 'iframe-src-rutube', html: exactRutubeIframe(), accept: true },
  { id: 'iframe-src-ftp', html: `<iframe src="ftp://evil.test" sandbox="${RUTUBE_IFRAME_ATTRS.sandbox}" allow="${RUTUBE_IFRAME_ATTRS.allow}" referrerpolicy="${RUTUBE_IFRAME_ATTRS.referrerpolicy}" loading="${RUTUBE_IFRAME_ATTRS.loading}" title="${RUTUBE_IFRAME_ATTRS.title}" allowfullscreen></iframe>`, accept: false },
  { id: 'iframe-src-https-other', html: `<iframe src="https://evil.test/embed" sandbox="${RUTUBE_IFRAME_ATTRS.sandbox}" allow="${RUTUBE_IFRAME_ATTRS.allow}" referrerpolicy="${RUTUBE_IFRAME_ATTRS.referrerpolicy}" loading="${RUTUBE_IFRAME_ATTRS.loading}" title="${RUTUBE_IFRAME_ATTRS.title}" allowfullscreen></iframe>`, accept: false },
  { id: 'iframe-src-query', html: `<iframe src="${EXACT_RUTUBE_SRC}?q=1" sandbox="${RUTUBE_IFRAME_ATTRS.sandbox}" allow="${RUTUBE_IFRAME_ATTRS.allow}" referrerpolicy="${RUTUBE_IFRAME_ATTRS.referrerpolicy}" loading="${RUTUBE_IFRAME_ATTRS.loading}" title="${RUTUBE_IFRAME_ATTRS.title}" allowfullscreen></iframe>`, accept: false },
];

export interface ProvenanceCase {
  tag: OccurrenceTag;
  html: string;
  sources: [string, string];
}

/** По одному crossed pair на каждый OCCURRENCE_TAGS. */
export const PROVENANCE_CASES: ProvenanceCase[] = [
  {
    tag: 'script',
    html: '<script>alpha()</script><script>beta()</script>',
    sources: ['script|body:from-output-0', 'script|body:from-output-1'],
  },
  {
    tag: 'style',
    html: '<style>a{}</style><style>b{}</style>',
    sources: ['style|body:from-output-0', 'style|body:from-output-1'],
  },
  {
    tag: 'iframe',
    html: '<iframe src="https://maps.example/a" title="Карта ИКПК"></iframe><iframe src="https://rutube.ru/play/embed/abc/" title="Видео RUTUBE"></iframe>',
    sources: [
      'iframe|src=expression:mapSrc|title=quoted:Карта ИКПК',
      'iframe|src=quoted:https://rutube.ru/play/embed/abc/|title=quoted:Видео RUTUBE',
    ],
  },
  {
    tag: 'object',
    html: '<object data="/a.pdf"></object><object data="/b.pdf"></object>',
    sources: ['object|data=quoted:/a.pdf', 'object|data=quoted:/b.pdf'],
  },
  {
    tag: 'embed',
    html: '<embed src="/a.swf"><embed src="/b.swf">',
    sources: ['embed|src=quoted:/a.swf', 'embed|src=quoted:/b.swf'],
  },
  {
    tag: 'frame',
    html: '<frame src="/a.html"></frame><frame src="/b.html"></frame>',
    sources: ['frame|src=quoted:/a.html', 'frame|src=quoted:/b.html'],
  },
  {
    tag: 'frameset',
    html: '<frameset cols="1,*"></frameset><frameset cols="2,*"></frameset>',
    sources: ['frameset|cols=quoted:1,*', 'frameset|cols=quoted:2,*'],
  },
  {
    tag: 'base',
    html: '<base href="/a"><base href="/b">',
    sources: ['base|href=quoted:/a', 'base|href=quoted:/b'],
  },
  {
    tag: 'link',
    html: '<link href="/a.css" rel="stylesheet"><link href="/b.css" rel="stylesheet">',
    sources: [
      'link|href=quoted:/a.css|rel=quoted:stylesheet',
      'link|href=quoted:/b.css|rel=quoted:stylesheet',
    ],
  },
  {
    tag: 'svg',
    html: '<svg fill="none" viewBox="0 0 12 12"></svg><svg fill="none" viewBox="0 0 24 24"></svg>',
    sources: [
      'svg|fill=quoted:none|viewBox=quoted:0 0 12 12',
      'svg|fill=quoted:none|viewBox=quoted:0 0 24 24',
    ],
  },
  {
    tag: 'math',
    html: '<math display="block"></math><math display="inline"></math>',
    sources: ['math|display=quoted:block', 'math|display=quoted:inline'],
  },
  {
    tag: 'template',
    html: '<template data-page="1"></template><template data-page="2"></template>',
    sources: ['template|data-page=quoted:1', 'template|data-page=quoted:2'],
  },
];

const RUTUBE = exactRutubeIframe();
const RUTUBE_FALSE_FS = RUTUBE.replace('allowfullscreen', 'allowfullscreen="false"');

/** Positive/negative value matrix всех ограниченных атрибутов, включая boolean и datetime. */
export const CONSTRAINED_VALUE_CASES: HtmlCase[] = [
  { id: 'dir-ltr', html: '<p dir="ltr">x</p>', accept: true },
  { id: 'dir-rtl', html: '<p dir="rtl">x</p>', accept: true },
  { id: 'dir-auto', html: '<p dir="auto">x</p>', accept: true },
  { id: 'dir-sideways', html: '<p dir="sideways">x</p>', accept: false },
  { id: 'dir-empty', html: '<p dir="">x</p>', accept: false },
  { id: 'lang-ru', html: '<p lang="ru">x</p>', accept: true },
  { id: 'lang-ru-RU', html: '<p lang="ru-RU">x</p>', accept: true },
  { id: 'lang-empty', html: '<p lang="">x</p>', accept: false },
  { id: 'lang-digit', html: '<p lang="1">x</p>', accept: false },
  { id: 'width-1200', html: img(BASE, ' width="1200"'), accept: true },
  { id: 'width-empty', html: img(BASE, ' width=""'), accept: false },
  { id: 'width-zero', html: img(BASE, ' width="0"'), accept: false },
  { id: 'width-negative', html: img(BASE, ' width="-1"'), accept: false },
  { id: 'height-empty', html: img(BASE, ' height=""'), accept: false },
  { id: 'colspan-2', html: '<td colspan="2">x</td>', accept: true },
  { id: 'colspan-empty', html: '<td colspan="">x</td>', accept: false },
  { id: 'loading-lazy', html: img(BASE, ' loading="lazy"'), accept: true },
  { id: 'loading-eager', html: img(BASE, ' loading="eager"'), accept: true },
  { id: 'loading-auto', html: img(BASE, ' loading="auto"'), accept: false },
  { id: 'decoding-async', html: img(BASE, ' decoding="async"'), accept: true },
  { id: 'decoding-bogus', html: img(BASE, ' decoding="fast"'), accept: false },
  { id: 'scope-row', html: '<th scope="row">x</th>', accept: true },
  { id: 'scope-bogus', html: '<th scope="table">x</th>', accept: false },
  { id: 'role-region-table-scroll', html: AUTHENTICATED_FORMS.tableWrapper, accept: true },
  { id: 'role-button', html: '<div role="button">x</div>', accept: false },
  { id: 'tabindex-on-p', html: '<p tabindex="0">x</p>', accept: false },
  { id: 'target-blank-with-rel', html: '<a href="/x" target="_blank" rel="noopener noreferrer">x</a>', accept: true },
  { id: 'target-blank-without-rel', html: '<a href="/x" target="_blank">x</a>', accept: false },
  { id: 'target-parent', html: '<a href="/x" target="_parent">x</a>', accept: false },
  { id: 'rel-opener', html: '<a href="/x" rel="opener">x</a>', accept: false },
  { id: 'datetime-year', html: '<time datetime="2023">x</time>', accept: true },
  { id: 'datetime-month', html: '<time datetime="2023-08">x</time>', accept: true },
  { id: 'datetime-date', html: '<time datetime="2020-01-15">x</time>', accept: true },
  { id: 'datetime-time', html: '<time datetime="14:30">x</time>', accept: true },
  { id: 'datetime-local', html: '<time datetime="2023-08-13T14:30">x</time>', accept: true },
  { id: 'datetime-yearless', html: '<time datetime="11-18">x</time>', accept: true },
  { id: 'datetime-week', html: '<time datetime="2023-W32">x</time>', accept: true },
  { id: 'datetime-impossible-day', html: '<time datetime="2023-02-31">x</time>', accept: false },
  { id: 'datetime-bad-month', html: '<time datetime="2023-13">x</time>', accept: false },
  { id: 'datetime-bad-time', html: '<time datetime="24:30">x</time>', accept: false },
  { id: 'datetime-empty', html: '<time datetime="">x</time>', accept: false },
  { id: 'datetime-garbage', html: '<time datetime="not-a-date">x</time>', accept: false },
  { id: 'bool-disabled-bare', html: '<input type="checkbox" disabled>', accept: true },
  { id: 'bool-disabled-empty', html: '<input type="checkbox" disabled="">', accept: true },
  { id: 'bool-disabled-named', html: '<input type="checkbox" disabled="disabled">', accept: true },
  { id: 'bool-disabled-true', html: '<input type="checkbox" disabled="true">', accept: true },
  { id: 'bool-disabled-false', html: '<input type="checkbox" disabled="false">', accept: false },
  { id: 'bool-disabled-missing', html: '<input type="checkbox">', accept: false },
  { id: 'bool-checked-bare', html: '<input type="checkbox" disabled checked>', accept: true },
  { id: 'bool-checked-false', html: '<input type="checkbox" disabled checked="false">', accept: false },
  { id: 'bool-open-bare', html: '<details open><summary>x</summary></details>', accept: true },
  { id: 'bool-open-false', html: '<details open="false"><summary>x</summary></details>', accept: false },
  { id: 'bool-allowfullscreen', html: RUTUBE, accept: true },
  { id: 'bool-allowfullscreen-false', html: RUTUBE_FALSE_FS, accept: false },
];
