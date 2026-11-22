import { defaultTreeAdapter as T, parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { getAssetDimensions } from './media.js';

export interface PreparedArticleImages {
  bodyHtml: string;
  coverDimensions?: { width: number; height: number };
}

type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type ElementWithLocation = Element & {
  sourceCodeLocation?: { startOffset?: number; endOffset?: number };
};

const SITE_ORIGIN = 'https://ikpk.su';
const LEGACY_BUCKET_ORIGIN = 'https://storage.yandexcloud.net';
const LEGACY_BUCKET_ROOT = '/ikpk-image';

// Each pair was checked against the exact image URL stored in the source record
// and rendered on both production and 194. Unknown or changed media URLs stay visible.
const AUDITED_COVER_ALIASES = new Map<string, string>([
  ['/media/uploads/1_1734965993283_6fcbd360c1.webp', '/media/users/1/images/1-1734965993283.webp'],
  ['/media/uploads/1_1735030779910_1008e77255.webp', '/media/users/1/images/1-1735030779910.webp'],
  ['/media/uploads/1_1735034546967_9c8141a94a.webp', '/media/users/1/images/1-1735034546967.webp'],
  ['/media/uploads/1_1737359289383_3f655502ff.webp', '/media/users/1/images/1-1737359289383.webp'],
  ['/media/uploads/1_1737359718357_4aa387c1dd.webp', '/media/users/1/images/1-1737359718357.webp'],
  ['/media/uploads/1_1737360098096_70a4f8fac1.webp', '/media/users/1/images/1-1737360098096.webp'],
  ['/media/uploads/1_1737361699313_c6a4976419.webp', '/media/users/1/images/1-1737361699313.webp'],
  ['/media/uploads/1_1737363808104_051490afd6.webp', '/media/users/1/images/1-1737363808104.webp'],
  ['/media/uploads/1_1737364522013_5d51baf87d.webp', '/media/users/1/images/1-1737364522013.webp'],
  ['/media/uploads/1_1737365462432_07ccc73fc0.webp', '/media/users/1/images/1-1737365462432.webp'],
  ['/media/uploads/1_1737365686311_bbe68de0e0.webp', '/media/users/1/images/1-1737365686311.webp'],
  ['/media/uploads/1_1737366054033_3354144730.webp', '/media/users/1/images/1-1737366054033.webp'],
  ['/media/uploads/1_1737366550934_ad54da7182.webp', '/media/users/1/images/1-1737366550934.webp'],
  ['/media/uploads/1_1737367372739_71fb76cb9c.webp', '/media/users/1/images/1-1737367372739.webp'],
  ['/media/uploads/1_1737367690561_552b4f333b.webp', '/media/users/1/images/1-1737367690561.webp'],
  ['/media/uploads/1_1737369322672_3a131e2531.webp', '/media/users/1/images/1-1737369322672.webp'],
  ['/media/uploads/1_1737374547766_67484dec68.webp', '/media/users/1/images/1-1737374547766.webp'],
  ['/media/uploads/1_1737375210885_13a08e2ce1.webp', '/media/users/1/images/1-1737375210885.webp'],
  ['/media/uploads/1_1737376276557_dda33264a4.webp', '/media/users/1/images/1-1737376276557.webp'],
  ['/media/uploads/1_1737376875125_54b8a9f40a.webp', '/media/users/1/images/1-1737376875125.webp'],
  ['/media/uploads/1_1737378136501_331566efd6.webp', '/media/users/1/images/1-1737378136501.webp'],
  ['/media/uploads/1_1737378782771_3179015cd5.webp', '/media/users/1/images/1-1737378782771.webp'],
  ['/media/uploads/1_1737379633721_895c934cea.webp', '/media/users/1/images/1-1737379633721.webp'],
  ['/media/uploads/1_1737380132101_0573c4b247.webp', '/media/users/1/images/1-1737380132101.webp'],
  ['/media/uploads/1_1737380774701_a1f614b2f6.webp', '/media/users/1/images/1-1737380774701.webp'],
  ['/media/uploads/1_1737381040235_93b002b8c0.webp', '/media/users/1/images/1-1737381040235.webp'],
  ['/media/uploads/1_1737381448562_746577749c.webp', '/media/users/1/images/1-1737381448562.webp'],
  ['/media/uploads/1_1737381826712_a50c72a45f.webp', '/media/users/1/images/1-1737381826712.webp'],
  ['/media/uploads/1_1737382421793_3e172bde7c.webp', '/media/users/1/images/1-1737382421793.webp'],
  ['/media/uploads/1_1737382875054_e9ac13b104.webp', '/media/users/1/images/1-1737382875054.webp'],
  ['/media/uploads/1_1737383116711_bd2b5cf7c0.webp', '/media/users/1/images/1-1737383116711.webp'],
  ['/media/uploads/1_1737389300045_9ff73e455e.webp', '/media/users/1/images/1-1737389300045.webp'],
  ['/media/uploads/1_1737389887588_c8272fab83.webp', '/media/users/1/images/1-1737389887588.webp'],
  ['/media/uploads/1_1737390390867_0cfd0e53af.webp', '/media/users/1/images/1-1737390390867.webp'],
  ['/media/uploads/1_1737390793843_d69eddee8c.webp', '/media/users/1/images/1-1737390793843.webp'],
  ['/media/uploads/1_1737392379554_b8600ab0bb.webp', '/media/users/1/images/1-1737392379554.webp'],
  ['/media/uploads/1_1737394220731_a743b9c13f.webp', '/media/users/1/images/1-1737394220731.webp'],
  ['/media/uploads/1_1737394504899_efe8334664.webp', '/media/users/1/images/1-1737394504899.webp'],
  ['/media/uploads/1_1737395080877_88661cd59e.webp', '/media/users/1/images/1-1737395080877.webp'],
  ['/media/uploads/1_1737395514852_79c9121a9d.webp', '/media/users/1/images/1-1737395514852.webp'],
  ['/media/uploads/1_1737396453982_6952611c17.webp', '/media/users/1/images/1-1737396453982.webp'],
  ['/media/uploads/1_1737397097518_8aad2289ac.webp', '/media/users/1/images/1-1737397097518.webp'],
  ['/media/uploads/1_1737397567163_ed543d29f6.webp', '/media/users/1/images/1-1737397567163.webp'],
  ['/media/uploads/1_1737449033070_73a136ed24.webp', '/media/users/1/images/1-1737449033070.webp'],
  ['/media/uploads/1_1737449509341_a83b3d31f1.webp', '/media/users/1/images/1-1737449509341.webp'],
  ['/media/uploads/1_1737452221769_d746a55144.webp', '/media/users/1/images/1-1737452221769.webp'],
  ['/media/uploads/1_1737452856896_c59512aeaf.webp', '/media/users/1/images/1-1737452856896.webp'],
  ['/media/uploads/1_1737453688739_3d2cb83e4a.webp', '/media/users/1/images/1-1737453688739.webp'],
  ['/media/uploads/1_1737454087161_422f5a7edc.webp', '/media/users/1/images/1-1737454087161.webp'],
  ['/media/uploads/1_1737454910527_80863751ad.webp', '/media/users/1/images/1-1737454910527.webp'],
  ['/media/uploads/1_1737455731790_81c4e53983.webp', '/media/users/1/images/1-1737455731790.webp'],
  ['/media/uploads/1_1737456219380_2c92c148a1.webp', '/media/users/1/images/1-1737456219380.webp'],
  ['/media/uploads/1_1737456504355_49175f6f7a.webp', '/media/users/1/images/1-1737456504355.webp'],
  ['/media/uploads/1_1737456948878_6172cfc17d.webp', '/media/users/1/images/1-1737456948878.webp'],
  ['/media/uploads/1_1737457380965_5b89c74a02.webp', '/media/users/1/images/1-1737457380965.webp'],
  ['/media/uploads/1_1737458291993_60b66def3e.webp', '/media/users/1/images/1-1737458291993.webp'],
  ['/media/uploads/1_1737459613987_5f40c8b642.webp', '/media/users/1/images/1-1737459613987.webp'],
  ['/media/uploads/1_1737460430381_09e824ef61.webp', '/media/users/1/images/1-1737460430381.webp'],
  ['/media/uploads/1_1737461122960_2a8d5be84a.webp', '/media/users/1/images/1-1737461122960.webp'],
  ['/media/uploads/1_1737469071674_46e3ee2eac.webp', '/media/users/1/images/1-1737469071674.webp'],
  ['/media/uploads/1_1737469724904_2496f5f283.webp', '/media/users/1/images/1-1737469724904.webp'],
  ['/media/uploads/1_1737470585779_0f1caad3d8.webp', '/media/users/1/images/1-1737470585779.webp'],
  ['/media/uploads/1_1741872265498_1dccf12a54.webp', '/media/users/1/images/1-1741872265498.webp'],
  ['/media/uploads/1_1744006868845_2a1cd10159.webp', '/media/users/1/images/1-1744006868845.webp'],
  ['/media/uploads/1_1747131978731_297d0b6dc4.webp', '/media/users/1/images/1-1747131978731.webp'],
  ['/media/uploads/1_1747132786157_e1d2610ca0.webp', '/media/users/1/images/1-1747132786157.webp'],
  ['/media/uploads/1_1747133463477_9423f5d2ff.webp', '/media/users/1/images/1-1747133463477.webp'],
  ['/media/uploads/1_1747133911488_4bf0feb5c7.webp', '/media/users/1/images/1-1747133911488.webp'],
]);

function knownMediaPath(value: string): string | undefined {
  const raw = value.trim();
  if (!raw) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw, SITE_ORIGIN);
  } catch {
    return undefined;
  }

  if (parsed.origin !== SITE_ORIGIN && parsed.origin !== LEGACY_BUCKET_ORIGIN) {
    return undefined;
  }
  if (parsed.search || parsed.hash) return undefined;

  if (parsed.origin === LEGACY_BUCKET_ORIGIN) {
    if (!parsed.pathname.startsWith(`${LEGACY_BUCKET_ROOT}/`)) return undefined;
    return parsed.pathname.slice(LEGACY_BUCKET_ROOT.length);
  }
  return parsed.pathname.startsWith('/media/') ? parsed.pathname : undefined;
}

