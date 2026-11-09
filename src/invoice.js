import { prepareInvoiceSeal, loadDefaultInvoiceSeal, validateCanonicalSeal, createSealStore } from './invoice-seal.js';
import { localDate } from './model.js';
import { reportNotes } from './domain.js';
import { buildInvoiceDocument, invoicePageSVG, createInvoicePDF } from './invoice-document.js';
import { INVOICE_SETTINGS_KEY, emptyInvoiceSettings, validateInvoiceSettings, readInvoiceSettings } from './invoice-settings.js';

// Reference: the user's printed B5 examples, inspected read-only.
// No source customer, issuer, contact, price, or bank information is embedded.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const SCALE = 1_000_000n;
const PRODUCT_SCALE = SCALE * SCALE;
function fixed(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) return null;
  const [whole, fraction = ''] = value.toFixed(6).split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
function decimal(value, scale = PRODUCT_SCALE) {
  const digits = String(scale).length - 1;
  const fraction = (value % scale).toString().padStart(digits, '0').replace(/0+$/, '');
  return `${value / scale}${fraction ? `.${fraction}` : ''}`;
}
function number(value) {
  if (value === null) return '算出不可';
  const [whole, fraction] = String(value).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction}` : '');
}
function monthInfo(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month.slice(0, 4) === '0000') throw new Error('対象年月を選択してください。');
  const [year, mm] = month.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1];
  return { month, label: `${year}年${mm}月`, days: last, endDate: `${year}年${mm}月${last}日`, start: `${month}-01`, end: `${month}-${last}` };
}
function validateIssueDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('発行日を選択してください。');
  let dates;
  try { dates = monthInfo(value.slice(0, 7)); } catch { throw new Error('発行日を選択してください。'); }
  if (Number(value.slice(8)) < 1 || Number(value.slice(8)) > dates.days) throw new Error('発行日を選択してください。');
  return value;
}
function issueDateLabel(value) {
  try { validateIssueDate(value); } catch { return '日付を選択'; }
  return value.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1年$2月$3日');
}
function categoryLine(records, category, title) {
  let kg = 0n, known = 0n, entered = 0, missing = 0, quantities = 0, quantityMissing = 0;
  const rates = new Set();
  const details = [];
  for (const r of records) {
    const quantity = fixed(r[`${category}Kg`]), rate = fixed(r[`${category}Rate`]);
    const note = reportNotes(r)[category];
    const relevant = quantity !== null || Boolean(note || r.itemIds?.[category] || r.itemNames?.[category]);
    if (!relevant) continue;
    if (note) details.push({ date: r.date, text: note });
    entered++;
    if (quantity !== null) { kg += quantity; quantities++; }
    else quantityMissing++;
    if (rate !== null) rates.add(decimal(rate, SCALE));
    if (quantity === null || rate === null) missing++;
    else known += quantity * rate;
  }
  return { category, title, quantity: quantities ? decimal(kg, SCALE) : null, quantityMissing, unit: 'kg', rates: [...rates], known, amount: entered && !missing ? decimal(known) : null, entered, missing, details };
}

function totalWeight(lines) {
  if (lines.some(line => line.quantityMissing)) return { value: null, missing: true };
  if (lines.every(line => line.quantity === null)) return { value: null, missing: false };
  const value = lines.reduce((total, line) => {
    const [whole, fraction = ''] = (line.quantity || '0').split('.');
    return total + BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  }, 0n);
  return { value: decimal(value, SCALE), missing: false };
}
function otherAmount(records) {
  const relevant = records.filter(r => fixed(r.otherFee) !== null || reportNotes(r).other || r.itemIds?.other || r.itemNames?.other);
  let total = 0n, missing = false;
  for (const r of relevant) { const fee = fixed(r.otherFee); if (fee === null) missing = true; else total += fee; }
  return { value: relevant.length && !missing ? decimal(total, SCALE) : null, missing };
}

export function buildInvoicePreview(state, { month = localDate().slice(0, 7), customerId, issueDate = localDate(), documentType = 'invoice', includeMonthlyDetail = false } = {}, invoiceSettings = emptyInvoiceSettings()) {
  invoiceSettings = validateInvoiceSettings(invoiceSettings);
  const dates = monthInfo(month);
  if (!['invoice', 'monthly-detail'].includes(documentType)) throw new Error('出力の種類を選択してください。');
  if (documentType === 'invoice') validateIssueDate(issueDate);
  const customers = state.masters.customers;
  const customer = customers.find(c => c.id === customerId) || (customerId === undefined ? customers.find(c => state.records.some(r => !r.deleted && r.customerId === c.id && r.date >= dates.start && r.date <= dates.end)) || customers[0] : null);
  const records = customer ? state.records.filter(r => !r.deleted && r.customerId === customer.id && r.date >= dates.start && r.date <= dates.end).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)) : [];
  const combustible = categoryLine(records, 'combustible', '可燃物処分料');
  const noncombustible = categoryLine(records, 'noncombustible', '不燃物処分料');
  const otherRecords = records.filter(r => fixed(r.otherFee) !== null || reportNotes(r).other || r.itemIds?.other || r.itemNames?.other);
  let otherKnown = 0n, otherMissing = 0;
  for (const r of otherRecords) {
    const fee = fixed(r.otherFee);
    if (fee === null) otherMissing++;
    else otherKnown += fee * SCALE;
  }
  const missing = combustible.missing + noncombustible.missing + otherMissing;
  const hasCharges = combustible.entered + noncombustible.entered + otherRecords.length > 0;
  const known = combustible.known + noncombustible.known + otherKnown;
  const other = { title: documentType === 'invoice' ? '特別清掃運搬料' : '粗大ごみ・その他', amount: otherRecords.length && !otherMissing ? decimal(otherKnown) : null, entered: otherRecords.length, missing: otherMissing, details: otherRecords.map(r => ({ date: r.date, text: reportNotes(r).other || r.itemNames?.other || '備考未入力', amount: fixed(r.otherFee) === null ? null : decimal(fixed(r.otherFee), SCALE) })) };
  const daily = Array.from({ length: dates.days }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`, rows = records.filter(r => r.date === date);
    const c = categoryLine(rows, 'combustible', ''), n = categoryLine(rows, 'noncombustible', '');
    return { date, count: rows.length, combustible: { value: c.quantityMissing ? null : c.quantity, missing: c.quantityMissing > 0 }, noncombustible: { value: n.quantityMissing ? null : n.quantity, missing: n.quantityMissing > 0 }, other: otherAmount(rows), weight: totalWeight([c, n]) };
  });
  // Remove BigInt internals from the exported view model. All money is exact
  // decimal text, without applying an unconfirmed production rounding policy.
  const publicLine = ({ known: _known, ...line }) => line;
  return { ...dates, issuer: { ...invoiceSettings.issuer }, bankAccounts: invoiceSettings.bankAccounts.map(account => ({ ...account })), tax: { ...invoiceSettings.tax }, recipient: { postalCode: customer?.invoicePostalCode || '', address: customer?.invoiceAddress || '' }, issueDate, documentType, includeMonthlyDetail: Boolean(includeMonthlyDetail), daily, totalWeight: totalWeight([combustible, noncombustible]), customer: customer ? { id: customer.id, name: customer.name, active: customer.active } : null, count: records.length, currentSourceReference:state.referenceCalculation?.basis==='current-source-sheet'&&state.referenceCalculation.applied.some(entry=>records.some(record=>record.id===entry.recordId)), lines: [publicLine(combustible), publicLine(noncombustible)], other, missing, knownCharges: hasCharges ? decimal(known) : null, recordedCharges: hasCharges && !missing ? decimal(known) : null, legacyUnknown: records.filter(r => r.priceSource === 'legacy-unknown').length };
}

