/**
 * Красные тесты change `server-provisioning`: требование «Провижининг проверяет
 * достигнутое состояние по покрытию».
 *
 * Спека задаёт поведение проверки, но не её имя и не форму вывода. Имя
 * (`scripts/verify-server-state.sh`) и ключи вывода (`declared=`, `checked=`,
 * `manual=`, `unverifiable=`, `from=`) выбраны в тестах и перечислены в отчёте
 * как пробелы спеки, а не как её требования.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { ProvisionTarget, ensureImage } from './helpers/provision-target';
import {
  DEFAULT_ENVIRONMENT,
  EXIT,
  contractSecrets,
  VERIFY_SCRIPT,
  numberFromOutput,
  readDeclared,
  valueFromOutput,
} from './helpers/provision-contract';

const T = 240_000;
const started: ProvisionTarget[] = [];

beforeAll(() => {
  ensureImage();
}, 600_000);

afterEach(() => {
  while (started.length) started.pop()!.stop();
});

// Общее окружение НЕСЁТ обязательный секрет: спека требует безусловного отказа без него, и
// без секрета здесь фикстура требовала бы от одного и того же вызова одновременно упасть
// (сценарий «секрет отсутствует») и пройти (все остальные ~30). Ни одна реализация этого не
// может, и это дефект фикстуры, а не реализации — сценарий отсутствия ниже собирает своё
// окружение сам.
const ENV = { ENVIRONMENT: DEFAULT_ENVIRONMENT, ...contractSecrets(DEFAULT_ENVIRONMENT) };

function provisioned(): ProvisionTarget {
  const t = ProvisionTarget.start();
  started.push(t);
  const run = t.provision(ENV);
  expect(run.status, `подготовительный провижининг упал:\n${run.output}`).toBe(0);
  return t;
}

function setDeclared(t: ProvisionTarget, key: string, value: string): void {
  t.execOrThrow(
    `f=/repo/deploy/environments/${DEFAULT_ENVIRONMENT}.env; mkdir -p "$(dirname "$f")"; touch "$f"; ` +
      `sed -i "/^${key}=/d" "$f"; printf '%s=%s\\n' ${JSON.stringify(key)} ${JSON.stringify(value)} >> "$f"`,
  );
}

function verify(t: ProvisionTarget, host = 'target', env: Record<string, string> = {}) {
  const run = t.exec(`bash /repo/${VERIFY_SCRIPT} ${host}`, { SSH_KEY: '/dev/null', ...ENV, ...env });
  const numbers = {
    declared: numberFromOutput(run.output, 'declared'),
    checked: numberFromOutput(run.output, 'checked'),
    manual: numberFromOutput(run.output, 'manual'),
    unverifiable: numberFromOutput(run.output, 'unverifiable'),
  };
  return { ...run, numbers, from: valueFromOutput(run.output, 'from') };
}

describe('server-provisioning: проверка достигнутого состояния по покрытию', () => {
  it('Сценарий: состояние достигнуто', async () => {
    const t = provisioned();
    const res = verify(t);
    expect(res.status, `проверка на приведённом сервере не завершилась успехом:\n${res.output}`).toBe(EXIT.OK);
    const { declared, checked, manual, unverifiable } = res.numbers;
    expect(declared, 'число объявленных свойств не названо').toBeGreaterThan(0);
    expect(checked, 'число выполненных проверок не названо').not.toBeNull();
    expect(checked, 'ноль выполненных проверок — неуспех, а не успех').toBeGreaterThan(0);
    expect(unverifiable, 'третий класс непуст при успехе').toBe(0);
    expect(
      (checked ?? 0) + (manual ?? 0) + (unverifiable ?? 0),
      `равенство не выполняется: declared=${declared}, checked=${checked}, manual=${manual}, unverifiable=${unverifiable}`,
    ).toBe(declared);
  }, T);

  it('Сценарий: проверено меньше, чем объявлено', async () => {
    const t = provisioned();
    setDeclared(t, 'PROPERTY_EXTRA_UNCHECKED_CLASS', 'auto');
    const res = verify(t);
    expect(res.status, 'непокрытое свойство не привело к неуспеху').toBe(EXIT.MISMATCH);
    expect(res.numbers.declared, 'не названо число объявленных').not.toBeNull();
    expect(res.numbers.checked, 'не названо число выполненных').not.toBeNull();
    expect(res.numbers.unverifiable, 'не названо число непроверяемых').not.toBeNull();
    expect(res.output, 'свойство без проверки не названо').toContain('EXTRA_UNCHECKED');
  }, T);

  it('Сценарий: ручное свидетельство устарело', async () => {
    const t = provisioned();
    setDeclared(t, 'PROVISION_REVISION', 'rev-new');
    setDeclared(t, 'PROPERTY_MANUAL_STALE_CLASS', 'manual');
    setDeclared(t, 'PROPERTY_MANUAL_STALE_EVIDENCE', 'rev-old:docs/evidence/stale.txt');
    const res = verify(t);
    expect(res.status, 'устаревшее свидетельство принято за действительное').toBe(EXIT.MISMATCH);
    expect(res.output, 'свойство с устаревшим свидетельством не названо').toContain('MANUAL_STALE');
  }, T);

  it('Сценарий: непроверяемое свойство объявлено', async () => {
    const t = provisioned();
    setDeclared(t, 'PROPERTY_NEVER_CHECKED_CLASS', 'unverifiable');
    setDeclared(t, 'PROPERTY_NEVER_CHECKED_REASON', 'нужен настоящий домен');
    setDeclared(t, 'PROPERTY_NEVER_CHECKED_DEADLINE', '2026-12-31');
    const res = verify(t);
    expect(res.status, 'непустой третий класс не привёл к неуспеху').toBe(EXIT.MISMATCH);
    expect(res.output).toContain('NEVER_CHECKED');
    expect(res.output, 'причина не названа').toContain('нужен настоящий домен');
    expect(res.output, 'срок не назван').toContain('2026-12-31');
  }, T);

  it('Сценарий: одно из объявленных свойств не достигнуто', async () => {
    const t = provisioned();
    const before = verify(t);
    expect(before.status, 'исходное состояние не признано достигнутым — мутация ничего не измерит').toBe(EXIT.OK);
    t.execOrThrow('rm -f /var/www/ikpk/shared/nginx-redirects.conf');
    const res = verify(t);
    expect(res.status, 'снятое свойство не обнаружено').toBe(EXIT.MISMATCH);
    expect(res.output, 'несоответствующее свойство не названо').toMatch(/redirect/i);
  }, T);

  it('Сценарий: ни одна проверка не выполнилась', async () => {
    const t = provisioned();
    t.execOrThrow(
      `f=/repo/deploy/environments/${DEFAULT_ENVIRONMENT}.env; mkdir -p "$(dirname "$f")"; touch "$f"; ` +
        "sed -i '/^PROPERTY_/d' \"$f\"",
    );
    const res = verify(t);
    expect(res.status, 'ноль выполненных проверок выдан за успех').not.toBe(EXIT.OK);
    expect(res.numbers.checked, 'число выполненных проверок не названо').toBe(0);
  }, T);

  it('Сценарий: сервер недостижим', async () => {
    const t = provisioned();
    // 203.0.113.0/24 — TEST-NET-3, маршрута наружу нет по построению
    const res = verify(t, '203.0.113.1');
    expect(res.status, 'недостижимость сервера выдана за отсутствие несоответствий').toBe(EXIT.UNMEASURED);
  }, T);

  it('Сценарий: три исхода различимы', async () => {
    const t = provisioned();
    const ok = verify(t).status;
    t.execOrThrow('rm -f /var/www/ikpk/shared/nginx-redirects.conf');
    const mismatch = verify(t).status;
    const unmeasured = verify(t, '203.0.113.1').status;
    const codes = [ok, mismatch, unmeasured];
    expect(new Set(codes).size, `исходы неразличимы кодом выхода: ${codes.join(',')}`).toBe(3);
  }, T);

  it('Сценарий: место выполнения проверки названо', async () => {
    const t = provisioned();
    const declared = readDeclared(DEFAULT_ENVIRONMENT);
    const networkProperty = declared.get('NETWORK_CLOSEDNESS_PROPERTY');
    expect(networkProperty, 'свойство сетевой закрытости не объявлено — проверять нечего').toBeTruthy();
    const res = verify(t);
    expect(res.from, 'вывод не называет, с какой машины выполнена проверка').toBeTruthy();
    expect(
      res.output,
      'сетевая закрытость, проверенная с самого сервера, выдана за проверенную',
    ).toMatch(new RegExp(`${networkProperty}[^\\n]*(не проверен|not-verified|с сервера)`, 'i'));
  }, T);
});
