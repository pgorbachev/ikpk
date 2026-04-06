import { describe, expect, it } from 'vitest';
import { getCourseGroups, getSeminars } from '../src/lib/data.js';
import { getCourseGroupPreviewImage } from '../src/lib/course-group-previews.js';

function getProgramCardPreview(courseGroupLegacyId: string): string {
  const courseGroup = getCourseGroups().find((item) => item.legacy_id === courseGroupLegacyId);
  if (!courseGroup) return '';
  return getCourseGroupPreviewImage(courseGroup, getSeminars(courseGroupLegacyId));
}

describe('Education media parity', () => {
  const instituteSlugs = [
    'institut-klinicheskoy-prikladnoy-kineziologii',
    'institut-apledzhera',
    'institut-barralya',
  ] as const;

  for (const instituteSlug of instituteSlugs) {
    it(`${instituteSlug} visible program cards have preview images`, () => {
      const visibleCourseGroups = getCourseGroups(instituteSlug).slice(0, 8);
      const missingPreviews = visibleCourseGroups
        .map((courseGroup) => ({
          slug: courseGroup.slug,
          preview: getProgramCardPreview(courseGroup.legacy_id),
        }))
        .filter((courseGroup) => !courseGroup.preview);

      expect(
        missingPreviews,
        `Institute landing page should not fall back to repeated emblem cards: ${missingPreviews.map((item) => item.slug).join(', ')}`,
      ).toEqual([]);
    });
  }
});
