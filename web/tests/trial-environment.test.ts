/**
 * Пробная машина (`deploy/environments/trial.env`, `docs/runbook-trial-vps.md`).
 *
 * Не production и не change с требованиями: проверяется только то, что разрешает пробе
 * оказаться опасной — формы в рабочую CRM, оплата, секреты в репозитории, база не той
 * системы. Провижининг идёт в одноразовом контейнере (заглушка systemctl, `ssh` исполняет
 * локально — ограничения те же, что у остальных контейнерных наборов `server-provisioning`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProvisionTarget, REPO_ROOT, ensureImage } from './helpers/provision-target';
import { contractSecrets } from './helpers/provision-contract';

const T = 240_000;
const ENVIRONMENT = 'trial';
const started: ProvisionTarget[] = [];
const ENV: Record<string, string> = { ENVIRONMENT, ...contractSecrets(ENVIRONMENT) };

function declared(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(join(REPO_ROOT, 'deploy/environments/trial.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) map.set(m[1], m[2].replace(/^"|"$/g, ''));
  }
  return map;
}

function target(): ProvisionTarget {
  const t = ProvisionTarget.start();
  started.push(t);
  return t;
}

function setDeclared(t: ProvisionTarget, key: string, value: string): void {
  t.execOrThrow(
    `f=/repo/deploy/environments/${ENVIRONMENT}.env; sed -i "/^${key}=/d" "$f"; ` +
      `printf '%s=%s\n' ${JSON.stringify(key)} ${JSON.stringify(value)} >> "$f"`,
  );
}

describe('trial: объявленное состояние пробной машины', () => {
  const d = declared();

  it('описывает Ubuntu 26.04, SQLite, заглушку форм и оплату ci', () => {
    expect(d.get('DISTRO')).toBe('ubuntu-26.04');
    expect(d.get('CMS_DB_CLIENT')).toBe('sqlite');
    expect(d.get('SITE_DEMO_FORMS')).toBe('stub');
    expect(d.get('SITE_PAYMENT_ROLE')).toBe('ci');
    expect(d.get('SITE_BUILD_WORKSPACE')).toBeTruthy();
    expect(d.get('SITE_VERIFY_URL')).toMatch(/^http:\/\/127\.0\.0\.1\//);
  });

  it('публикует панель по HTTP на службу loopback, всеми префиксами Strapi', () => {
    expect(d.get('SERVICE_PROXY_SNIPPET')).toBe('/etc/nginx/snippets/ikpk-cms-trial.conf');
    expect(d.get('SERVICE_PROXY_PREFIXES')).toBe('/admin,/content-manager,/upload,/i18n');
    expect(d.get('SERVICE_ADDR')).toMatch(/^127\.0\.0\.1:/);
  });

  it('называет секреты по именам и не содержит значений', () => {
    const names = (d.get('SECRET_NAMES') ?? '').split(',');
    for (const n of ['APP_KEYS', 'ENCRYPTION_KEY', 'ADMIN_JWT_SECRET', 'CONTENT_ADMIN_EMAIL', 'CONTENT_ADMIN_PASSWORD']) {
      expect(names, `нет секрета ${n}`).toContain(n);
    }
    for (const n of names) expect(d.has(n), `значение секрета ${n} лежит в репозитории`).toBe(false);
  });
});

describe('trial: провижининг в одноразовом контейнере', () => {
  beforeAll(() => {
    ensureImage();
  }, 600_000);
  afterEach(() => {
    while (started.length) started.pop()!.stop();
  });

  it('создаёт юнит с заглушкой форм, ролью оплаты ci и SQLite', () => {
    const t = target();
    const run = t.provision(ENV);
    expect(run.status, `провижининг упал:\n${run.output}`).toBe(0);
    const unit = t.read('/etc/systemd/system/ikpk-cms.service') ?? '';
    expect(unit).toContain('Environment=DEMO_FORMS=stub');
    expect(unit).toContain('Environment=PAYMENT_ROLE=ci');
    expect(unit).toContain('Environment=DATABASE_CLIENT=sqlite');
    expect(unit).toContain('Environment=DATABASE_FILENAME=/var/lib/ikpk-cms/trial/data/data.db');
  }, T);

  it('публикует панель CMS по HTTP всеми префиксами Strapi', () => {
    const t = target();
    const run = t.provision(ENV);
    expect(run.status, `провижининг упал:\n${run.output}`).toBe(0);
    const vhost = t.read('/etc/nginx/sites-available/ikpk.conf') ?? '';
    expect(vhost).toContain('include /etc/nginx/snippets/ikpk-cms-trial.conf;');
    const snippet = t.read('/etc/nginx/snippets/ikpk-cms-trial.conf') ?? '';
    for (const prefix of ['/admin', '/content-manager', '/upload', '/i18n']) {
      expect(snippet, prefix).toContain(`location ^~ ${prefix} {`);
    }
    expect(snippet).toContain('proxy_pass http://127.0.0.1:1337;');
  }, T);

  it('кладёт учётную запись администратора контента в файл секретов, а не в юнит', () => {
    const t = target();
    const run = t.provision(ENV);
    expect(run.status, `провижининг упал:\n${run.output}`).toBe(0);
    const secrets = t.read('/etc/ikpk-cms/trial.env') ?? '';
    expect(secrets).toContain('CONTENT_ADMIN_EMAIL=');
    const unit = t.read('/etc/systemd/system/ikpk-cms.service') ?? '';
    expect(unit).not.toContain('CONTENT_ADMIN_PASSWORD');
  }, T);

  it('без объявленной роли оплаты отказывается создавать юнит', () => {
    const t = target();
    setDeclared(t, 'SITE_PAYMENT_ROLE', '');
    const run = t.provision(ENV);
    expect(run.status, 'провижининг разрешил сборку без объявленной роли оплаты').not.toBe(0);
    expect(run.output).toContain('SITE_PAYMENT_ROLE');
  }, T);

  it('без режима заглушки форм юнит не создаётся и в рабочую CRM заявки не уйдут', () => {
    const t = target();
    setDeclared(t, 'SITE_DEMO_FORMS', '');
    const run = t.provision(ENV);
    const unit = t.read('/etc/systemd/system/ikpk-cms.service') ?? '';
    expect(unit, 'юнит без DEMO_FORMS=stub собирает ссылки на рабочую CRM').not.toMatch(/^Environment=IKPK_BUILD_WORKSPACE=/m);
    expect(run.status).not.toBe(0);
  }, T);
});
