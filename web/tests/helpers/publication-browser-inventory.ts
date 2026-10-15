/** Fixed candidate inventory. No build, preview-reset, or pinned-content suites. */
export const candidateFiles = [
  'publication-smoke.spec.ts', 'publication-catalog.spec.ts',
  'publication-schedule.spec.ts', 'publication-content.spec.ts',
  'publication-widgets.spec.ts', 'footer-social.spec.ts',
  'external-widgets-baseline-repeat.spec.ts',
];
export const compatibilityProjects = [
  'compat-chrome-desktop', 'compat-firefox-desktop', 'compat-safari-desktop',
  'compat-ios-iphone-se', 'compat-ios-iphone-14', 'compat-ios-ipad', 'compat-android-chrome',
];
export const candidateProjects = ['desktop', 'mobile', 'footer-tablet', ...compatibilityProjects];

// Per-file completed test counts guard against silently dropping part of a suite.
const counts: Record<string, number> = {
  'publication-smoke.spec.ts': 4, 'publication-catalog.spec.ts': 3,
  'publication-schedule.spec.ts': 2, 'publication-content.spec.ts': 5,
  'publication-widgets.spec.ts': 2, 'footer-social.spec.ts': 10,
  'external-widgets-baseline-repeat.spec.ts': 1,
};
export const candidateInventory: Record<string, number> = Object.fromEntries([
  ...['desktop', 'mobile'].flatMap((project) => candidateFiles.map((file) => [`${file}@${project}`, counts[file]])),
  ['footer-social.spec.ts@footer-tablet', 10],
  ...compatibilityProjects.map((project) => [`compat.spec.ts@${project}`, 7]),
]);
export const rollbackInventory = { 'publication-smoke.spec.ts@desktop': 4, 'publication-smoke.spec.ts@mobile': 4 };
