/**
 * Environment for the deployed 193.124.115.99 review stand.
 *
 * This is deliberately separate from `DEMO_OUTPUT`: that flag suppresses third-party
 * embeds in a non-deployed artifact, while this stand must show the production review
 * and award embeds. Resolve from a copy so a caller cannot accidentally carry over a
 * production chat loader or non-stand payment/form mode.
 */
export const DEMO193_ORIGIN = 'https://193.124.115.99';

/** @param {NodeJS.ProcessEnv} [inherited] */
export function resolveDemo193Environment(inherited = process.env) {
  const env = { ...inherited };

  // Absence matters: `DEMO_OUTPUT=0` is still truthy in the embed guard.
  delete env.DEMO_OUTPUT;
  delete env.CHAT_LOADER_FALLBACK;

  Object.assign(env, {
    DEMO_PROFILE: 'demo193',
    DEPLOY_MODE: 'stand',
    PAYMENT_ROLE: 'ci',
    DEMO_FORMS: 'stub',
    CHAT_LOADER_SRC: 'none',
    CHAT_OFFLINE_MESSAGE: 'absent',
    DEMO_SITE_URL: DEMO193_ORIGIN,
  });

  return env;
}