function sameMediaAsset(left: string, right: string): boolean {
  if (left.trim() === right.trim()) return true;
  const leftPath = knownMediaPath(left);
  const rightPath = knownMediaPath(right);
  if (!leftPath || !rightPath) return false;
  return leftPath === rightPath
    || AUDITED_COVER_ALIASES.get(leftPath) === rightPath
    || AUDITED_COVER_ALIASES.get(rightPath) === leftPath;
}

function firstImage(
  node: ParentNode,
  ancestors: Element[] = [],
): { image: Element; ancestors: Element[] } | undefined {
  for (const child of T.getChildNodes(node)) {
    if (!T.isElementNode(child)) continue;
    const element = child as Element;
    if (T.getTagName(element) === 'img') return { image: element, ancestors };
    const found = firstImage(element, [...ancestors, element]);
    if (found) return found;
  }
  return undefined;
}

function onlyContains(parent: Element, child: Element): boolean {
  return T.getChildNodes(parent).every((node) => {
    if (node === child) return true;
    if (node.nodeName === '#comment') return true;
    return node.nodeName === '#text' && !('value' in node && node.value.trim());
  });
}

function hasClassPrefix(element: Element, prefix: string): boolean {
  const value = T.getAttrList(element).find((attr) => attr.name === 'class')?.value ?? '';
  return value.split(/\s+/).some((token) => token.startsWith(prefix));
}