function previewHTML(view) {
  if (!view.customer) return '<div class="empty-state">出力する取引先がありません。設定で架空の取引先を追加してください。</div>';
  const document = buildInvoiceDocument(view);
  return document.pages.map((page, i) => `<article class="invoice-paper" data-document-kind="${page.kind}" aria-label="${page.kind === 'invoice' ? '請求書の架空プレビュー' : page.kind === 'monthly-detail' ? '月間回収明細の架空プレビュー' : '備考別紙'}">${invoicePageSVG(document, i)}</article>`).join('');
}

export function renderInvoiceOutput(state, selection = {}, invoiceSettings = emptyInvoiceSettings(), sealState = {}) {
  const view = { ...buildInvoicePreview(state, selection, invoiceSettings), seal: validateCanonicalSeal(sealState.seal ?? null) };
  const options = state.masters.customers.map(c => `<option value="${esc(c.id)}" ${c.id === view.customer?.id ? 'selected' : ''}>${esc(c.name)}${c.active ? '' : '（利用停止）'}</option>`).join('');
  return `<div class="section-heading"><div><p class="eyebrow">OUTPUT</p><h1>出力</h1><p class="subheading">写真の請求書・月間明細に沿ったB5の確認用見本。</p></div><span class="page-chip">${sealState.connected?'確認用・参考小計':'架空データのみ'}</span></div>
    <div class="invoice-controls"><label class="field"><span>対象年月</span><input type="month" id="invoice-month" min="0001-01" max="9999-12" value="${view.month}" required></label><label class="field"><span>取引先</span><select id="invoice-customer" ${options ? '' : 'disabled'}>${options || '<option value="">取引先なし</option>'}</select></label>
    <label class="field"><span>出力の種類</span><select id="invoice-document-type"><option value="invoice" ${view.documentType === 'invoice' ? 'selected' : ''}>請求書</option><option value="monthly-detail" ${view.documentType === 'monthly-detail' ? 'selected' : ''}>月間回収明細のみ</option></select></label>
    <label class="field"><span>発行日（請求書のみ）</span><span class="invoice-date-control${view.documentType === 'invoice' ? '' : ' is-disabled'}"><input type="date" id="invoice-issue-date" min="0001-01-01" max="9999-12-31" value="${esc(view.issueDate)}" ${view.documentType === 'invoice' ? 'required' : 'disabled'}><span id="invoice-issue-date-formatted" class="invoice-date-formatted" aria-hidden="true">${issueDateLabel(view.issueDate)}</span></span></label>
    <label class="invoice-optional" ${view.documentType === 'invoice' ? '' : 'hidden'}><input type="checkbox" id="invoice-include-detail" ${view.includeMonthlyDetail ? 'checked' : ''}>月間回収明細も同じPDFに含める（任意）</label>
    <section class="invoice-seal-controls" aria-labelledby="invoice-seal-title"><h2 id="invoice-seal-title">社印</h2><p id="invoice-seal-status" role="status">${view.seal ? sealState.isDefault ? '標準の社印' : sealState.persisted ? 'このブラウザに保存済み' : '選択中（再読み込みで解除）' : 'ー'}</p><p id="invoice-seal-error" class="form-error" role="alert" hidden></p>${sealState.storageWarning ? `<p class="form-error" role="status">${esc(sealState.storageWarning)}</p>` : ''}<details id="invoice-seal-options"><summary>社印を変更</summary><div class="invoice-seal-actions"><label class="invoice-seal-picker"><span>透過PNG（5MB以内）</span><input id="invoice-seal-file" type="file" accept=".png,image/png" aria-label="社印の画像を選ぶ" aria-describedby="invoice-seal-status"></label><button type="button" class="button secondary" id="invoice-seal-remove" ${sealState.isDefault ? 'disabled' : ''}>標準に戻す</button></div><label class="invoice-optional"><input type="checkbox" id="invoice-seal-persist" ${sealState.persisted ? 'checked' : ''} ${view.seal && !sealState.isDefault ? '' : 'disabled'}>このブラウザに保存する</label><details><summary>社印の保存について</summary><p>透過PNG（5MB・4096px以内）を赤い印影として使います。標準の社印は公開された低画質画像です。選んだ画像はこのPWAから外部へ送信せず、初期状態では開いているページ内だけで保持します。「このブラウザに保存する」を選ぶと次回も使えます。別の端末やブラウザへは同期されず、ブラウザデータの消去で失われます。</p><p>共有端末では保存しないでください。保存先は暗号化された会社用保管庫ではなく、このサイトの処理やブラウザの利用者からアクセスできます。「標準に戻す」でブラウザ内の保存も解除し、公開された標準の社印に戻ります。保存済みPDFは変わりません。PDFの受取人は印影をコピーできるため、送付先を確認してください。</p></details></details></section>
    <div class="invoice-actions"><button type="button" class="button primary" id="invoice-download" ${view.count ? '' : 'disabled'}>PDFをダウンロード</button><button type="button" class="button secondary" id="invoice-print" ${view.count ? '' : 'disabled'}>印刷</button></div></div>
    <div class="invoice-guide"><p>用紙はB5縦（暫定：JIS 182×257mm）。画面とPDFは同じ配置です。初期状態では月間回収明細も含めます。不要な場合はチェックを外せます。回収時の備考は別紙に全件表示します。PDFは画像形式のため文字の選択・検索はできません。</p><p>発行日は対象月と別に選びます。会社情報・銀行情報・税率と請求先住所は設定から入力でき、${sealState.connected?'登録メンバーで共有します。':'このブラウザ内だけに保存されます。Google Sheetsには接続しません。'}税率等を保存しても税計算・端数処理の計算はまだ行いません。採番も未設定です。正式な請求額は計算していないため、請求には使用できません。</p><p>参考小計は各回の重量 × 保存時の単価とその他料金の合算です。税は含めず、円単位への丸めもしていません。その他料金の月合計を「特別清掃運搬料」に1回だけ表示し、別の基本料は加えません。${view.currentSourceReference?'旧記録の単価未保存分は現在のシート単価による参考計算です。過去単価の確認・保存は行っていません。シート月次の丸め・基本料・税とは区別します。':view.legacyUnknown ? '旧版の不明な単価は補完していません。' : ''}</p><p>明細の「その他料金」は円です。写真の「粗大ごみ」の単位は未確認のため区別し、合計重量には可燃・不燃のkgだけを加えます。空欄は未入力で、0とは別です。</p></div>
    ${view.missing ? `<p class="invoice-warning">重量・単価・金額の不明または未入力が${view.missing}項目あります（不明・未入力あり）。参考小計は算出できません。入力済み部分の参考額: ${number(view.knownCharges)} 円。${view.lines.filter(line => line.missing).map(line => `${esc(line.title)}: ${line.missing}件の重量・単価が不明。`).join('')}</p>` : ''}
    ${!view.count ? '<p class="invoice-warning">この年月・取引先の記録はありません。金額を0円で補完していません。</p>' : ''}
    <p id="invoice-error" class="form-error" role="alert" hidden></p><p id="invoice-download-status" class="invoice-download-status" role="status" aria-live="polite"></p>
    <div id="invoice-save-result" class="invoice-save-result" hidden></div>
    <div id="invoice-preview" aria-live="polite">${previewHTML(view)}</div>`;
}

