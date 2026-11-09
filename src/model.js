export const PEOPLE = ['担当者A（架空）', '担当者B（架空）', '担当者C（架空）'];
export const CUSTOMERS = Array.from({ length: 29 }, (_, index) => ({ id: `demo-c${String(index + 1).padStart(3, '0')}`, name: `取引先${String(index + 1).padStart(2, '0')}（架空）` }));
export const STORAGE_KEY = 'routenote-ui-preview:unused-legacy:v1';
export const clone = value => structuredClone(value);
export const customerName = id => CUSTOMERS.find(customer => customer.id === id)?.name ?? '不明な架空取引先';
export class ValidationError extends Error {}
export class DuplicateError extends ValidationError {}
export class ConflictError extends Error {
  constructor(current) {
    super('この記録は、編集中に更新または削除されました。最新の内容を確認してください。');
    this.current = clone(current);
  }
}
// The inspected workbook uses Asia/Tokyo. Input dates and month boundaries follow that calendar.
export function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => parts.find(value => value.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function validateDate(value) {
  const date = String(value ?? '');
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new ValidationError('正しい回収日を入力してください。');
  return date;
}
export function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ValidationError('正しい年月を選択してください。');
  const [year, number] = month.split('-').map(Number);
  return { start: `${month}-01`, end: `${number === 12 ? year + 1 : year}-${String(number === 12 ? 1 : number + 1).padStart(2, '0')}-01` };
}
export function inMonth(record, month) { const { start, end } = monthBounds(month); return record.date >= start && record.date < end; }
function validPerson(value, label) {
  if (!PEOPLE.includes(value)) throw new ValidationError(`${label}を選択してください。`);
  return value;
}
export function optionalDecimal(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  const number = Number(text);
  // Provisional technical bounds, not rules inferred from number formatting in the original workbook.
  if (!/^\d+(?:\.\d{1,6})?$/.test(text) || !Number.isFinite(number) || number < 0 || number > 1_000_000_000) throw new ValidationError(`${label}は0〜1,000,000,000、小数6桁以内で入力してください（試作の仮仕様）。`);
  return number;
}
export function validateFields(input) {
  const date = validateDate(input.date);
  if (!CUSTOMERS.some(customer => customer.id === input.customerId)) throw new ValidationError('取引先を選択してください。');
  const combustibleKg = optionalDecimal(input.combustibleKg, '可燃の重量');
  const noncombustibleKg = optionalDecimal(input.noncombustibleKg, '不燃の重量');
  const otherFee = optionalDecimal(input.otherFee, 'その他料金');
  const otherItem = String(input.otherItem ?? '').trim();
  if (otherItem.length > 500) throw new ValidationError('その他品名は500文字以内で入力してください。');
  if (combustibleKg === null && noncombustibleKg === null && otherFee === null && !otherItem) throw new ValidationError('選択した取引先には、重量・その他品名・その他料金のいずれかを入力してください。0は入力値として扱います。');
  return { date, customerId: input.customerId, combustibleKg, noncombustibleKg, otherItem, otherFee };
}
function auditEvent(action, before, after, actor, now, id) {
  return { id, recordId: (after ?? before).id, action, actor, timestamp: now, version: (after ?? before).version, before: clone(before), after: clone(after) };
}
function ensureUnique(state, fields, exceptId) {
  if (state.records.some(record => !record.deleted && record.id !== exceptId && record.date === fields.date && record.customerId === fields.customerId)) throw new DuplicateError(`${fields.date}・${customerName(fields.customerId)}の記録がすでにあります。一覧から既存記録を編集してください。同日複数回の記録にはまだ対応していないため、自動追加・上書きはしません。`);
}
export function createReport(state, input, actor, { now = new Date().toISOString(), id = crypto.randomUUID() } = {}) {
  validPerson(actor, '今回の入力者・編集者');
  const createdBy = validPerson(input.createdBy, '報告者（作成者）');
  const fields = validateFields(input);
  ensureUnique(state, fields);
  if (state.records.some(record => record.id === id)) throw new ValidationError('記録IDが重複しています。');
  const record = { ...fields, id, createdBy, lastEditedBy: actor, createdAt: now, updatedAt: now, version: 1, deleted: false };
  return { state: { ...clone(state), records: [...clone(state.records), record], history: [...clone(state.history), auditEvent('create', null, record, actor, now, `${id}:1`)] }, record: clone(record) };
}
export function createBatch(state, input, actor, { now = new Date().toISOString(), idFactory = () => crypto.randomUUID() } = {}) {
  validPerson(actor, '今回の入力者・編集者');
  validPerson(input.createdBy, '報告者（作成者）');
  const date = validateDate(input.date);
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new ValidationError('入力する取引先を1件以上選択してください。');
  let next = clone(state); const records = [];
  for (const row of input.rows) {
    try {
      const result = createReport(next, { ...row, date, createdBy: input.createdBy }, actor, { now, id: idFactory() });
      next = result.state; records.push(result.record);
    } catch (error) { error.customerId = row.customerId; error.message = `${customerName(row.customerId)}：${error.message}`; throw error; }
  }
  // Return only after every row validates. Caller commits this batch in one local write.
  return { state: next, record: { count: records.length, records } };
}
export function updateReport(state, id, expectedVersion, input, actor, { now = new Date().toISOString() } = {}) {
  validPerson(actor, '今回の入力者・編集者');
  const current = state.records.find(record => record.id === id);
  if (!current || current.deleted || current.version !== expectedVersion) throw new ConflictError(current ?? null);
  const fields = validateFields(input); ensureUnique(state, fields, id);
  const next = { ...current, ...fields, lastEditedBy: actor, updatedAt: now, version: current.version + 1 };
  return { state: { ...clone(state), records: state.records.map(record => record.id === id ? next : clone(record)), history: [...clone(state.history), auditEvent('update', current, next, actor, now, `${id}:${next.version}`)] }, record: clone(next) };
}
export function deleteReport(state, id, expectedVersion, actor, { now = new Date().toISOString() } = {}) {
  validPerson(actor, '削除する人');
  const current = state.records.find(record => record.id === id);
  if (!current || current.deleted || current.version !== expectedVersion) throw new ConflictError(current ?? null);
  const next = { ...current, deleted: true, lastEditedBy: actor, updatedAt: now, version: current.version + 1 };
  return { state: { ...clone(state), records: state.records.map(record => record.id === id ? next : clone(record)), history: [...clone(state.history), auditEvent('delete', current, next, actor, now, `${id}:${next.version}`)] }, record: clone(next) };
}
export function sumField(records, field) {
  let micros = 0n;
  for (const record of records) {
    if (record[field] === null) continue;
    const [whole, fraction] = record[field].toFixed(6).split('.');
    micros += BigInt(whole) * 1_000_000n + BigInt(fraction);
  }
  const fraction = String(micros % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return `${micros / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
export function sampleState(today = new Date()) {
  let state = { schema: 2, records: [], history: [] };
  const day = localDate(today); const previous = new Date(`${day}T12:00:00+09:00`); previous.setDate(previous.getDate() - 1);
  const [year, month] = day.slice(0, 7).split('-').map(Number);
  const earlierMonth = `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, '0')}-15`;
  const samples = [
    { id: 'demo-001', date: day, customerId: CUSTOMERS[0].id, combustibleKg: 12.5, noncombustibleKg: 3, otherItem: '', otherFee: null, createdBy: PEOPLE[0] },
    { id: 'demo-002', date: day, customerId: CUSTOMERS[1].id, combustibleKg: 8, noncombustibleKg: 0, otherItem: '架空の備品', otherFee: 300, createdBy: PEOPLE[1] },
    { id: 'demo-003', date: localDate(previous), customerId: CUSTOMERS[2].id, combustibleKg: null, noncombustibleKg: 5.25, otherItem: '', otherFee: null, createdBy: PEOPLE[2] },
    { id: 'demo-004', date: earlierMonth, customerId: CUSTOMERS[0].id, combustibleKg: 99, noncombustibleKg: 0, otherItem: '前月を除外する架空テスト用', otherFee: 0, createdBy: PEOPLE[0] }
  ];
  for (const input of samples) state = createReport(state, input, input.createdBy, { id: input.id, now: new Date(`${input.date}T09:00:00+09:00`).toISOString() }).state;
  state = updateReport(state, 'demo-002', 1, { ...samples[1], otherItem: '架空の備品（確認済み）' }, PEOPLE[2], { now: new Date(`${day}T11:20:00+09:00`).toISOString() }).state;
  return state;
}
export function restoreReport(state, id, expectedVersion, actor, { now = new Date().toISOString() } = {}) {
  validPerson(actor, '復元する人');
  const current = state.records.find(record => record.id === id);
  if (!current || !current.deleted || current.version !== expectedVersion) throw new ConflictError(current ?? null);
  ensureUnique(state, current, id);
  const next = { ...current, deleted: false, lastEditedBy: actor, updatedAt: now, version: current.version + 1 };
  return { state: { ...clone(state), records: state.records.map(record => record.id === id ? next : clone(record)), history: [...clone(state.history), auditEvent('restore', current, next, actor, now, `${id}:${next.version}`)] }, record: clone(next) };
}