function onlyWhitespaceBefore(parent: ParentNode, child: Element): boolean {
  for (const node of T.getChildNodes(parent)) {
    if (node === child) return true;
    if (node.nodeName === '#comment') continue;
    if (node.nodeName === '#text' && 'value' in node && !node.value.trim()) continue;
    return false;
  }
  return false;
}

function legacyWrapper(tree: ParentNode, image: Element, ancestors: Element[]): ElementWithLocation | undefined {
  let parent = tree;
  for (const ancestor of ancestors) {
    const tag = T.getTagName(ancestor);
    if ((tag !== 'div' && tag !== 'article') || !onlyWhitespaceBefore(parent, ancestor)) return undefined;
    parent = ancestor;
  }

  const inner = ancestors.at(-1);
  const outer = ancestors.at(-2);
  if (!inner || !outer || T.getTagName(inner) !== 'div' || T.getTagName(outer) !== 'div') return undefined;
  if (!hasClassPrefix(inner, 'articles-form_articleImageSkeleton__')) return undefined;
  if (!hasClassPrefix(outer, 'articles-form_imageWrapper__')) return undefined;

  // These exact legacy class prefixes are present on the audited source cover
  // wrapper. They disappear after sanitization, so classless lookalikes remain.
  if (!onlyContains(inner, image) || !onlyContains(outer, inner)) return undefined;
  return outer as ElementWithLocation;
}

function coverDimensions(coverImage: string, bodyCoverPath?: string): { width: number; height: number } | undefined {
  const coverPath = knownMediaPath(coverImage);
  return (coverPath && getAssetDimensions(coverPath))
    || (bodyCoverPath && getAssetDimensions(bodyCoverPath))
    || undefined;
}

export function prepareArticleImages(bodyHtml: string, coverImage: string | null): PreparedArticleImages {
  if (!coverImage) return { bodyHtml };

  const tree = parseFragment(bodyHtml, { sourceCodeLocationInfo: true });
  const candidate = firstImage(tree);
  if (!candidate) return { bodyHtml, coverDimensions: coverDimensions(coverImage) };

  const src = T.getAttrList(candidate.image).find((attr) => attr.name === 'src')?.value;
  const candidatePath = src ? knownMediaPath(src) : undefined;
  const dimensions = sameMediaAsset(coverImage, src ?? '')
    ? coverDimensions(coverImage, candidatePath)
    : coverDimensions(coverImage);
  const wrapper = src && sameMediaAsset(coverImage, src)
    ? legacyWrapper(tree, candidate.image, candidate.ancestors)
    : undefined;
  const location = wrapper?.sourceCodeLocation;
  if (!location || typeof location.startOffset !== 'number' || typeof location.endOffset !== 'number') {
    return { bodyHtml, coverDimensions: dimensions };
  }

  return {
    bodyHtml: `${bodyHtml.slice(0, location.startOffset)}${bodyHtml.slice(location.endOffset)}`,
    coverDimensions: dimensions,
  };
}