export function installInvoiceOutput({ doc = document, getState, print = () => doc.defaultView.print(), createPDF = createInvoicePDF, savePDF, prepareSeal = prepareInvoiceSeal, loadDefaultSeal = loadDefaultInvoiceSeal, sealStore, storageKey = INVOICE_SETTINGS_KEY, getInvoiceSettings = () => readInvoiceSettings(doc.defaultView.localStorage, storageKey).settings, validateOutput=null, prepareInitialOutput=null, coordinatedRestoration=false } = {}) {
  const host = doc.querySelector('#output-section');
  if (!host) throw new Error('出力画面が見つかりません。');
  const win = doc.defaultView, printMedia = win.matchMedia?.('print');
  // Initial UI preference only: later explicit ON/OFF selections are retained.
  // No persisted enclosure setting exists, and report/issuer storage is untouched.
  let previewEpoch=0,authoritySnapshot=null,authorizedPrint=false,authorizedDownload=false,previewLoading=false,previewValidated=!validateOutput;
  // Only the initial hidden preparation may reuse the authenticated startup snapshot.
  // Normal refresh/output and page restoration always require fresh validation.
  let initialPreparation=Boolean(validateOutput&&prepareInitialOutput),sealNeedsReload=false,restoringSeal=false,sealRestorePromise=Promise.resolve();
  let selection = { includeMonthlyDetail: true }, disposed = false, busy = false, revision = 0, generated = null;
  const downloadURLs = new Map();
  let sealIsDefault = false, sealError = '';
  let resolveReady, rejectReady;
  const sealReady=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  void sealReady.catch(()=>{});
  let seal = null, sealPersisted = false, sealBusy = false, sealLoading = false, sealRevision = 0, sealOperation = 0, sealStorageWarning = '';
  const privateSealStore = sealStore || createSealStore(win.indexedDB);
  const build = (options = selection) => ({ ...buildInvoicePreview(getState(), options, getInvoiceSettings()), seal, sealRevision });
  function setSealBusy(value) {
    sealBusy = value;
    for (const id of ['invoice-seal-file', 'invoice-seal-remove', 'invoice-seal-persist']) {
      const element = host.querySelector(`#${id}`);
      if (element) element.disabled = value || (id === 'invoice-seal-persist' && (!seal || sealIsDefault)) || (id === 'invoice-seal-remove' && sealIsDefault && !sealStorageWarning);
    }
    const status = host.querySelector('#invoice-seal-status');
    if (status && sealLoading) status.textContent = '社印を確認中…';
    else if (status && value) status.textContent = '社印を処理中…';
    else if (status) status.textContent = seal ? sealIsDefault ? '標準の社印' : sealPersisted ? 'このブラウザに保存済み' : '選択中（再読み込みで解除）' : 'ー';
    setBusy(busy);
  }
  function showSealError(message) {
    sealError = message;
    const error = host.querySelector('#invoice-seal-error');
    if (error) { error.textContent = message; error.hidden = false; }
  }
  function replaceSeal(value, persisted = false, isDefault = false) {
    const next = validateCanonicalSeal(value); if (!next) throw new Error('社印を読み込めません。');
    seal = next; sealPersisted = persisted; sealIsDefault = isDefault; sealError = ''; sealRevision++;
    if(!initialPreparation&&!restoringSeal)refresh();
  }
  async function loadSavedSeal() {
    const token = ++sealOperation; sealLoading = true; setSealBusy(true);
    try {
      let saved = null;
      if (sealStore || win.indexedDB) {
        try { saved = await privateSealStore.load(); }
        catch { if (!disposed && token === sealOperation) sealStorageWarning = '保存済みの社印を確認できません。画像の一時利用は可能ですが、ブラウザ内の旧保存は未確認です。'; }
      }
      if (disposed || token !== sealOperation) return;
      if (saved) replaceSeal(saved, true);
      else {
        const standard = await loadDefaultSeal(doc);
        if (!disposed && token === sealOperation) replaceSeal(standard, false, true);
      }
    } catch {
      if (!disposed && token === sealOperation) { if(!initialPreparation&&!restoringSeal)refresh(); showSealError('標準の社印を読み込めません。再読み込みするか、透過PNGを選んでください。PDFはまだ作成できません。'); }
    } finally {
      // A pagehide invalidates the old load. Its completion must not permanently
      // reject startup; the restored page's load owns the readiness result.
      if (!disposed && token === sealOperation) {
        sealLoading = false; setSealBusy(false);
        if(!seal||sealError||sealStorageWarning) rejectReady(Object.assign(new Error(sealError||sealStorageWarning||'社印の準備が完了しませんでした。'),{code:'startup-seal'}));
        else if(sealStorageWarning)rejectReady(Object.assign(new Error(sealStorageWarning),{code:'startup-seal'}));else resolveReady();
      }
    }
  }
  function invalidateSealPDF() { revision++; sealRevision++; retireGenerated(); }
  async function changeSealFile(file) {
    if (!file || sealBusy) return;
    invalidateSealPDF();
    const token = ++sealOperation; setSealBusy(true);
    try {
      const next = validateCanonicalSeal(await prepareSeal(file, doc));
      if (disposed || token !== sealOperation) return;
      if (sealPersisted) await privateSealStore.remove();
      if (disposed || token !== sealOperation) return;
      replaceSeal(next, false);
    } catch (error) { if (!disposed && token === sealOperation) showSealError(error.message || '社印の画像を読み取れません。'); }
    finally { if (!disposed && token === sealOperation) { setSealBusy(false); const input = host.querySelector('#invoice-seal-file'); if (input) input.value = ''; } }
  }
  async function persistSeal(checked) {
    if (sealBusy || !seal || sealIsDefault) return;
    const token = ++sealOperation; setSealBusy(true);
    try {
      if (checked) await privateSealStore.save(seal); else await privateSealStore.remove();
      if (disposed || token !== sealOperation) return;
      sealPersisted = checked; sealStorageWarning = ''; refresh();
    } catch (error) { if (!disposed && token === sealOperation) { host.querySelector('#invoice-seal-persist').checked = sealPersisted; showSealError(error.message || '社印を保存できませんでした。'); } }
    finally { if (!disposed && token === sealOperation) setSealBusy(false); }
  }
  async function removeSeal() {
    if (sealBusy) return;
    invalidateSealPDF();
    const token = ++sealOperation; setSealBusy(true);
    try {
      const standard = validateCanonicalSeal(await loadDefaultSeal(doc));
      if (!standard) throw new Error('標準の社印を読み込めません。');
      if (disposed || token !== sealOperation) return;
      if (sealPersisted || sealStorageWarning) await privateSealStore.remove();
      sealStorageWarning = '';
      if (disposed || token !== sealOperation) return;
      replaceSeal(standard, false, true);
    } catch (error) { if (!disposed && token === sealOperation) showSealError(error.message || '保存した社印を解除できません。'); }
    finally { if (!disposed && token === sealOperation) setSealBusy(false); }
  }
  function retireGenerated() {
    const url = generated?.url;
    generated = null;
    const result = host.querySelector('#invoice-save-result');
    if (result) { result.replaceChildren(); result.hidden = true; }
    if (url) { const status = host.querySelector('#invoice-download-status'); if (status) status.textContent = ''; }
    if (!url || !downloadURLs.has(url) || downloadURLs.get(url) !== null) return;
    // Remove the stale link now, but give any already-started Safari download
    // time to finish consuming it. Active, visible links have no expiry timer.
    const timer = win.setTimeout(() => { win.URL.revokeObjectURL(url); downloadURLs.delete(url); }, 60000);
    downloadURLs.set(url, timer);
  }
  const deliver = savePDF || ((blob, filename, snapshot) => {
    retireGenerated();
    const url = win.URL.createObjectURL(blob), anchor = doc.createElement('a');
    generated = { url, snapshot }; downloadURLs.set(url, null);
    anchor.id = 'invoice-save-link'; anchor.className = 'button primary';
    anchor.href = url; anchor.download = filename; anchor.textContent = 'PDFを保存';
    const result = host.querySelector('#invoice-save-result'); result.replaceChildren(anchor); result.hidden = false;
    // Preserve the one-click path where supported. The same real, visible
    // download link remains available for a fresh user gesture on Safari.
    try { anchor.click(); } catch { /* The visible save link is the fallback. */ }
  });
  function setBusy(value) {
    busy = value;
    const count = (() => { try { return build(controlsSelection()).count; } catch { return 0; } })();
    for (const id of ['invoice-download', 'invoice-print']) { const button = host.querySelector(`#${id}`); if (button) button.disabled = value || previewLoading || !previewValidated || sealBusy || !seal || !count; }
    const button = host.querySelector('#invoice-download'); if (button) { button.textContent = value ? 'PDFを作成中…' : 'PDFをダウンロード'; button.setAttribute('aria-busy', String(value)); }
  }
  function renderNow() {
    if (disposed) return;
    retireGenerated();
    revision++;
    let settings, error;
    try { settings = validateInvoiceSettings(getInvoiceSettings()); } catch (failure) { error = failure; settings = emptyInvoiceSettings(); }
    const view = buildInvoicePreview(getState(), selection, settings);
    selection = { month: view.month, customerId: view.customer?.id, issueDate: view.issueDate, documentType: view.documentType, includeMonthlyDetail: view.includeMonthlyDetail };
    const sealOptionsOpen = host.querySelector('#invoice-seal-options')?.open;
    host.innerHTML = renderInvoiceOutput(getState(), selection, settings, { seal, persisted: sealPersisted, isDefault: sealIsDefault, storageWarning: sealStorageWarning, connected:Boolean(validateOutput) }); setSealBusy(sealBusy);
    if (sealOptionsOpen) host.querySelector('#invoice-seal-options').open = true;
    if (sealError) showSealError(sealError);
    if (error) showError(error.message || '自社情報・請求先住所を読み取れません。', true);
  }
  function invalidate() {
    if(disposed)return;previewEpoch++;authoritySnapshot=null;previewValidated=!validateOutput;retireGenerated();revision++;
    if(validateOutput){host.querySelector('#invoice-preview')?.replaceChildren();setBusy(busy);}
  }
  function refresh() {
    initialPreparation=false;
    if(validateOutput&&host.hidden){invalidate();return Promise.resolve({ok:true,deferred:true});}
    return refreshValidated(validateOutput);
  }
  async function refreshPreparedSnapshot(authority) {
    initialPreparation=false;invalidate();restoreSeal();const request=previewEpoch;
    await sealRestorePromise;
    if(disposed||request!==previewEpoch||doc.visibilityState==='hidden'||host.hidden)return {error:Error('帳票の確認が更新されました。')};
    if(sealError||sealStorageWarning||!seal)return {error:Object.assign(Error('社印の準備が完了しませんでした。'),{code:'startup-seal'})};
    if(!validateOutput||!coordinatedRestoration||typeof authority?.consume!=='function')return {error:Error('帳票の確認が更新されました。')};
    return refreshValidated(()=>authority.consume());
  }
  function refreshValidated(validate) {
    if(!validate)return renderNow();
    invalidate();const request=previewEpoch;previewLoading=true;setBusy(busy);
    const pendingView=host.querySelector('#invoice-preview');if(pendingView)pendingView.textContent='最新の記録を確認しています…';
    return (async()=>{try{
      if(disposed||doc.visibilityState==='hidden')throw Error('画面に戻って再試行してください。');
      const validation=validate();
      // A prepared one-shot authority is synchronous: do not yield between its
      // UID/epoch/key check and rendering the corresponding in-memory snapshot.
      const authority=validation&&typeof validation.then==='function'?await validation:validation;
      if(disposed||request!==previewEpoch||doc.visibilityState==='hidden')throw Error('帳票の確認が更新されました。');
      authoritySnapshot=authority;previewValidated=true;renderNow();return{ok:true};
    }catch(error){if(!disposed&&request===previewEpoch){previewValidated=false;renderNow();showError(error.message,true);}return{error};}finally{if(!disposed&&request===previewEpoch){previewLoading=false;setBusy(busy);}}})();
  }
  function showError(message, invalid = false) {
    const error = host.querySelector('#invoice-error'); if (!error) return;
    error.textContent = message; error.hidden = false;
    if (invalid) {
      retireGenerated();
      revision++;
      for (const id of ['invoice-print', 'invoice-download']) host.querySelector(`#${id}`).disabled = true;
      host.querySelector('#invoice-preview').innerHTML = '<div class="empty-state">対象年月・発行日・出力の種類を確認すると、プレビューを表示します。</div>';
    }
  }
  function controlsSelection() {
    return { month: host.querySelector('#invoice-month')?.value || '', customerId: host.querySelector('#invoice-customer')?.value, issueDate: host.querySelector('#invoice-issue-date')?.value || '', documentType: host.querySelector('#invoice-document-type')?.value || 'invoice', includeMonthlyDetail: Boolean(host.querySelector('#invoice-include-detail')?.checked) };
  }
  const updateIssueDateLabel = event => {
    if (event.target.id === 'invoice-issue-date') { const label = host.querySelector('#invoice-issue-date-formatted'); if (label) label.textContent = issueDateLabel(event.target.value); }
  };
  const change = event => {
    if (event.target.id === 'invoice-seal-file') { void changeSealFile(event.target.files?.[0]); return; }
    if (event.target.id === 'invoice-seal-persist') { void persistSeal(event.target.checked); return; }
    if (!['invoice-month', 'invoice-customer', 'invoice-issue-date', 'invoice-document-type', 'invoice-include-detail'].includes(event.target.id)) return;
    updateIssueDateLabel(event);
    const focusId = event.target.id;
    const next = controlsSelection();
    try { build(next); selection = next; refresh(); host.querySelector(`#${focusId}`).focus(); }
    catch (error) { showError(error.message, true); }
  };
  const click = async event => {
    if (event.target.closest('#invoice-seal-remove')) { await removeSeal(); return; }
    const saveLink = event.target.closest('#invoice-save-link');
    if (saveLink) {
      if(validateOutput&&!authorizedDownload){event.preventDefault();const saved=generated;try{await validateOutput(authoritySnapshot);if(disposed||doc.visibilityState==='hidden'||host.hidden||saved!==generated)return;authorizedDownload=true;saveLink.click();}catch(error){retireGenerated();showError(error.message,true);}finally{authorizedDownload=false;}return;}

      let current = false;
      try { current = !disposed && !sealBusy && !host.hidden && Boolean(generated) && saveLink.getAttribute('href') === generated.url && JSON.stringify(build(controlsSelection())) === generated.snapshot; } catch { /* Invalid selection is stale. */ }
      if (!current) {
        event.preventDefault(); retireGenerated();
        host.querySelector('#invoice-download-status').textContent = '';
        showError('対象や記録が変わりました。最新の内容でPDFを作り直してください。');
      }
      return;
    }
    const button = event.target.closest('#invoice-print, #invoice-download');
    if (!button || button.disabled || busy || sealBusy || !seal) return;
    try {
      const chosen=JSON.stringify(controlsSelection());
      if(validateOutput){setBusy(true);authoritySnapshot=await validateOutput();if(disposed||doc.visibilityState==='hidden'||host.hidden)return;if(chosen!==JSON.stringify(controlsSelection()))throw Error('対象が変わりました。再試行してください。');}
      renderNow();
      const view = build();
      if (!view.count) return;
      if (button.id === 'invoice-print') {const original=JSON.stringify(view);if(validateOutput)await validateOutput(authoritySnapshot);if(disposed||doc.visibilityState==='hidden'||host.hidden)return;if(original!==JSON.stringify(build(controlsSelection())))throw Error('対象が変わりました。再試行してください。');authorizedPrint=true;doc.body.classList.add('invoice-printing');try{print();}finally{authorizedPrint=false;}return;}
      const started = revision, snapshot = JSON.stringify(view);
      setBusy(true);
      host.querySelector('#invoice-download-status').textContent = 'PDFを作成しています。';
      const blob = await createPDF(view, doc);
      if(validateOutput)await validateOutput(authoritySnapshot);
      if (disposed || host.hidden || doc.visibilityState==='hidden') return;
      if (sealBusy || revision !== started || JSON.stringify(build()) !== snapshot) {
        host.querySelector('#invoice-download-status').textContent = '';
        showError('作成中に対象や記録が変わりました。最新の内容を確認して、もう一度PDFを作成してください。'); return;
      }
      await deliver(blob, `${view.documentType === 'monthly-detail' ? 'monthly-detail' : 'invoice'}-sample-${view.month}.pdf`, snapshot);
      if (disposed) return;
      host.querySelector('#invoice-download-status').textContent = savePDF ? 'PDFを作成しました。' : 'PDFを作成しました。保存が始まらない場合は「PDFを保存」を押してください。';
    } catch (error) {
      finishPrint();
      if (!disposed) { host.querySelector('#invoice-download-status').textContent = ''; showError(error?.message || 'PDFを作成できませんでした。印刷からの保存もお試しください。'); }
    } finally { if (!disposed) setBusy(false); }
  };
  function finishPrint() { doc.body.classList.remove('invoice-printing'); }
  function beforePrint() {
    if(validateOutput){if(!authorizedPrint){finishPrint();host.querySelector('#invoice-preview')?.replaceChildren();}return;}
    if (host.hidden || sealBusy || !seal || !host.querySelector('.invoice-paper')) { finishPrint(); return; }
    try { refresh(); doc.body.classList.toggle('invoice-printing', build().count > 0); } catch { finishPrint(); }
  }
  const printMediaChange = event => { if (!event.matches) finishPrint(); };
  const settingsChanged = event => { if (!disposed && event.detail?.storageKey === storageKey) refresh(); };
  const storageChanged = event => { if(validateOutput)return; if (!disposed && (event.key === storageKey || event.key === null)) refresh(); };
  doc.addEventListener('invoice-settings-change', settingsChanged); win.addEventListener('storage', storageChanged);
  host.addEventListener('input', updateIssueDateLabel); host.addEventListener('change', change); host.addEventListener('click', click);
  win.addEventListener('beforeprint', beforePrint); win.addEventListener('afterprint', finishPrint);
  printMedia?.addEventListener('change', printMediaChange);
  const clearSealMemory = () => { initialPreparation=false;sealNeedsReload=true;sealOperation++; seal = null; sealIsDefault = false; sealError = ''; sealPersisted = false; sealRevision++; sealBusy = true; sealLoading = true; retireGenerated(); host.querySelectorAll('[data-invoice-seal]').forEach(element => element.remove()); const input = host.querySelector('#invoice-seal-file'); if (input) input.value = ''; setSealBusy(true); };
  const restoreSeal = () => { if (!disposed && sealNeedsReload && doc.visibilityState!=='hidden') { sealNeedsReload=false;restoringSeal=Boolean(validateOutput&&coordinatedRestoration);if(restoringSeal)invalidate();else refresh();sealRestorePromise=loadSavedSeal().finally(()=>{restoringSeal=false;}); } };
  const pageShow = () => restoreSeal();
  win.addEventListener('pagehide', clearSealMemory); win.addEventListener('pageshow', pageShow);
  if(!validateOutput)refresh();
  const cloudHidden=()=>{if(doc.visibilityState!=='hidden')restoreSeal();if(validateOutput&&doc.visibilityState==='hidden'){previewEpoch++;retireGenerated();finishPrint();host.querySelector('#invoice-preview')?.replaceChildren();}};
  doc.addEventListener('visibilitychange',cloudHidden);
  const ready=(async()=>{try{await sealReady;if(validateOutput){const validate=initialPreparation?prepareInitialOutput:validateOutput;initialPreparation=false;const result=await refreshValidated(validate);if(!result?.ok&&result?.error?.code!=='BILLING_NOT_READY')throw result?.error||Error('帳票の準備が完了しませんでした。');}}finally{initialPreparation=false;}})();void ready.catch(()=>{});
  void loadSavedSeal();
  return { ready, refresh, refreshPreparedSnapshot, invalidate, destroy() { doc.removeEventListener('visibilitychange',cloudHidden);previewEpoch++;rejectReady(Object.assign(new Error('起動準備が終了しました。'),{code:'startup-seal'})); disposed = true; revision++; clearSealMemory(); win.removeEventListener('pagehide', clearSealMemory); win.removeEventListener('pageshow', pageShow); doc.removeEventListener('invoice-settings-change', settingsChanged); win.removeEventListener('storage', storageChanged); finishPrint(); retireGenerated(); host.removeEventListener('input', updateIssueDateLabel); host.removeEventListener('change', change); host.removeEventListener('click', click); win.removeEventListener('beforeprint', beforePrint); win.removeEventListener('afterprint', finishPrint); printMedia?.removeEventListener('change', printMediaChange); } };
}

