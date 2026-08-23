/**
 * Состав внешних аккаунтов — АРТЕФАКТ РОЛИ `stand` (`web/dist-stand`).
 *
 * Роль `stand` — это то, что выкладывается на публичный стенд и что смотрит заказчик;
 * парой «боевой и демо» она не покрыта вовсе (`design.md`, Решение 11). Принятая спека
 * `deploy-gating` перечисляет четыре роли и запрещает уточняющий признак рядом с ролью.
 *
 * ПОЧЕМУ КРАСНЫЙ СЕЙЧАС: та же причина, что у роли `ci` — в источнике состава шесть сетей.
 */

import { join } from 'node:path';
import { socialAccountsSuite } from './helpers/social-accounts-contract';

socialAccountsSuite({
  role: 'stand',
  root: join(import.meta.dirname, '..', 'dist-stand'),
  buildCommand: 'npm run build:stand',
});
