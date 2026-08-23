const HOLD_KEY = 'ikpk-payment-holds';
const FIELDS_KEY = 'ikpk-payment-fields';
const RETURN_PARAM = 'paymentRequest';
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const POST_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 15_000;
const MAX_HOLDS = 5;

type Hold = { requestId: string; createdAt: number };
type FieldMap = Record<string, string | boolean>;
type ApiBody = {
  status?: string;
  confirmationUrl?: string;
  requestId?: string;
  confirmationToken?: string;
};

/**
 * Человеческое название состояния попытки для перечня удержаний: спека требует состояние
 * «названное человеческим языком, а не техническим именем статуса». Машинное имя остаётся
 * атрибутом `data-payment-attempt-status` — по нему состояние читают проверки. Неизвестное
 * состояние получает нейтральную формулировку, а НЕ своё сырое имя: иначе перечень чужих
 * статусов отставал бы молча, и незнакомый статус утёк бы в интерфейс техническим словом.
 */
function attemptStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Ожидается оплата';
    case 'succeeded':
      return 'Оплата подтверждена';
    case 'canceled':
      return 'Оплата отменена';
    case 'verification_required':
      return 'Статус пока не определён';
    case 'duplicate_confirmation_required':
      return 'Нужно подтверждение';
    case 'demo':
      return 'Демонстрационный режим';
    default:
      return 'Состояние уточняется';
  }
}

/** Время создания попытки в читаемом виде; машинное значение остаётся в атрибуте `datetime`. */
function attemptTimeLabel(createdAt: number): string {
  return new Date(createdAt).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * `crypto.randomUUID()` — часть Web Crypto API, доступная только в secure context (`https:`
 * либо loopback `localhost`/`127.0.0.1`); на любом другом `http:` origin браузер отдаёт для
 * него `undefined`. Стенд обслуживается по HTTP без TLS намеренно (design.md, Решение 1,
 * решение владельца от 2026-08-13), поэтому без резервного пути КАЖДАЯ отправка формы на
 * стенде падала бы в состояние `unknown` синхронным `TypeError` до единого сетевого запроса —
 * найдено живой приёмкой 2026-08-20, не поймано ни одним из существующих тестов, потому что
 * они выполняются на `127.0.0.1` (secure context по исключению для loopback).
 * `crypto.getRandomValues()` секьюрность контекста не требует — это резервный путь: те же 122
 * бита случайности, версия и вариант ставятся вручную по RFC 4122.
 */
function generateRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return [hex.slice(0, 4).join(''), hex.slice(4, 6).join(''), hex.slice(6, 8).join(''), hex.slice(8, 10).join(''), hex.slice(10, 16).join('')].join('-');
}

const form = document.querySelector<HTMLFormElement>('[data-payment-form]');
if (form) boot(form);

