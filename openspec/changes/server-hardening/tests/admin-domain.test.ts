/**
 * Перенесено из `web/tests/repo-hygiene.test.ts` PR #186 при сведении с `main` 05.10.2026.
 * Проверяют модель `ADMIN_DOMAIN` (отдельное имя и сертификат админки), которую не пережил
 * переписанный провижининг `server-provisioning`. Задача 8.4 этого change: переписать под
 * принятую модель и вернуть в `web/tests/`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..');

describe('админка: имя и сертификат (модель ADMIN_DOMAIN)', () => {
  // H4 (2026-08-24, PR #186): пустой ADMIN_DOMAIN валил весь bootstrap безусловным
  // exit ДО apt-get install — ломало provisioning хостов без админки (демо-стенд на
  // голом IP). Админка — опциональная надстройка, а не предусловие раздачи сайта.
  it('пустой ADMIN_DOMAIN не останавливает bootstrap сайта', () => {
    const code = readFileSync(join(ROOT, 'scripts', 'bootstrap-vps.sh'), 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    const missingDomainBlock = /if \[\[ -z "\$\{ADMIN_DOMAIN\}" \]\]; then([\s\S]*?)\nfi/.exec(code);
    expect(missingDomainBlock, 'ветка «ADMIN_DOMAIN не задан» не найдена').not.toBeNull();
    expect(
      /\bexit\b/.test(missingDomainBlock![1]),
      'пустой ADMIN_DOMAIN всё ещё завершает bootstrap — сайт без админки не развернётся',
    ).toBe(false);
    expect(/apt-get install/.test(code), 'базовый provisioning (apt-get install) отсутствует').toBe(
      true,
    );
  });

  // Обратная сторона H4: сертификат и vhost админки не должны выпускаться/писаться
  // без имени — `certbot --nginx -d ""` либо провалится, либо (хуже) молча привяжется
  // не к тому. Оба места проверены НЕЗАВИСИМО — F1 показал, что общей регулярки
  // недостаточно (guard вокруг heredoc'а вообще не проверялся под именем «vhost админки»).
  it('сертификат и vhost админки требуют ADMIN_DOMAIN', () => {
    const rawLines = readFileSync(join(ROOT, 'scripts', 'bootstrap-vps.sh'), 'utf-8').split('\n');
    const lines = rawLines.filter((line) => !line.trim().startsWith('#'));

    /** Строка находится строго внутри ОТКРЫТОГО `if [[ -n "${ADMIN_DOMAIN}" ]]; then ... fi`. */
    function isInsideAdminDomainGuard(targetLineIndex: number): boolean {
      const stack: boolean[] = [];
      for (let i = 0; i <= targetLineIndex; i++) {
        const line = lines[i].trim();
        if (i === targetLineIndex) break;
        if (/^if\s*\[\[.*\]\];\s*then$/.test(line)) {
          stack.push(/-n\s+"\$\{ADMIN_DOMAIN\}"/.test(line));
        } else if (line === 'fi') {
          stack.pop();
        }
      }
      return stack.some(Boolean);
    }

    const certbotLine = lines.findIndex((l) => l.includes('certbot --nginx -d "${ADMIN_DOMAIN}"'));
    expect(certbotLine, 'вызов certbot для админки не найден').toBeGreaterThanOrEqual(0);
    expect(
      isInsideAdminDomainGuard(certbotLine),
      'certbot для админки вызывается не внутри проверки на непустой ADMIN_DOMAIN',
    ).toBe(true);

    const adminHeredocLine = lines.findIndex((l) => /<<\s*NGINX_ADMIN\b/.test(l));
    expect(adminHeredocLine, 'heredoc NGINX_ADMIN (vhost админки) не найден').toBeGreaterThanOrEqual(0);
    expect(
      isInsideAdminDomainGuard(adminHeredocLine),
      'vhost админки (heredoc NGINX_ADMIN) пишется не внутри проверки на непустой ADMIN_DOMAIN — при пустом имени `server_name ;` провалит `nginx -t`',
    ).toBe(true);
  });
});
