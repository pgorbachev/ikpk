import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { createPublicationCheckPorts } from '../scripts/lib/publication-check-adapters';
import { adapterFixture } from './helpers/publication-adapter-fixtures';

const fixtures: Awaited<ReturnType<typeof adapterFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.clean(); });
async function fixture() { const f = await adapterFixture(); fixtures.push(f); return f; }
const observed = { status: 200, contentType: 'application/json; charset=utf-8', body: { status: 'ready', mode: 'test', shopId: 'shop-42' } };

describe('readiness adapter consumes only the protected worker remote observation', () => {
  it.each(['stand', 'prod'] as const)('%s probes once without operator readiness URL and preserves the response outside the artifact', async (role) => {
    const f = await fixture(); f.context.paymentRole = role; f.context.env.PAYMENT_ROLE = role;
    f.options.payment!.mode = role === 'prod' ? 'prod' : 'test';
    Reflect.deleteProperty(f.options.payment!, 'readinessUrl');
    const response = { ...observed, body: { ...observed.body, mode: f.options.payment!.mode } };
    const paymentReadiness = vi.fn(async () => response);
    const result = await createPublicationCheckPorts(f.options, { ...f.runtime, paymentReadiness }).checkPaymentReadiness(f.context);
    expect(result).toEqual({ conclusion: 'success', executedTests: 3 });
    expect(paymentReadiness).toHaveBeenCalledExactlyOnceWith();
    expect(f.commands).toHaveLength(1);
    const command = f.commands[0];
    expect(command.args).toContain('tests/publication/payment-readiness.test.ts');
    expect(command.env.PUBLICATION_PAYMENT_READY_URL).toBeUndefined();
    const file = command.env.PUBLICATION_PAYMENT_READY_RESPONSE_FILE!;
    expect(typeof file).toBe('string');
    expect(isAbsolute(file)).toBe(true);
    expect(relative(f.options.reportsDir, file)).not.toMatch(/^\.\./);
    expect(relative(f.context.treeDir, file)).toMatch(/^\.\./);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(response);
  });

  it('does not forward an unknown obsolete readinessUrl or ambient response file', async () => {
    const f = await fixture(); f.context.paymentRole = 'stand';
    const obsolete = 'https://operator.invalid/operator-secret-canary';
    Reflect.set(f.options.payment!, 'readinessUrl', obsolete);
    f.context.env.PUBLICATION_PAYMENT_READY_RESPONSE_FILE = '/operator/green.json';
    f.context.env.PUBLICATION_PAYMENT_READY_URL = obsolete;
    const paymentReadiness = vi.fn(async () => observed);
    await createPublicationCheckPorts(f.options, { ...f.runtime, paymentReadiness }).checkPaymentReadiness(f.context);
    expect(paymentReadiness).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.commands)).not.toContain('operator-secret-canary');
    expect(JSON.stringify(f.commands)).not.toContain('/operator/green.json');
  });

  it('missing trusted callback refuses even when an old operator URL and green report producer exist', async () => {
    const f = await fixture(); f.context.paymentRole = 'stand';
    const { run, startPreview } = f.runtime;
    await expect(createPublicationCheckPorts(f.options, { run, startPreview }).checkPaymentReadiness(f.context)).rejects.toThrow();
    expect(f.commands).toHaveLength(0);
  });

  it('probe failure refuses before starting assertion subprocesses without exposing transport errors', async () => {
    const f = await fixture(); f.context.paymentRole = 'stand';
    const paymentReadiness = vi.fn(async () => { throw new Error('remote-response-secret-canary'); });
    const error = await createPublicationCheckPorts(f.options, { ...f.runtime, paymentReadiness }).checkPaymentReadiness(f.context).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('remote-response-secret-canary');
    expect(paymentReadiness).toHaveBeenCalledTimes(1);
    expect(f.commands).toHaveLength(0);
  });

  it('oversized remote response is rejected before writing an assertion report or artifact', async () => {
    const f = await fixture(); f.context.paymentRole = 'stand';
    const paymentReadiness = vi.fn(async () => ({ ...observed, body: { ...observed.body, diagnostic: 'x'.repeat(1024 * 1024) } }));
    await expect(createPublicationCheckPorts(f.options, { ...f.runtime, paymentReadiness }).checkPaymentReadiness(f.context)).rejects.toThrow();
    expect(paymentReadiness).toHaveBeenCalledTimes(1); expect(f.commands).toHaveLength(0);
  });

  it('ci with production CRM never invokes readiness or forwards payment configuration', async () => {
    const f = await fixture(); f.context.deployMode = 'prod'; f.context.env.DEPLOY_MODE = 'prod';
    const paymentReadiness = vi.fn(async () => observed);
    const ports = createPublicationCheckPorts(f.options, { ...f.runtime, paymentReadiness });
    await ports.checkPaymentAbsent(f.context);
    await expect(async () => ports.checkPaymentReadiness(f.context)).rejects.toThrow();
    await expect(async () => ports.checkPaymentPreflight(f.context)).rejects.toThrow();
    expect(paymentReadiness).not.toHaveBeenCalled();
    expect(f.commands).toHaveLength(1);
    expect(Object.keys(f.commands[0].env).filter((key) => key.startsWith('PUBLICATION_PAYMENT_'))).toEqual([]);
  });
});
