import { describe, expect, it } from 'vitest';
import { prepareArticleImages } from '../src/lib/article-images';

const coverUpload = '/media/uploads/1_1737469071674_46e3ee2eac.webp';
const legacyCover = '/media/users/1/images/1-1737469071674.webp';

function legacyCoverWrapper(src: string, alt = 'Изображение статьи') {
  return `<div class="articles-form_imageWrapper__abc"><div class="articles-form_articleImageSkeleton__def"><img alt="${alt}" width="558" height="675" src="${src}"></div></div>`;
}

describe('article image preparation', () => {
  it('removes only the first legacy cover alias from its known wrapper', () => {
    const body = [
      legacyCoverWrapper(legacyCover, 'Same title as any other image'),
      '<p>Text between images.</p>',
      '<figure><img src="/media/uploads/5bd04880-c895-45b7-a7ca-85539a4be7b1.webp" alt="Same title as any other image"></figure>',
      `<figure><img src="${legacyCover}" alt="A later repeat stays in place"></figure>`,
    ].join('');

    const prepared = prepareArticleImages(body, coverUpload);

    expect(prepared.bodyHtml).not.toContain('articles-form_imageWrapper__abc');
    expect(prepared.bodyHtml).toContain('Text between images.');
    expect(prepared.bodyHtml).toContain('5bd04880-c895-45b7-a7ca-85539a4be7b1.webp');
    expect(prepared.bodyHtml).toContain('A later repeat stays in place');
    expect(prepared.bodyHtml.match(/1-1737469071674\.webp/g)).toHaveLength(1);
  });

  it('keeps a classless image-only lookalike whose legacy provenance is unknown', () => {
    const body = `<div><div><img src="${legacyCover}" width="558" height="675"></div></div><p>Body starts here.</p>`;

    const prepared = prepareArticleImages(body, coverUpload);

    expect(prepared.bodyHtml).toBe(body);
    expect(prepared.coverDimensions).toEqual({ width: 1200, height: 675 });
  });

  it('returns the audited cover dimensions from the body asset manifest alias', () => {
    const prepared = prepareArticleImages(legacyCoverWrapper(legacyCover), coverUpload);

    expect(prepared.coverDimensions).toEqual({ width: 1200, height: 675 });
  });

  it('keeps an image with the cover id outside the legacy wrapper', () => {
    const body = `<p><img src="${legacyCover}" alt="Not the legacy cover wrapper"></p>`;

    expect(prepareArticleImages(body, coverUpload).bodyHtml).toContain(legacyCover);
  });

  it('keeps the same cover image when it appears after article text', () => {
    const body = `<p>Introductory text.</p>${legacyCoverWrapper(legacyCover)}`;

    expect(prepareArticleImages(body, coverUpload).bodyHtml).toContain(legacyCover);
  });

  it('keeps unknown URL namespaces even when their path resembles a legacy asset', () => {
    const external = `https://images.example.test${legacyCover}`;
    const body = legacyCoverWrapper(external);

    expect(prepareArticleImages(body, coverUpload).bodyHtml).toContain(external);
  });

  it('does not infer an alias from a matching historical id with a different upload hash', () => {
    const sameIdDifferentHash = '/media/uploads/1_1737469071674_deadbeef00.webp';
    const body = legacyCoverWrapper(legacyCover);

    expect(prepareArticleImages(body, sameIdDifferentHash).bodyHtml).toContain(legacyCover);
  });

  it('rejects protocol-relative foreign hosts before looking up media aliases', () => {
    const external = `//images.example.test${legacyCover}`;
    const body = legacyCoverWrapper(external);

    expect(prepareArticleImages(body, coverUpload).bodyHtml).toContain(external);
  });

  it('rejects foreign origins encoded with backslashes', () => {
    const backslash = String.fromCharCode(92);
    const externalUrls = [
      `${backslash}${backslash}images.example.test${legacyCover}`,
      `/${backslash}images.example.test${legacyCover}`,
    ];

    for (const external of externalUrls) {
      expect(prepareArticleImages(legacyCoverWrapper(external), coverUpload).bodyHtml).toContain(external);
    }
  });

  it('uses a body cover dimension alias for a cover whose upload URL is absent from the manifest', () => {
    const body = legacyCoverWrapper('/media/users/1/images/1-1737454910527.webp');

    expect(
      prepareArticleImages(body, '/media/uploads/1_1737454910527_80863751ad.webp').coverDimensions,
    ).toEqual({ width: 870, height: 489 });
  });
});
