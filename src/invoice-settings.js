// Invoice identity is a separate local-only setting. Never rewrite report storage.
export const INVOICE_SETTINGS_KEY = 'routenote-ui-preview:invoice-settings:v1';
export const INVOICE_SETTINGS_VERSION = 2;
export const INVOICE_SETTINGS_LIMITS = Object.freeze({ tradeName: 60, legalName: 60, postalCode: 16, address: 90, registrationNumber: 32, addressLines: 3, bankName: 40, branchName: 40, accountType: 16, accountNumber: 20, accountHolder: 60, rate: 10, priceMode: 16, rounding: 16 });
const ISSUER_FIELDS = ['tradeName', 'legalName', 'postalCode', 'address', 'registrationNumber'];
const BANK_FIELDS = ['bankName', 'branchName', 'accountType', 'accountNumber', 'accountHolder'];
const TAX_FIELDS = ['rate', 'priceMode', 'rounding'];
export const INVOICE_BANK_TYPES = Object.freeze({ ordinary: '普通', checking: '当座', savings: '貯蓄' });
export const INVOICE_TAX_PRICE_MODES = Object.freeze({ exclusive: '税抜', inclusive: '税込' });
export const INVOICE_TAX_ROUNDING = Object.freeze({ floor: '切り捨て', round: '四捨五入', ceil: '切り上げ' });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const emptyFields = fields => Object.fromEntries(fields.map(key => [key, '']));
const copy = value => JSON.parse(JSON.stringify(value));
export function emptyInvoiceSettings() { return { version: INVOICE_SETTINGS_VERSION, revision: 0, issuer: emptyFields(ISSUER_FIELDS), bankAccounts: [emptyFields(BANK_FIELDS), emptyFields(BANK_FIELDS)], tax: emptyFields(TAX_FIELDS) }; }
export class InvoiceSettingsError extends Error {
  constructor(message, code) { super(message); this.name = 'InvoiceSettingsError'; this.code = code; }
}
const invalid = () => new InvoiceSettingsError('会社・銀行・税率の設定の保存データを読み取れません。元のデータは上書きしていません。', 'invalid-storage');
function validFields(value, fields) {
  return hasKeys(value, fields) && fields.every(key => typeof value[key] === 'string' && value[key].length <= INVOICE_SETTINGS_LIMITS[key] && !/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufffe\uffff]/u.test(value[key]) && (key === 'address' ? value[key].split('\n').length <= INVOICE_SETTINGS_LIMITS.addressLines : !value[key].includes('\n')));
}
function validBanks(values) {
  return Array.isArray(values) && values.length === 2 && values.every(value => validFields(value, BANK_FIELDS) && (value.accountType === '' || Object.hasOwn(INVOICE_BANK_TYPES, value.accountType)) && (value.accountNumber === '' || /^[0-9]{1,20}$/.test(value.accountNumber)));
}
function validTax(value) {
  return validFields(value, TAX_FIELDS) && (value.rate === '' || (/^\d{1,3}(?:\.\d{1,6})?$/.test(value.rate) && Number(value.rate) <= 100)) && (value.priceMode === '' || Object.hasOwn(INVOICE_TAX_PRICE_MODES, value.priceMode)) && (value.rounding === '' || Object.hasOwn(INVOICE_TAX_ROUNDING, value.rounding));
}
export function validateInvoiceSettings(settings) {
  if (!isObject(settings) || !Number.isSafeInteger(settings.revision) || settings.revision < 0 || !validFields(settings.issuer, ISSUER_FIELDS)) throw invalid();
  // Upgrade v1 only in memory. Its exact bytes remain the conflict token and
  // are replaced only after an explicit save succeeds. Never discard extras.
  if (settings.version === 1 && hasKeys(settings, ['version', 'revision', 'issuer'])) return { ...emptyInvoiceSettings(), revision: settings.revision, issuer: copy(settings.issuer) };
  if (!hasKeys(settings, ['version', 'revision', 'issuer', 'bankAccounts', 'tax']) || settings.version !== INVOICE_SETTINGS_VERSION || !validBanks(settings.bankAccounts) || !validTax(settings.tax)) throw invalid();
  return settings;
}
function normalizeFields(values, fields) {
  const normalized = {};
  for (const key of fields) {
    if (typeof values?.[key] !== 'string') throw new InvoiceSettingsError('入力内容を確認してください。', 'invalid-input');
    normalized[key] = values[key].replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).join('\n').trim();
  }
  if (!validFields(normalized, fields)) throw new InvoiceSettingsError('入力が長すぎるか、使用できない文字が含まれています。住所は90文字・3行以内、会社名と法人名は各60文字以内です。', 'invalid-input');
  return normalized;
}
function normalizeBankAccounts(values) {
  if (!Array.isArray(values) || values.length !== 2) throw new InvoiceSettingsError('振込先は2口座まで設定できます。', 'invalid-input');
  const accounts = values.map(value => normalizeFields(value, BANK_FIELDS));
  if (!validBanks(accounts)) throw new InvoiceSettingsError('口座種別を確認してください。口座番号は数字20桁以内です。', 'invalid-input');
  return accounts;
}
function normalizeTax(value) {
  const tax = normalizeFields(value, TAX_FIELDS);
  if (!validTax(tax)) throw new InvoiceSettingsError('税率は0〜100%・小数6桁以内、税込／税抜と端数処理は選択肢から指定してください。', 'invalid-input');
  return tax;
}
function normalizeSection(kind, values) { return kind === 'bank' ? normalizeBankAccounts(values) : kind === 'tax' ? normalizeTax(values) : normalizeFields(values, ISSUER_FIELDS); }
function checkedStorageKey(storageKey) {
  if (typeof storageKey !== 'string' || storageKey.length === 0 || storageKey.length > 256 || /[\u0000-\u001f\u007f]/u.test(storageKey)) throw new InvoiceSettingsError('会社・銀行・税率の設定の保存先を確認できません。保存していません。', 'invalid-storage-key');
  return storageKey;
}
export function readInvoiceSettings(storage = globalThis.localStorage, storageKey = INVOICE_SETTINGS_KEY) {
  checkedStorageKey(storageKey);
  let raw;
  try { raw = storage.getItem(storageKey); }
  catch { throw new InvoiceSettingsError('このブラウザの設定を読み取れません。保存領域の利用設定を確認してください。', 'storage-unavailable'); }
  if (raw === null) return { raw, settings: emptyInvoiceSettings() };
  try { return { raw, settings: validateInvoiceSettings(JSON.parse(raw)) }; }
  catch { throw invalid(); }
}
export function createInvoiceSettingsStore({ getStorage = () => globalThis.localStorage, storageKey = INVOICE_SETTINGS_KEY } = {}) {
  checkedStorageKey(storageKey);
  function storage() {
    try { return getStorage(); }
    catch { throw new InvoiceSettingsError('このブラウザの保存領域を利用できません。設定は保存していません。', 'storage-unavailable'); }
  }
  function read() { return readInvoiceSettings(storage(), storageKey); }
  function saveSection(kind, values, expectedRaw) {
    // This whole read/check/write sequence is synchronous. The UI additionally
    // serializes cooperating tabs with Web Locks when that API is available.
    const target = storage(), current = readInvoiceSettings(target, storageKey);
    if (current.raw !== expectedRaw) throw new InvoiceSettingsError('別の画面で会社・銀行・税率の設定が変更されました。保存していません。入力内容を控え、閉じて開き直してください。', 'conflict');
    const settings = copy(current.settings);
    if (settings.revision >= Number.MAX_SAFE_INTEGER) throw invalid();
    settings[kind === 'bank' ? 'bankAccounts' : kind === 'tax' ? 'tax' : 'issuer'] = normalizeSection(kind, values);
    settings.revision++;
    const raw = JSON.stringify(settings);
    try { target.setItem(storageKey, raw); }
    catch { throw new InvoiceSettingsError('保存領域の空き容量などを確認してください。設定は保存していません。入力内容は残しています。', 'write-failed'); }
    return { raw, settings: copy(settings) };
  }
  return { read, getSettings: () => read().settings, saveIssuer: (values, raw) => saveSection('issuer', values, raw), saveBankAccounts: (values, raw) => saveSection('bank', values, raw), saveTax: (values, raw) => saveSection('tax', values, raw) };
}

