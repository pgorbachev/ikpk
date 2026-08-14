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

const form = document.querySelector<HTMLFormElement>('[data-payment-form]');
if (form) boot(form);

function boot(formEl: HTMLFormElement) {
  const endpoint = formEl.getAttribute('data-payment-endpoint') ?? '';
  const isDemoBuild = formEl.getAttribute('data-payment-demo') === 'true';
  const root = document.getElementById('payment-dialog-root');
  const dialog = document.querySelector<HTMLElement>('.payment-dialog');
  const stateHost = document.querySelector<HTMLElement>('[data-payment-state-host]');
  const chrome = document.querySelector<HTMLElement>('[data-payment-chrome]');
  const attemptsWrap = document.querySelector<HTMLElement>('[data-payment-attempts]');
  const attemptList = document.querySelector<HTMLElement>('[data-payment-attempt-list]');
  const actions = document.querySelector<HTMLElement>('[data-payment-actions]');
  const closeBtn = document.querySelector<HTMLButtonElement>('[data-payment-close]');
  if (!root || !dialog || !stateHost || !chrome || !attemptsWrap || !attemptList || !actions) return;

  const fieldsHtml = formEl.innerHTML;
  let activeRequestId = '';
  let pendingToken = '';
  let lastOpener: HTMLElement | null = null;
  let inFlight = false;

  enhanceEntry();
  void restoreOnLoad();

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    void onSubmit();
  });
  closeBtn?.addEventListener('click', () => closeDialog());
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
    legacy.replaceWith(button);
    button.addEventListener('click', () => openDialog(button));
  }

  function openDialog(opener?: HTMLElement) {
    lastOpener = opener ?? lastOpener;
    root.hidden = false;
    dialog.hidden = false;
    formEl.hidden = !formEl.querySelector('[name="firstName"]') ? formEl.hidden : false;
    setBackgroundInert(true);
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
      if (live.length !== raw.length) writeHolds(live);
      return live;
    } catch {
      return [];
    }
  }

  function writeHolds(holds: Hold[]) {
    localStorage.setItem(HOLD_KEY, JSON.stringify(holds.slice(0, MAX_HOLDS)));
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

  function upsertHold(requestId: string) {
    if (isDemoBuild) return;
    const holds = readHolds().filter((h) => h.requestId !== requestId);
    holds.push({ requestId, createdAt: Date.now() });
    writeHolds(holds);
  }

  function dropHold(requestId: string, opts: { keepFields?: boolean } = {}) {
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
    if (!formEl.querySelector('[name="firstName"]')) formEl.innerHTML = fieldsHtml;
    formEl.hidden = false;
  }

  function stripFieldsDom() {
    formEl.innerHTML = '';
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
    copy?: boolean;
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
        if (stored) {
          applyFields(stored);
          void onSubmit();
          return;
        }
        restoreFieldsDom();
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
    if (opts.copy) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-payment-copy-id', '');
      btn.textContent = 'Скопировать идентификатор';
      btn.addEventListener('click', () => void navigator.clipboard.writeText(activeRequestId));
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
    attemptList.innerHTML = holds.map((h) => `<li data-payment-attempt>${h.requestId}</li>`).join('');
  }

  function setState(name: string, html: string, focusPanel = false) {
    stateHost.innerHTML = `<div data-payment-state="${name}" ${focusPanel ? 'tabindex="-1"' : ''} role="status">${html}</div>`;
    const panel = stateHost.querySelector<HTMLElement>('[data-payment-state]');
    if (focusPanel && panel) panel.focus();
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
    firstInvalid?.focus();
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
      if (!activeRequestId) activeRequestId = crypto.randomUUID();
      const extra: Record<string, unknown> = {};
      if (opts.confirmDuplicate && pendingToken) {
        extra.duplicateConfirmationToken = pendingToken;
        extra.duplicateConfirmed = true;
      }
      const body = payload(activeRequestId, extra);
      upsertHold(activeRequestId);
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
      setChrome({ warning: true, continue: true, other: true, copy: true });
      unlockSubmit();
    }
  }

  function applyResponse(http: number, json: ApiBody) {
    const status = json.status ?? '';
    if (json.requestId && json.requestId !== activeRequestId) {
      const previous = activeRequestId;
      dropHold(previous);
      activeRequestId = json.requestId;
      upsertHold(activeRequestId);
      const all = readFields();
      if (all[previous] && !all[activeRequestId]) {
        all[activeRequestId] = all[previous];
        delete all[previous];
        writeFields(all);
      }
    }

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
      setTimeout(() => window.location.assign(url), 3000);
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
        true,
      );
      stripFieldsDom();
      setChrome({
        warning: true,
        summary: stored ? `${stored.firstName ?? ''} ${stored.lastName ?? ''}, ${stored.seminar ?? ''}, ${stored.amount ?? ''} ₽` : undefined,
        continue: true,
        other: true,
        copy: true,
      });
      return;
    }
    setState('error', 'Ошибка адресата. Свяжитесь с нами напрямую.');
    stripFieldsDom();
    setChrome({ warning: true, continue: true, other: true, copy: true });
  }

  function startOtherSeminar() {
    activeRequestId = '';
    pendingToken = '';
    stateHost.innerHTML = '';
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
    const started = Date.now();
    while (Date.now() - started < STATUS_TIMEOUT_MS) {
      try {
        const res = await fetch(`${endpoint}/payments/${requestId}/status`, {
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });
        const json = (await res.json().catch(() => ({}))) as ApiBody;
        if (res.status === 404 || json.status === 'not_found') return { status: 'not_found' };
        if (waitPending && json.status === 'pending' && Date.now() - started < STATUS_TIMEOUT_MS - 500) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        return json;
      } catch {
        return { status: 'unknown' };
      }
    }
    return { status: 'unknown' };
  }

  function applyStatus(requestId: string, json: ApiBody) {
    activeRequestId = requestId;
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
      setChrome({ warning: true, continue: true, other: true, copy: true });
      openDialog();
      return;
    }
    if (status === 'pending') {
      setState('pending', 'Оплата ещё не завершена.');
      stripFieldsDom();
      setChrome({ warning: true, continue: true, other: true });
      openDialog();
    }
  }

  async function restoreOnLoad() {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get(RETURN_PARAM);
    if (fromQuery) {
      url.searchParams.delete(RETURN_PARAM);
      history.replaceState({}, '', url.pathname + url.search + url.hash);
      const json = await pollStatus(fromQuery, true);
      if (json) applyStatus(fromQuery, json);
      return;
    }
    const holds = readHolds();
    if (!holds.length) return;
    const results = await Promise.all(holds.map(async (h) => ({ id: h.requestId, json: await pollStatus(h.requestId) })));
    for (const item of results) {
      if (item.json) applyStatus(item.id, item.json);
    }
  }
}