function boot(formEl: HTMLFormElement) {
  const endpoint = formEl.getAttribute('data-payment-endpoint') ?? '';
  // Признак прежней матрицы (`data-payment-demo`) удалён решением владельца 2026-08-18;
  // роль сборки объявляется `data-payment-role` на корневом элементе диалога (задача
  // 5.10a). У роли `preview` удержание не создаётся (design.md, Решение 13, таблица
  // «семантика по ролям»); `stand`/`prod` работают как прежний «не демо».
  const isDemoBuild = document.getElementById('payment-dialog-root')?.getAttribute('data-payment-role') === 'preview';
  const root = document.getElementById('payment-dialog-root')!;
  const dialog = document.querySelector<HTMLElement>('.payment-dialog')!;
  const stateHost = document.querySelector<HTMLElement>('[data-payment-state-host]')!;
  const chrome = document.querySelector<HTMLElement>('[data-payment-chrome]')!;
  const attemptsWrap = document.querySelector<HTMLElement>('[data-payment-attempts]')!;
  const attemptList = document.querySelector<HTMLElement>('[data-payment-attempt-list]')!;
  const actions = document.querySelector<HTMLElement>('[data-payment-actions]')!;
  const closeBtn = document.querySelector<HTMLButtonElement>('[data-payment-close]');
  const panel = document.querySelector<HTMLElement>('.payment-dialog-panel')!;
  if (!root || !dialog || !stateHost || !chrome || !attemptsWrap || !attemptList || !actions || !panel) return;

  const fieldsTemplate = formEl.cloneNode(true) as HTMLFormElement;
  let activeRequestId = '';
  let pendingToken = '';
  let lastOpener: HTMLElement | null = null;
  let inFlight = false;
  let inertObserver: MutationObserver | null = null;
  const holdStatuses = new Map<string, ApiBody>();

  enhanceEntry();
  void restoreOnLoad().finally(() => setEntryReady(true));

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    void onSubmit();
  });
  closeBtn?.addEventListener('click', () => closeDialog());
  // Поворот телефона, поднятая экранная клавиатура и изменение масштаба меняют и высоту
  // панели, и высоту футера — решение «места нет» надо пересчитывать, а не брать однажды
  // при открытии.
  //
  // Подписок ДВЕ, и вторая не для симметрии. iOS Safari при поднятой экранной клавиатуре
  // размер окна НЕ меняет и события `resize` на `window` не даёт вовсе — меняется только
  // visual viewport. А экранная клавиатура названа прямо в дефекте, из-за которого весь
  // этот пересчёт и появился, то есть без второй подписки починка не работала бы ровно в
  // одном из перечисленных в дефекте случаев. Android Chrome, наоборот, меняет само окно.
  //
  // Оговорка про доказательство: сама платформа здесь не проверяется — iOS Safari в наборах
  // нет, есть только Chromium. Автоматический гейт стережёт ПРОВОДКУ (событие visual
  // viewport пересчитывает полосу), а не поведение iOS; поведение проверяется на стенде
  // руками.
  //
  // Пересчёт склеен через `requestAnimationFrame`: обработчик читает `clientHeight` и
  // `offsetHeight` каждого поля, то есть форсирует синхронную раскладку. На повороте
  // телефона это одно событие, а на протяжке окна мышью — поток событий, и без склейки
  // раскладка считалась бы на каждом.
  let bandPending = false;
  const recomputeFooterBand = () => {
    if (dialog.hidden || bandPending) return;
    bandPending = true;
    requestAnimationFrame(() => {
      bandPending = false;
      if (!dialog.hidden) syncFooterBand();
    });
  };
  window.addEventListener('resize', recomputeFooterBand);
  window.visualViewport?.addEventListener('resize', recomputeFooterBand);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dialog.hidden) {
      event.preventDefault();
      closeDialog();
    }
  });

  function enhanceEntry() {
    const legacy = [...document.querySelectorAll<HTMLAnchorElement>('[data-legacy-cta]')].find((el) =>
      /оплат/i.test(el.textContent ?? ''),
    );
    if (!legacy) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = legacy.className;
    button.textContent = legacy.textContent;
    button.setAttribute('data-payment-entry', '');
    const pending =
      Boolean(new URL(window.location.href).searchParams.get(RETURN_PARAM)) || readHolds().length > 0;
    if (pending) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }
    legacy.replaceWith(button);
    button.addEventListener('click', () => openDialog(button));
  }

  function setEntryReady(ready: boolean) {
    const button = document.querySelector<HTMLButtonElement>('[data-payment-entry]');
    if (!button) return;
    button.disabled = !ready;
    if (ready) button.removeAttribute('aria-busy');
    else button.setAttribute('aria-busy', 'true');
  }

  function openDialog(opener?: HTMLElement) {
    lastOpener = opener ?? lastOpener;
    root.hidden = false;
    dialog.hidden = false;
    formEl.hidden = !formEl.querySelector('[name="firstName"]') ? formEl.hidden : false;
    setBackgroundInert(true);
    // До первой валидации ошибок нет, но путь Tab между полями работает уже сейчас, и
    // полоса футера должна быть известна браузеру с самого открытия.
    syncFooterBand();
    const focusable = dialog.querySelector<HTMLElement>('input, button, [href], textarea, select');
    focusable?.focus();
  }

  function closeDialog() {
    dialog.hidden = true;
    root.hidden = true;
    setBackgroundInert(false);
    lastOpener?.focus();
  }

  function setBackgroundInert(on: boolean) {
    applyBackgroundInert(on);
    if (on) {
      inertObserver ??= new MutationObserver(() => applyBackgroundInert(true));
      inertObserver.observe(document.body, { childList: true });
      return;
    }
    inertObserver?.disconnect();
    inertObserver = null;
  }

  function applyBackgroundInert(on: boolean) {
    for (const node of [...document.body.children]) {
      if (node.contains(dialog) || node === dialog) continue;
      if (on) node.setAttribute('inert', '');
      else node.removeAttribute('inert');
    }
  }

  function readHolds(): Hold[] {
    try {
      const raw = JSON.parse(localStorage.getItem(HOLD_KEY) ?? '[]') as Hold[];
      const now = Date.now();
      const live = raw.filter((h) => now - h.createdAt <= TTL_MS);
      if (live.length !== raw.length && live.length <= MAX_HOLDS) writeHolds(live);
      return live;
    } catch {
      return [];
    }
  }

  function writeHolds(holds: Hold[]) {
    if (holds.length > MAX_HOLDS) {
      throw new Error(`cannot store more than ${MAX_HOLDS} payment holds`);
    }
    localStorage.setItem(HOLD_KEY, JSON.stringify(holds));
  }

  function readFields(): Record<string, FieldMap> {
    try {
      return JSON.parse(sessionStorage.getItem(FIELDS_KEY) ?? '{}') as Record<string, FieldMap>;
    } catch {
      return {};
    }
  }

  function writeFields(all: Record<string, FieldMap>) {
    sessionStorage.setItem(FIELDS_KEY, JSON.stringify(all));
  }

  function upsertHold(requestId: string): boolean {
    if (isDemoBuild) return true;
    const holds = readHolds().filter((h) => h.requestId !== requestId);
    if (holds.length >= MAX_HOLDS) return false;
    holds.push({ requestId, createdAt: Date.now() });
    writeHolds(holds);
    return true;
  }

  function dropHold(requestId: string, opts: { keepFields?: boolean } = {}) {
    holdStatuses.delete(requestId);
    writeHolds(readHolds().filter((h) => h.requestId !== requestId));
    if (opts.keepFields) return;
    const all = readFields();
    delete all[requestId];
    writeFields(all);
  }

  function collectFields(): FieldMap {
    const data: FieldMap = {};
    for (const el of formEl.querySelectorAll<HTMLInputElement>('input')) {
      if (el.name === 'website' || !el.name) continue;
      data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return data;
  }

  function restoreFieldsDom() {
    if (!formEl.querySelector('[name="firstName"]')) {
      formEl.replaceChildren(...[...fieldsTemplate.childNodes].map((node) => node.cloneNode(true)));
    }
    formEl.hidden = false;
    // Пересчёта полосы футера здесь СОЗНАТЕЛЬНО НЕТ, и это результат измерения, а не
    // упущение. Ревью предложило пересчитывать «после любой перерисовки формы», и первая
    // редакция так и делала — но мутация показала, что ни одна проверка от снятия этого
    // вызова не краснеет, то есть он был непроверяемым кодом. Причина в том, что
    // достижимого сценария нет: восстановленная форма несёт футер БЕЗ ошибок, а ровно эту
    // геометрию уже посчитала валидация (`validate` пересчитывает безусловно), открытие
    // окна и обработчик resize. Держать защиту, для которой не удалось построить путь,
    // значит держать код, про который никто не узнает, когда он сломается. Если путь
    // назовут — вызов вернётся вместе с тестом на него.
  }

  function stripFieldsDom() {
    formEl.replaceChildren();
    formEl.hidden = true;
  }

  function applyFields(data: FieldMap) {
    restoreFieldsDom();
    for (const [name, value] of Object.entries(data)) {
      const el = formEl.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(value);
      else el.value = String(value);
    }
  }

  function setChrome(opts: {
    warning?: boolean;
    summary?: string;
    continue?: boolean;
    other?: boolean;
    confirm?: boolean;
  }) {
    chrome.replaceChildren();
    actions.replaceChildren();
    if (opts.warning) {
      const box = document.createElement('div');
      box.setAttribute('data-payment-hold-warning', '');
      box.textContent =
        'Платёж мог быть создан, повторять оплату не нужно. Продолжите эту попытку или свяжитесь с нами.';
      chrome.append(box);
    }
    if (opts.summary) {
      const box = document.createElement('div');
      box.setAttribute('data-payment-summary', '');
      box.textContent = opts.summary;
      chrome.append(box);
    }
    if (opts.continue) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-payment-continue', '');
      btn.textContent = 'Продолжить эту оплату';
      btn.addEventListener('click', () => {
        const stored = readFields()[activeRequestId];
        if (stored) applyFields(stored);
        else restoreFieldsDom();
        setChrome({ other: true, warning: true });
      });
      actions.append(btn);
    }
    if (opts.confirm) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-payment-confirm-duplicate', '');
      btn.textContent = 'Создать ещё один платёж';
      btn.addEventListener('click', () => void onSubmit({ confirmDuplicate: true }));
      actions.append(btn);
    }
    const other = document.createElement('button');
    other.type = 'button';
    other.setAttribute('data-payment-other-seminar', '');
    other.textContent = 'Оплатить другой семинар';
    other.hidden = !opts.other || readHolds().length >= MAX_HOLDS;
    other.addEventListener('click', () => startOtherSeminar());
    actions.append(other);
    renderAttempts();
  }

  function renderAttempts() {
    const holds = readHolds();
    attemptsWrap.hidden = holds.length < 2;
    attemptList.replaceChildren();
    holds.forEach((h, index) => {
      const li = document.createElement('li');
      li.setAttribute('data-payment-attempt', '');
      // Идентификатор остаётся МАШИННЫМ признаком: он не виден и не копируется действием
      // интерфейса, но по нему попытка выбирается и читается проверками.
      li.setAttribute('data-payment-attempt-id', h.requestId);
      const status = holdStatuses.get(h.requestId)?.status;
      if (status) li.setAttribute('data-payment-attempt-status', status);

      // Подпись — порядковый номер, а не `requestId`: посетителю UUID ничего не даёт, а
      // сотрудник по нему платёж всё равно не найдёт (наблюдение в панели ЮKassa, 2.2a).
      const select = document.createElement('button');
      select.type = 'button';
      select.setAttribute('data-payment-attempt-select', '');
      select.textContent = `Попытка ${index + 1}`;
      select.addEventListener('click', () => {
        const json = holdStatuses.get(h.requestId) ?? { status: 'unknown' };
        applyStatus(h.requestId, json);
      });

      const time = document.createElement('time');
      time.dateTime = new Date(h.createdAt).toISOString();
      time.textContent = attemptTimeLabel(h.createdAt);
      li.append(select, time);

      // Семинар и сумма — только из хранилища ТЕКУЩЕЙ сессии. Постоянное хранилище держит
      // лишь `requestId` и время создания, и расширять его ради подписи нельзя: это
      // принятая граница приватности, а не деталь реализации.
      const stored = readFields()[h.requestId];
      const seminar = typeof stored?.seminar === 'string' ? stored.seminar.trim() : '';
      const amount = stored?.amount === undefined ? '' : String(stored.amount).trim();
      if (seminar || amount) {
        const summary = document.createElement('span');
        summary.setAttribute('data-payment-attempt-summary', '');
        summary.textContent = [seminar, amount && `${amount} ₽`].filter(Boolean).join(' · ');
        li.append(summary);
      }

      if (status) {
        const label = document.createElement('span');
        label.setAttribute('data-payment-attempt-status-label', '');
        label.textContent = attemptStatusLabel(status);
        li.append(label);
      }
      attemptList.append(li);
    });
  }

  function setState(name: string, text: string) {
    const box = document.createElement('div');
    box.setAttribute('data-payment-state', name);
    box.setAttribute('role', 'status');
    box.textContent = text;
    stateHost.replaceChildren(box);
  }

  // ── Липкий футер не должен закрывать поле, к которому уводится фокус ────────
  //
  // Браузер прокручивает элемент «в видимую область» и про липкий слой поверх неё не
  // знает: поле формально внутри scrollport, поэтому прокрутки не происходит вовсе.
  // Измерено на артефакте роли `stand`, ширина 390: при высоте окна 900 сфокусированное
  // `amount` лежало под футером при scrollTop = 0, при 400 под футером оказывались и
  // поле, и его сообщение.
  //
  // Три средства, потому что закрываются три разных случая, и ни одно из них не
  // покрывает остальные (проверено измерением каждого по отдельности):
  //
  //   `scroll-padding-bottom` — путь БРАУЗЕРА (Tab между полями): он сам перестаёт
  //       считать полосу футера видимой областью. Только этого мало: при высоте окна
  //       500 браузер уводил в видимую область сам `input`, а сообщение об ошибке лежит
  //       НИЖЕ него и снова попадало под футер;
  //   явная прокрутка БЛОКА поля (`.payment-field` целиком — подпись, поле, сообщение) —
  //       путь валидации;
  //   снятие прилипания, когда места нет физически — при высоте окна 360 футер занимает
  //       237 из 328 доступных, и никакая прокрутка не покажет блок поля высотой 102.
  //       Без этой ветви гарантия «поле и сообщение видимы» была бы невыполнима, а тест
  //       на неё — заведомо красным на низких окнах.
  function tallestFieldHeight(): number {
    const fields = [...formEl.querySelectorAll<HTMLElement>('.payment-field')];
    return fields.reduce((max, el) => Math.max(max, el.offsetHeight), 0);
  }

  /** Синхронизирует полосу, закрытую футером, и решает, можно ли его вообще прилеплять. */
  function syncFooterBand(): HTMLElement | null {
    const footer = formEl.querySelector<HTMLElement>('.payment-footer');
    if (!footer) {
      panel.classList.remove('payment-panel-cramped');
      panel.style.removeProperty('--payment-footer-height');
      return null;
    }
    // Мерить надо на неприлепленном футере: у прилепленного `offsetHeight` тот же, а
    // вот решение «места нет» должно приниматься по той же величине в обе стороны,
    // иначе состояние начнёт колебаться между двумя решениями на одной геометрии.
    const cramped = panel.clientHeight - footer.offsetHeight < tallestFieldHeight();
    panel.classList.toggle('payment-panel-cramped', cramped);
    panel.style.setProperty('--payment-footer-height', cramped ? '0px' : `${footer.offsetHeight}px`);
    return footer;
  }

  /** Показывает блок поля целиком — вместе с подписью и сообщением об ошибке. */
  function revealField(el: HTMLElement) {
    const footer = syncFooterBand();
    // Согласие живёт в самом футере: закрыть себя футер не может, а прокрутка к нему
    // сдвинула бы панель без причины.
    if (footer?.contains(el)) return;
    const field = (el.closest('.payment-field') ?? el) as HTMLElement;
    field.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function clearErrors() {
    for (const err of formEl.querySelectorAll<HTMLElement>('.payment-error')) {
      err.hidden = true;
      err.textContent = '';
    }
    for (const el of formEl.querySelectorAll<HTMLInputElement>('input')) {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-describedby');
    }
  }

  function showFieldError(name: string, message: string) {
    const input = formEl.querySelector<HTMLInputElement>(`[name="${name}"]`);
    const err = document.getElementById(`payment-err-${name}`);
    if (!input || !err) return;
    err.textContent = message;
    err.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', err.id);
  }

  function validate(): boolean {
    clearErrors();
    const honeypot = formEl.querySelector<HTMLInputElement>('[name="website"]');
    if (honeypot && honeypot.value.trim()) {
      setState('error', 'Отправка отклонена.');
      return false;
    }
    const required = ['firstName', 'lastName', 'seminar', 'amount', 'email', 'phone'] as const;
    let firstInvalid: HTMLInputElement | null = null;
    for (const name of required) {
      const el = formEl.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (!el) continue;
      let ok = el.value.trim().length > 0;
      if (name === 'amount') ok = Number.isInteger(Number(el.value)) && Number(el.value) > 0;
      if (name === 'email') ok = el.value.includes('@') && Boolean(el.value.split('@')[1]?.includes('.'));
      if (name === 'phone') ok = el.value.replace(/\D/g, '').length >= 10;
      if (!ok) {
        showFieldError(name, 'Проверьте поле');
        firstInvalid ??= el;
      }
    }
    const consent = formEl.querySelector<HTMLInputElement>('[name="consent"]');
    if (consent && !consent.checked) {
      showFieldError('consent', 'Отметьте передачу данных оператору платежей');
      firstInvalid ??= consent;
    }
    // Пересчёт БЕЗУСЛОВНЫЙ, а не в ветви `firstInvalid`, и это находка ревью (P2):
    // `validate()` начинается с `clearErrors()`, от которого футер уменьшается, поэтому
    // геометрия меняется и на успешном проходе. С пересчётом только для ошибочного поля
    // признак «места нет» оставался висеть после «сначала ошиблись, потом исправили», и
    // футер не прилипал до поворота экрана или переоткрытия окна.
    //
    // Порядок важен и здесь: считаем ПОСЛЕ показа/снятия ошибок (иначе меряем прошлую
    // высоту футера) и ДО перевода фокуса. `focus()` прокручивает панель сам, по текущей
    // `scroll-padding-bottom`, и со старым значением уводит поле не туда — `revealField`
    // потом лишь исправляет последствия. Повторный вызов внутри `revealField` безвреден:
    // функция идемпотентна.
    syncFooterBand();
    if (firstInvalid) {
      firstInvalid.focus();
      revealField(firstInvalid);
    }
    return !firstInvalid;
  }

  function payload(requestId: string, extra: Record<string, unknown> = {}) {
    const amount = Number((formEl.querySelector<HTMLInputElement>('[name="amount"]')?.value ?? '').trim());
    const start = (formEl.querySelector<HTMLInputElement>('[name="startDate"]')?.value ?? '').trim();
    const venue = (formEl.querySelector<HTMLInputElement>('[name="venue"]')?.value ?? '').trim();
    return {
      requestId,
      firstName: (formEl.querySelector<HTMLInputElement>('[name="firstName"]')?.value ?? '').trim(),
      lastName: (formEl.querySelector<HTMLInputElement>('[name="lastName"]')?.value ?? '').trim(),
      seminar: (formEl.querySelector<HTMLInputElement>('[name="seminar"]')?.value ?? '').trim(),
      amount,
      startDate: start || null,
      venue: venue || null,
      email: (formEl.querySelector<HTMLInputElement>('[name="email"]')?.value ?? '').trim(),
      phone: (formEl.querySelector<HTMLInputElement>('[name="phone"]')?.value ?? '').trim(),
      consent: true,
      ...extra,
    };
  }

  function lockSubmit() {
    inFlight = true;
  }

  function unlockSubmit() {
    inFlight = false;
  }

  /** Keep the lock while redirecting to YooKassa so a second click cannot start another POST. */
  function shouldUnlockAfter(http: number, json: ApiBody): boolean {
    const status = json.status ?? '';
    if (status === 'created' && json.confirmationUrl) return false;
    return true;
  }

  async function onSubmit(opts: { confirmDuplicate?: boolean } = {}) {
    if (inFlight) return;
    lockSubmit();
    try {
      if (!formEl.querySelector('[name="firstName"]')) {
        const stored = readFields()[activeRequestId];
        if (stored) applyFields(stored);
        else restoreFieldsDom();
      }
      if (!opts.confirmDuplicate && !validate()) {
        unlockSubmit();
        return;
      }
      if (!activeRequestId) activeRequestId = generateRequestId();
      const extra: Record<string, unknown> = {};
      if (opts.confirmDuplicate && pendingToken) {
        extra.duplicateConfirmationToken = pendingToken;
        extra.duplicateConfirmed = true;
      }
      if (!upsertHold(activeRequestId)) {
        setState('error', 'Достигнут предел незавершённых попыток. Завершите одну из них.');
        unlockSubmit();
        return;
      }
      const body = payload(activeRequestId, extra);
      const fields = readFields();
      fields[activeRequestId] = collectFields();
      writeFields(fields);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
      const res = await fetch(`${endpoint}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const json = (await res.json().catch(() => ({}))) as ApiBody;
      applyResponse(res.status, json);
      if (shouldUnlockAfter(res.status, json)) unlockSubmit();
    } catch {
      setState('unknown', 'Исход отправки неизвестен. Свяжитесь с нами напрямую.');
      stripFieldsDom();
      setChrome({ warning: true, continue: true, other: true });
      unlockSubmit();
    }
  }

  function applyResponse(http: number, json: ApiBody) {
    const status = json.status ?? '';
    if (json.requestId && json.requestId !== activeRequestId) {
      const previous = activeRequestId;
      const all = readFields();
      if (all[previous] && !all[json.requestId]) {
        all[json.requestId] = all[previous];
        delete all[previous];
        writeFields(all);
      }
      dropHold(previous);
      activeRequestId = json.requestId;
      upsertHold(activeRequestId);
    }
    if (status) holdStatuses.set(activeRequestId, json);

    if (isDemoBuild && status === 'created_demo') {
      dropHold(activeRequestId);
      activeRequestId = '';
      setState('demo', 'Отправка не выполнена в демонстрационном режиме.');
      restoreFieldsDom();
      setChrome({});
      return;
    }
    if (!isDemoBuild && status === 'created_demo') {
      dropHold(activeRequestId);
      setState('error', 'Ошибка адресата. Свяжитесь с нами напрямую.');
      setChrome({});
      return;
    }
    if (status === 'created' && json.confirmationUrl) {
      const url = json.confirmationUrl;
      setState('created', 'Переходим к оплате… ');
      const go = document.createElement('a');
      go.href = url;
      go.setAttribute('data-payment-confirmation-url', '');
      go.textContent = 'Продолжить оплату';
      stateHost.querySelector('[data-payment-state]')?.append(go);
      location.assign(url);
      return;
    }
    if (status === 'already_paid') {
      dropHold(activeRequestId);
      activeRequestId = '';
      setState('already_paid', 'Оплата уже подтверждена.');
      restoreFieldsDom();
      formEl.reset();
      setChrome({});
      return;
    }
    if (status === 'canceled') {
      dropHold(activeRequestId);
      activeRequestId = '';
      setState('canceled', 'Оплата отклонена или отменена.');
      restoreFieldsDom();
      formEl.reset();
      setChrome({});
      return;
    }
    if (status === 'rejected' && http === 409) {
      dropHold(activeRequestId);
      activeRequestId = '';
      setState('rejected', 'Данные попытки изменились, отправьте как новую попытку.');
      restoreFieldsDom();
      setChrome({});
      return;
    }
    if (status === 'rejected') {
      setState('error', http === 429 ? 'Слишком много запросов. Подождите и попробуйте снова.' : 'Проверьте поля формы.');
      setChrome({});
      return;
    }
    if (status === 'duplicate_confirmation_required') {
      pendingToken = json.confirmationToken ?? '';
      dropHold(activeRequestId, { keepFields: true });
      setState(
        'duplicate_confirmation_required',
        'По этим данным оплата уже подтверждена — создать ещё один платёж?',
      );
      stripFieldsDom();
      setChrome({ confirm: true });
      return;
    }
    if (status === 'verification_required') {
      const stored = readFields()[activeRequestId];
      setState(
        'verification_required',
        'Исход этой попытки нельзя подтвердить автоматически. Платёж мог быть создан, повторять оплату не нужно. Свяжитесь с нами.',
      );
      stripFieldsDom();
      setChrome({
        warning: true,
        summary: stored ? `${stored.firstName ?? ''} ${stored.lastName ?? ''}, ${stored.seminar ?? ''}, ${stored.amount ?? ''} ₽` : undefined,
        continue: true,
        other: true,
      });
      return;
    }
    setState('error', 'Ошибка адресата. Свяжитесь с нами напрямую.');
    stripFieldsDom();
    setChrome({ warning: true, continue: true, other: true });
  }

  function startOtherSeminar() {
    activeRequestId = '';
    pendingToken = '';
    stateHost.replaceChildren();
    restoreFieldsDom();
    formEl.reset();
    setChrome({ other: readHolds().length < MAX_HOLDS });
    const box = document.createElement('div');
    box.setAttribute('data-payment-hold-warning', '');
    box.textContent = 'Предыдущая попытка остаётся незавершённой. Можно начать оплату другого семинара.';
    chrome.prepend(box);
    openDialog();
  }

  async function pollStatus(requestId: string, waitPending = false): Promise<ApiBody | null> {
    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const res = await fetch(`${endpoint}/payments/${requestId}/status`, {
          signal: AbortSignal.timeout(remaining),
        });
        const json = (await res.json().catch(() => ({}))) as ApiBody;
        if (res.status === 404) return { status: 'not_found' };
        if (res.status === 503 && json.status === 'verification_required') {
          return { status: 'verification_required', requestId: json.requestId };
        }
        if (!res.ok) return { status: 'unknown' };
        if (json.status === 'not_found') return { status: 'not_found' };
        if (json.status === 'verification_required') {
          return { status: 'verification_required', requestId: json.requestId };
        }
        if (json.status === 'rejected') return { status: 'unknown' };
        if (waitPending && json.status === 'pending' && deadline - Date.now() > 500) {
          await new Promise((r) => setTimeout(r, Math.min(400, Math.max(0, deadline - Date.now()))));
          continue;
        }
        if (
          json.status === 'pending' ||
          json.status === 'succeeded' ||
          json.status === 'canceled' ||
          json.status === 'unknown' ||
          json.status === 'demo'
        ) {
          return json;
        }
        return { status: 'unknown' };
      } catch {
        if (Date.now() >= deadline) return { status: 'unknown' };
        return { status: 'unknown' };
      }
    }
    return { status: 'unknown' };
  }

  function applyStatus(requestId: string, json: ApiBody) {
    activeRequestId = requestId;
    holdStatuses.set(requestId, json);
    const status = json.status ?? '';
    if (status === 'not_found' || status === 'demo') {
      dropHold(requestId);
      activeRequestId = '';
      if (status === 'demo') setState('demo', 'Отправка не выполнена в демонстрационном режиме.');
      restoreFieldsDom();
      setChrome({});
      openDialog();
      return;
    }
    if (status === 'succeeded') {
      dropHold(requestId);
      activeRequestId = '';
      setState('succeeded', 'Оплата подтверждена.');
      restoreFieldsDom();
      setChrome({});
      openDialog();
      return;
    }
    if (status === 'canceled') {
      dropHold(requestId);
      activeRequestId = '';
      setState('canceled', 'Оплата отклонена или отменена.');
      restoreFieldsDom();
      setChrome({});
      openDialog();
      return;
    }
    if (status === 'verification_required') {
      applyResponse(503, { status: 'verification_required', requestId });
      openDialog();
      return;
    }
    if (status === 'unknown') {
      setState('unknown', 'Статус не удалось проверить. Свяжитесь с нами напрямую.');
      stripFieldsDom();
      setChrome({ warning: true, continue: true, other: true });
      openDialog();
      return;
    }
    if (status === 'pending') {
      setState('pending', 'Оплата ещё не завершена.');
      stripFieldsDom();
      setChrome({ warning: true, continue: true, other: true });
      openDialog();
      return;
    }
    setState('unknown', 'Статус не удалось проверить. Свяжитесь с нами напрямую.');
    stripFieldsDom();
    setChrome({ warning: true, continue: true, other: true });
    openDialog();
  }

  async function restoreOnLoad() {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get(RETURN_PARAM);
    if (fromQuery) {
      url.searchParams.delete(RETURN_PARAM);
      history.replaceState({}, '', url.pathname + url.search + url.hash);
      const json = await pollStatus(fromQuery, true);
      if (json) applyStatus(fromQuery, json);
      await refreshSiblingHolds(fromQuery);
      return;
    }
    const holds = readHolds();
    if (!holds.length) return;
    const results = await Promise.all(holds.map(async (h) => ({ id: h.requestId, json: await pollStatus(h.requestId) })));
    for (const item of results) {
      if (item.json) holdStatuses.set(item.id, item.json);
    }
    for (const item of results) {
      const status = item.json?.status ?? '';
      if (status === 'succeeded' || status === 'canceled' || status === 'not_found' || status === 'demo') {
        if (item.json) applyStatus(item.id, item.json);
      }
    }
    const live = readHolds();
    if (!live.length) return;
    const last = live[live.length - 1]!;
    const json = holdStatuses.get(last.requestId) ?? { status: 'unknown' };
    applyStatus(last.requestId, json);
  }

  async function refreshSiblingHolds(keepId: string) {
    const holds = readHolds().filter((h) => h.requestId !== keepId);
    if (!holds.length) return;
    const results = await Promise.all(
      holds.map(async (h) => ({ id: h.requestId, json: await pollStatus(h.requestId) })),
    );
    for (const item of results) {
      if (!item.json) continue;
      holdStatuses.set(item.id, item.json);
      const status = item.json.status ?? '';
      if (status === 'succeeded' || status === 'canceled' || status === 'not_found' || status === 'demo') {
        dropHold(item.id);
      }
    }
    renderAttempts();
  }
}