export function installInvoiceSettings({ doc = document, onChange = () => {}, getStorage = () => doc.defaultView.localStorage, storageKey = INVOICE_SETTINGS_KEY, store: injectedStore, onSaveError=()=>{} } = {}) {
  const win = doc.defaultView, store = injectedStore??createInvoiceSettingsStore({ getStorage, storageKey });
  const dialog = doc.createElement('dialog');
  dialog.id = 'invoice-settings-dialog'; dialog.className = 'invoice-settings-dialog';
  dialog.setAttribute('aria-labelledby', 'invoice-settings-title');
  dialog.setAttribute('aria-describedby', 'invoice-settings-note');
  doc.body.append(dialog);
  let context = null, origin = null, baseline = '', busy = false, disposed = false, discardAction = 'close';
  const fieldsValues = (fields, prefix = '') => Object.fromEntries(fields.map(key => [key, dialog.querySelector(`[name="${prefix}${key}"]`)?.value ?? '']));
  const formValues = () => context?.kind === 'bank' ? [fieldsValues(BANK_FIELDS, 'bank0:'), fieldsValues(BANK_FIELDS, 'bank1:')] : fieldsValues(context?.kind === 'tax' ? TAX_FIELDS : ISSUER_FIELDS);
  const isDirty = () => Boolean(dialog.open && context?.mode === 'edit' && JSON.stringify(formValues()) !== baseline);
  function setError(message) { const node = dialog.querySelector('#invoice-settings-error'); if (node) { node.textContent = message; node.hidden = !message; } }
  function finishClose() {
    if (dialog.open) { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); }
    const kind = context?.kind || 'issuer';
    context = null; baseline = '';
    const available = element => element?.isConnected && !element.closest('[hidden], dialog:not([open])');
    const replacement = [...doc.querySelectorAll(`[data-invoice-settings="${kind}"]`)].find(available);
    const focusTarget = available(origin) ? origin : available(replacement) ? replacement : null;
    focusTarget?.focus();
  }
  function confirmDiscard(action) {
    discardAction = action;
    const panel = dialog.querySelector('#invoice-settings-discard'); panel.hidden = false;
    panel.querySelector('[data-invoice-discard]').textContent = action === 'view' ? '破棄して戻る' : '破棄して閉じる';
    panel.querySelector('[data-invoice-keep]').focus();
  }
  function close({ discard = false } = {}) {
    if (busy) return false;
    if (!dialog.open) return true;
    if (isDirty() && !discard) { confirmDiscard('close'); return false; }
    finishClose(); return true;
  }
  const labels = { tradeName: '会社名・屋号', legalName: '法人名・氏名', postalCode: '郵便番号', address: '住所', registrationNumber: '適格請求書発行事業者の登録番号', bankName: '金融機関名', branchName: '支店名', accountType: '口座種別', accountNumber: '口座番号', accountHolder: '口座名義', rate: '税率（%）', priceMode: '税込／税抜', rounding: '税額の端数処理' };
  const optionLabels = { accountType: INVOICE_BANK_TYPES, priceMode: INVOICE_TAX_PRICE_MODES, rounding: INVOICE_TAX_ROUNDING };
  const titles = { issuer: '会社情報', bank: '銀行情報', tax: '税率' };
  function field(key, value, prefix = '') {
    const name = prefix + key;
    const control = optionLabels[key] ? `<select name="${name}"><option value="" ${value === '' ? 'selected' : ''}>未設定</option>${Object.entries(optionLabels[key]).map(([option, label]) => `<option value="${option}" ${option === value ? 'selected' : ''}>${label}</option>`).join('')}</select>` : key === 'address' ? `<textarea name="${name}" rows="3" maxlength="${INVOICE_SETTINGS_LIMITS[key]}" aria-describedby="invoice-address-help">${esc(value)}</textarea><small id="invoice-address-help">90文字・3行まで。行頭の空白は保存時に除きます。</small>` : `<input name="${name}" value="${esc(value)}" maxlength="${INVOICE_SETTINGS_LIMITS[key]}" autocomplete="off"${key === 'rate' ? ' inputmode="decimal"' : key === 'accountNumber' ? ' inputmode="numeric"' : ''}>`;
    return `<label class="field"><span>${labels[key]} <small>任意</small></span>${control}</label>`;
  }
  function fieldsHTML(fields, values, editing, prefix = '') {
    return editing ? `<div class="invoice-settings-fields">${fields.map(key => field(key, values[key], prefix)).join('')}</div>` : `<dl class="invoice-settings-values">${fields.map(key => `<div><dt>${labels[key]}</dt><dd data-invoice-value="${prefix}${key}">${esc(context.error ? '確認できません' : optionLabels[key]?.[values[key]] || values[key] || '未設定')}</dd></div>`).join('')}</dl>`;
  }
  function render(mode = 'view', message = '') {
    context.mode = mode;
    const editing = mode === 'edit', kind = context.kind, title = titles[kind];
    const content = kind === 'bank' ? context.settings.bankAccounts.map((account, index) => `<section class="invoice-bank-group"><h3>振込先${index + 1}</h3>${fieldsHTML(BANK_FIELDS, account, editing, `bank${index}:`)}</section>`).join('') : fieldsHTML(kind === 'tax' ? TAX_FIELDS : ISSUER_FIELDS, kind === 'tax' ? context.settings.tax : context.settings.issuer, editing);
    const description = kind === 'bank' ? '請求書に表示する振込先（任意）' : kind === 'tax' ? '今後の計算に使う候補の設定' : '請求書に表示する会社名・住所';
    dialog.innerHTML = `<form id="invoice-settings-form" novalidate><header class="dialog-head"><div><h2 id="invoice-settings-title">${title}${editing ? 'を編集' : ''}</h2><p>${description}</p></div><button type="button" class="icon-button" data-invoice-close aria-label="${title}を閉じる">×</button></header><div class="dialog-body"><p id="invoice-settings-note" class="invoice-settings-note">${injectedStore?'登録メンバーで共有する設定です。'+(context.provenance?.[kind]?.origin==='reference-document'&&context.provenance[kind].reviewStatus==='unreviewed'?'資料から仮入力・要確認。':''):'このブラウザ内だけに保存します。Google Sheetsへの接続・送信はありません。試作のため、実在の会社・個人・銀行口座の情報は入力しないでください。'}</p>${content}<p class="invoice-settings-note">${kind === 'tax' ? '税率・税込／税抜・端数処理は未設定から始めます。保存しても税計算はまだ行わず、正式な請求額も計算しません。過去の報告・保存済みPDFを変更しません。' : '空欄は未設定として表示します。設定は次に作る見本へ反映し、過去の報告・保存済みPDFは変更しません。正式な請求には使用できません。'}</p><p id="invoice-settings-status" role="status">${esc(message)}</p><p id="invoice-settings-error" class="form-error" role="alert" ${context.error ? '' : 'hidden'}>${esc(context.error)}</p><div id="invoice-settings-discard" class="invoice-settings-discard" role="group" aria-label="未保存の入力を破棄する確認" hidden><p>入力中の内容は保存されていません。破棄しますか？</p><div class="actions"><button type="button" class="button secondary" data-invoice-keep>入力に戻る</button><button type="button" class="button secondary danger-text" data-invoice-discard>破棄して閉じる</button></div></div></div><footer class="dialog-foot">${editing ? '<button type="button" class="button secondary" data-invoice-cancel-edit>キャンセル</button><button type="button" id="invoice-settings-save" class="button primary">保存</button>' : `<button type="button" class="button secondary" data-invoice-close>閉じる</button><button type="button" class="button primary" data-invoice-edit ${context.error ? 'disabled' : ''}>編集</button>`}</footer></form>`;
    baseline = editing ? JSON.stringify(formValues()) : '';
  }
  function open(kind = 'issuer') {
    if (disposed || busy || dialog.open) return false;
    origin = doc.activeElement;
    let loaded, error = '';
    try { loaded = store.read(); } catch (failure) { error = failure.message; loaded = { raw: undefined, settings: emptyInvoiceSettings() }; }
    context = { ...loaded, kind, mode: 'view', error };
    render();
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    dialog.querySelector('.dialog-foot [data-invoice-close]')?.focus();
    return true;
  }
  function setBusy(value) {
    busy = value;
    dialog.querySelectorAll('input, select, textarea, button').forEach(node => { node.disabled = value; });
    const save = dialog.querySelector('#invoice-settings-save');
    if (save) { save.disabled = value || Boolean(context?.error); save.textContent = value ? '保存中…' : '保存'; save.setAttribute('aria-busy', String(value)); }
  }
  async function save() {
    if (busy || context?.mode !== 'edit' || context.error) return;
    const draft = formValues(), expectedRaw = context.raw, kind = context.kind;
    try { normalizeSection(kind, draft); } catch (error) { setError(error.message); return; }
    setError(''); setBusy(true);
    try {
      const save = () => {
        if (disposed) throw new InvoiceSettingsError('画面が閉じられたため保存していません。', 'disposed');
        return (kind === 'bank' ? store.saveBankAccounts : kind === 'tax' ? store.saveTax : store.saveIssuer)(draft, expectedRaw);
      };
      const saved = win.navigator.locks?.request ? await win.navigator.locks.request(storageKey, save) : await save();
      if (disposed) return;
      context = { ...saved, kind, mode: 'view', error: '' };
      setBusy(false); render('view', injectedStore?'共有設定を保存しました。':'このブラウザに保存しました。');
      dialog.querySelector('[data-invoice-edit]').focus();
      // A rendering callback failure must never be described as a failed write.
      doc.dispatchEvent(new win.CustomEvent('invoice-settings-change', { detail: { storageKey } }));
      try { onChange(copy(saved.settings)); } catch { /* Storage was already saved. */ }
    } catch (error) { if (!disposed){setError(error.message || '保存できませんでした。入力内容は残しています。');onSaveError(dialog.querySelector('#invoice-settings-error'));} }
    finally { if (!disposed) setBusy(false); }
  }
  const click = event => {
    const target = event.target.closest?.('button'); if (!target || busy) return;
    if (Object.hasOwn(titles, target.dataset.invoiceSettings || '')) { open(target.dataset.invoiceSettings); return; }
    if (!dialog.contains(target)) return;
    if (target.id === 'invoice-settings-save') { void save(); return; }
    if (target.matches('[data-invoice-close]')) close();
    else if (target.matches('[data-invoice-edit]') && !context.error) { render('edit'); dialog.querySelector('input, select')?.focus(); }
    else if (target.matches('[data-invoice-cancel-edit]')) { if (isDirty()) confirmDiscard('view'); else { render(); dialog.querySelector('[data-invoice-edit]').focus(); } }
    else if (target.matches('[data-invoice-discard]')) { if (discardAction === 'view') { render(); dialog.querySelector('[data-invoice-edit]').focus(); } else close({ discard: true }); }
    else if (target.matches('[data-invoice-keep]')) { dialog.querySelector('#invoice-settings-discard').hidden = true; dialog.querySelector('input, select, textarea')?.focus(); }
  };
  // Never save on implicit form submission. A button click (including keyboard
  // activation while that button is focused) is the only save entry point.
  const submit = event => { if (event.target.id === 'invoice-settings-form') event.preventDefault(); };
  const keydown = event => {
    if (event.key === 'Enter' && event.target.matches?.('input') && !event.isComposing && event.keyCode !== 229) event.preventDefault();
    // Leave IME confirmation and textarea newlines intact; any subsequent
    // native submit is independently canceled by the listener above.
  };
  const cancel = event => { event.preventDefault(); close(); };
  const beforeUnload = event => { if (isDirty() || busy) { event.preventDefault(); event.returnValue = ''; } };
  const storageChange = event => {
    if (event.key !== storageKey && event.key !== null) return;
    if (dialog.open) setError('別の画面で保存内容が変わった可能性があります。入力は残しています。保存時に最新の内容と照合します。');
  };
  doc.addEventListener('click', click); dialog.addEventListener('submit', submit); dialog.addEventListener('keydown', keydown); dialog.addEventListener('cancel', cancel);
  win.addEventListener('beforeunload', beforeUnload); win.addEventListener('storage', storageChange);
  return {
    openIssuer: () => open('issuer'), openBank: () => open('bank'), openTax: () => open('tax'), getSettings: store.getSettings, isDirty, isBusy: () => busy, close,
    dispose() { disposed = true; finishClose(); dialog.remove(); doc.removeEventListener('click', click); dialog.removeEventListener('submit', submit); dialog.removeEventListener('keydown', keydown); dialog.removeEventListener('cancel', cancel); win.removeEventListener('beforeunload', beforeUnload); win.removeEventListener('storage', storageChange); }
  };
}
