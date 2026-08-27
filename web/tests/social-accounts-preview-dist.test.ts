/**
 * Состав внешних аккаунтов — АРТЕФАКТ РОЛИ `preview` (`web/dist-demo`).
 *
 * Тот же набор требований, что у роли `ci`, но предмет свой. Подать один вывод вместо двух
 * нельзя: тогда «в демо состав тот же» не проверено ничем, а выглядит проверенным
 * (`design.md`, Решение 4; принятая спека `deploy-gating`).
 *
 * ПОЧЕМУ ПРОВЕРКА БЫЛА КРАСНОЙ ДО РЕАЛИЗАЦИИ: та же причина, что у роли `ci` — шесть сетей
 * в источнике. После раздела 2 — четыре; заголовок — свидетельство, не текущее состояние.
 */

import { join } from 'node:path';
import { socialAccountsSuite } from './helpers/social-accounts-contract';

socialAccountsSuite({
  role: 'preview',
  root: join(import.meta.dirname, '..', 'dist-demo'),
  buildCommand: 'npm run build:demo',
});
