/**
 * Environment for the deployed 194.226.99.10 review stand.
 *
 * This is deliberately separate from `DEMO_OUTPUT`: that flag suppresses third-party
 * embeds in a non-deployed artifact, while this stand must show the production review
 * and award embeds. Resolve from a copy so a caller cannot accidentally carry over a
 * production chat loader or non-stand payment/form mode.
 */
export const DEMO193_ORIGIN = 'https://194.226.99.10';
export const STAGING194_STATIC_MAIN_CHAT_LOADER_SRC =
  'https://cdn-ru.bitrix24.ru/b35315886/crm/site_button/loader_2_siutnh.js';

/** @param {NodeJS.ProcessEnv} [inherited] */
export function resolveDemo193Environment(inherited = process.env) {
  const env = { ...inherited };
  const staging194StaticMain = inherited.CHAT_LOADER_PROFILE === 'staging194-static-main';
  if (inherited.CHAT_LOADER_PROFILE && !staging194StaticMain) {
    throw new Error('CHAT_LOADER_PROFILE must be the approved staging194 static-main profile');
  }
  if (staging194StaticMain && inherited.CHAT_LOADER_SRC !== STAGING194_STATIC_MAIN_CHAT_LOADER_SRC) {
    throw new Error('staging194 static-main requires the owner-approved chat loader');
  }

  // Absence matters: `DEMO_OUTPUT=0` is still truthy in the embed guard.
  delete env.DEMO_OUTPUT;
  delete env.CHAT_LOADER_FALLBACK;

  Object.assign(env, {
    DEMO_PROFILE: 'demo193',
    DEPLOY_MODE: 'stand',
    PAYMENT_ROLE: 'ci',
    DEMO_FORMS: 'stub',
    CHAT_LOADER_SRC: staging194StaticMain ? STAGING194_STATIC_MAIN_CHAT_LOADER_SRC : 'none',
    CHAT_OFFLINE_MESSAGE: 'absent',
    DEMO_SITE_URL: DEMO193_ORIGIN,
  });

  if (staging194StaticMain) env.CHAT_LOADER_PROFILE = 'staging194-static-main';
  else delete env.CHAT_LOADER_PROFILE;

  return env;
}
