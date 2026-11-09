import { INVOICE_BANK_TYPES } from './invoice-settings.js';
import { validateCanonicalSeal } from './invoice-seal.js';
// Same relative position as the B5 printed example: issuer block, right side.
export const INVOICE_SEAL_BOX = Object.freeze({ x: 131, y: 68, width: 20, height: 20 });
// Printed-photo layout. Identity is optional, explicitly configured, and local only.
// Coordinates are millimetres. JIS B5 is provisional within the user's B5 request.
export const INVOICE_GEOMETRY = Object.freeze({
  pageWidth: 182, pageHeight: 257, pdfWidth: 182 * 72 / 25.4, pdfHeight: 257 * 72 / 25.4,
  pixelWidth: 182 * 96 / 25.4, pixelHeight: 257 * 96 / 25.4,
  left: 29, right: 153, columns: Object.freeze([56, 15, 13, 13, 27]),
  detailLeft: 25, detailTop: 41, detailColumns: Object.freeze([27, 25, 25, 27, 28]), detailRowHeight: 5.2
});
const FONT = 'Arial, "MS PGothic", "Yu Gothic", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", sans-serif';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeText = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
const num = value => value === null ? '算出不可' : String(value).replace(/^(\d+)(.*)$/, (_, integer, fraction) => integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fraction);
const sum = values => values.reduce((a, b) => a + b, 0);
const widthOf = text => [...safeText(text)].reduce((width, c) => width + (/^[\x20-\x7e]$/.test(c) ? 0.56 : 1), 0);
const text = (key, value, x, y, extra = {}) => ({ key, text: safeText(value), x, y, size: 3.2, ...extra });
const line = (x1, y1, x2, y2, width = 0.22) => ({ x1, y1, x2, y2, width });
const weightText = item => item.missing ? '不明' : item.value === null ? '' : num(item.value);
const quantityText = item => item.quantityMissing ? '不明' : item.quantity === null ? '未入力' : num(item.quantity);
function eraDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  const yearText = year > 2019 || (year === 2019 && month >= 5) ? `令和${year - 2018}年` : `${year}年`;
  return `${yearText}${month}月${day}日`;
}
function wrap(value, maxChars = 48) {
  const result = [];
  for (const paragraph of safeText(value).replace(/\r\n?/g, '\n').split('\n')) {
    const chars = [...paragraph];
    if (!chars.length) result.push('');
    for (let i = 0; i < chars.length; i += maxChars) result.push(chars.slice(i, i + maxChars).join(''));
  }
  return result;
}
// Every line uses the same left origin, including company/name lines. Leading
// placeholder brackets and whitespace created a visible half-glyph indent.
function identityCells(view) {
  const issuer = view.issuer || {}, recipient = view.recipient || {};
  const value = item => safeText(item).trim();
  const postal = item => value(item) ? `〒${value(item).replace(/^〒\s*/, '')}` : '郵便番号 未設定';
  const address = (item, missing) => value(item) ? value(item).split('\n').map(line => line.trim()) : [missing];
  const recipientLines = [
    ['recipient-postal', postal(recipient.postalCode)],
    ...address(recipient.address, '宛先住所 未設定').map((line, i) => [i ? `recipient-address-${i + 1}` : 'recipient-address', line]),
    ['recipient', `${value(view.customer.name)}　御中`]
  ];
  const issuerLines = [
    ['issuer-postal', postal(issuer.postalCode)],
    ...address(issuer.address, '発行者住所 未設定').map((line, i) => [i ? `issuer-address-${i + 1}` : 'issuer-address', line]),
    ['issuer', value(issuer.tradeName) || '会社名・屋号 未設定'],
    ['issuer-name', value(issuer.legalName) || '法人名・氏名 未設定'],
    ['issuer-registration', `登録番号：${value(issuer.registrationNumber) || '未設定'}`]
  ];
  return [
    ...recipientLines.map(([key, value], i) => text(key, value, INVOICE_GEOMETRY.left, 40 + i * (16 / (recipientLines.length - 1)), { maxWidth: 79, size: key === 'recipient' ? 3.6 : 3.2, align: 'left', forceFit: true })),
    ...issuerLines.map(([key, value], i) => text(key, value, 96, 62 + i * (28 / (issuerLines.length - 1)), { maxWidth: 65, bold: key === 'issuer-name', align: 'left', forceFit: true }))
  ];
}
function bankCells(view) {
  return [0, 1].flatMap(index => {
    const account = view.bankAccounts?.[index] || {};
    const configured = Object.values(account).some(value => String(value || '').trim());
    if (!configured) return [text(`bank-${index + 1}`, `振込先${index + 1}　金融機関・支店・口座情報：未設定`, INVOICE_GEOMETRY.left, index ? 243 : 236, { size: 2.9, maxWidth: 124, bold: true, forceFit: true })];
    const value = key => safeText(account[key]).trim() || '未設定';
    return [text(`bank-${index + 1}`, `振込先${index + 1}　${value('bankName')}　${value('branchName')}　${INVOICE_BANK_TYPES[account.accountType] || '口座種別 未設定'}`, INVOICE_GEOMETRY.left, index ? 242 : 233, { size: 2.9, maxWidth: 124, bold: true, forceFit: true }),
      text(`bank-${index + 1}-account`, `口座番号：${value('accountNumber')}　口座名義：${value('accountHolder')}`, INVOICE_GEOMETRY.left, index ? 246 : 237, { size: 2.6, maxWidth: 124, forceFit: true })];
  });
}
function invoicePage(view, hasNotes) {
  const { left, right, columns } = INVOICE_GEOMETRY;
  const cells = [
    text('title', '請求書', 91, 25, { size: 3.8, align: 'center' }),
    text('issue-date', eraDate(view.issueDate), 157, 33, { align: 'right' }),
    ...identityCells(view),
    text('total-label', 'ご請求金額　¥', left, 100),
    text('total-top', '—', 81, 100, { align: 'right' })
  ];
  const rules = [line(left, 102, 82, 102), line(left, 114, right, 114), line(left, 191, right, 191), line(98, 199, right, 199)];
  const headers = ['品名', '単価', '数量', '単位', '価格'];
  headers.forEach((value, i) => {
    const start = left + sum(columns.slice(0, i)), width = columns[i];
    cells.push(text(`header-${i}`, value, i === 0 ? start : i === 4 ? start + width : start + width / 2, 112, { align: i === 0 ? 'left' : i === 4 ? 'right' : 'center' }));
  });
  const otherAmount = view.other.entered ? num(view.other.amount) : '未入力';
  const lineRows = [[`特別清掃運搬料（${Number(view.month.slice(5))}月分）`, otherAmount, view.other.entered ? '1' : '—', '式', otherAmount],
    ...view.lines.map((item, i) => [`処理手数料　${i === 0 ? '可燃' : '不燃'}`, !item.entered ? '未入力' : item.missing ? '不明あり' : item.rates.length === 1 ? num(item.rates[0]) : '複数単価', quantityText(item), 'kg', !item.entered ? '未入力' : num(item.amount)])];
  lineRows.forEach((values, row) => values.forEach((value, col) => {
    const start = left + sum(columns.slice(0, col)), width = columns[col];
    cells.push(text(`line-${row}-${col}`, value, col === 0 || col === 3 ? start : start + width - 1, 120 + row * 7, { maxWidth: width - 2, align: col === 0 || col === 3 ? 'left' : 'right', bold: col === 0 }));
  }));
  if (hasNotes) cells.push(text('notes-reference', '※品目・回収時の備考は別紙をご参照ください。', left, 174, { size: 2.6, maxWidth: 124 }));
  cells.push(text('subtotal-label', '参考小計（記録料金のみ）', left, 184, { size: 2.6 }),
    text('subtotal', view.recordedCharges === null ? '算出不可' : `${num(view.recordedCharges)} 円`, 92, 184, { size: 2.6, align: 'right', maxWidth: 30 }),
    text('total-bottom-label', '合計', 99, 197), text('total-bottom', '—', right, 197, { align: 'right' }),
    text('tax-title', '税率別内訳', left, 205, { bold: true }),
    text('tax-net-label', '税抜金額', left, 212), text('tax-net', '—', 84, 212, { align: 'right' }),
    text('tax-label', '消費税額', left, 219, { size: 2.9, maxWidth: 43 }), text('tax-value', '—', 84, 219, { align: 'right', size: 2.9 }),
    text('tax-inclusive-label', '税込金額', left, 226), text('tax-inclusive', '—', 84, 226, { align: 'right' }),
    ...bankCells(view),
    text('draft-note', view.currentSourceReference?'参考：旧記録は現在のシート単価。過去単価未確認。正式請求・振込には使用不可。':'見本：税計算は未実装です。正式な請求・振込には使用できません。', left, 250, { size: 2.2, maxWidth: 124 }));
  [207, 214, 221, 228].forEach(y => rules.push(line(left, y, 85, y)));
  return { kind: 'invoice', cells, rules, seal: validateCanonicalSeal(view.seal ?? null) };
}
function monthlyPage(view) {
  const g = INVOICE_GEOMETRY, left = g.detailLeft, top = g.detailTop, widths = g.detailColumns, right = left + sum(widths), rowHeight = g.detailRowHeight;
  const cells = [text('detail-recipient', `${view.customer.name}　御中`, 91, 27, { size: 4.5, bold: true, align: 'center', maxWidth: 132 }),
    text('detail-period', `月間回収明細　${view.label}`, 91, 36, { size: 2.7, align: 'center' })];
  const rules = [line(49, 30, 133, 30, 0.3), line(49, 30.8, 133, 30.8, 0.3)];
  const bodyTop = top + 9, bodyBottom = bodyTop + view.daily.length * rowHeight, bottom = bodyBottom + 12;
  [left, ...widths.map((_, i) => left + sum(widths.slice(0, i + 1)))].forEach(x => rules.push(line(x, top, x, bottom, x === left || x === right ? 0.5 : 0.22)));
  rules.push(line(left, top, right, top, 0.5), line(left, bodyTop, right, bodyTop, 0.32), line(left, bottom, right, bottom, 0.5));
  const headers = [['日付', ''], ['可燃物', '（kg）'], ['不燃物', '（kg）'], ['その他料金', '（円）'], ['合計重量', '（kg）']];
  headers.forEach(([value, unit], i) => {
    const x = left + sum(widths.slice(0, i)) + widths[i] / 2;
    cells.push(text(`detail-header-${i}`, value, x, top + 3.7, { size: 3.1, align: 'center' }));
    if (unit) cells.push(text(`detail-unit-${i}`, unit, x, top + 7.2, { size: 2.6, align: 'center' }));
  });
  view.daily.forEach((day, i) => {
    const y = bodyTop + (i + 1) * rowHeight;
    rules.push(line(left, y, right, y, i === view.daily.length - 1 ? 0.4 : 0.18));
    const values = [`${Number(view.month.slice(5))}月${Number(day.date.slice(8))}日`, weightText(day.combustible), weightText(day.noncombustible), weightText(day.other), weightText(day.weight)];
    values.forEach((value, col) => cells.push(text(`day-${i + 1}-${col}`, value, left + sum(widths.slice(0, col + 1)) - 1.3, y - 1.2, { size: 3.3, align: 'right', maxWidth: widths[col] - 2.6, bold: col === 4 })));
  });
  const weightValues = ['合計重量', ...view.lines.map(item => item.quantityMissing ? '不明' : item.quantity === null ? '' : num(item.quantity)), '', weightText(view.totalWeight)];
  const amountValues = ['参考金額', ...view.lines.map(item => !item.entered ? '' : num(item.amount)), !view.other.entered ? '' : num(view.other.amount), view.recordedCharges === null ? '算出不可' : `¥${num(view.recordedCharges)}`];
  [weightValues, amountValues].forEach((values, row) => values.forEach((value, col) => cells.push(text(`detail-total-${row}-${col}`, value, col === 0 ? left + 0.8 : left + sum(widths.slice(0, col + 1)) - 1.3, bodyBottom + 4.5 + row * 6, { size: 3.3, maxWidth: widths[col] - 2.6, align: col === 0 ? 'left' : 'right', bold: col === 0 || col === 4 }))));
  rules.push(line(left, bodyBottom + 6, right, bodyBottom + 6, 0.28));
  const otherX = left + sum(widths.slice(0, 3));
  rules.push(line(otherX, bodyBottom + 6, otherX + widths[3], bodyBottom, 0.25));
  cells.push(text('detail-unit-note', '写真の「粗大ごみ」は単位未確認のため、保存済みのその他料金（円）を表示。', left, bottom + 7, { size: 2.3, maxWidth: 132 }),
    text('detail-weight-note', '合計重量は可燃物＋不燃物のみ。その他料金を重量に加算しません。', left, bottom + 11.5, { size: 2.3, maxWidth: 132 }),
    text('detail-amount-note', view.currentSourceReference?'参考金額は現在のシート単価を含み、過去単価未確認。基本料・税を含まず、端数処理前。':'参考金額の行は円。基本料・税を含まず、端数処理前。空欄は未入力、不明は欠損あり。', left, bottom + 16, { size: 2.2, maxWidth: 132 }));
  return { kind: 'monthly-detail', cells, rules };
}

export function buildInvoiceDocument(view) {
  if (!view.customer) return { pages: [], notes: [], geometry: INVOICE_GEOMETRY };
  const notes = [...view.lines, view.other].flatMap(item => item.details.map(note => ({ category: item.title, date: note.date, text: note.text, missing: note.amount === null })));
  const pages = view.documentType === 'monthly-detail' ? [monthlyPage(view)] : [invoicePage(view, notes.length > 0)];
  if (view.documentType === 'invoice' && view.includeMonthlyDetail) pages.push(monthlyPage(view));
  const lines = notes.flatMap(note => [note.category, ...wrap(`${note.date.slice(8)}日: ${note.text}${note.missing ? '（金額未入力）' : ''}`), '']);
  for (let i = 0; i < lines.length; i += 38) {
    const cells = [text('notes-title', `備考別紙　${view.label}`, 15, 24, { size: 4.5, bold: true }), text('notes-recipient', view.customer.name, 15, 32, { size: 3.3, maxWidth: 152 }),
      ...lines.slice(i, i + 38).map((value, row) => text(`note-${i + row}`, value, 15, 43 + row * 5, { size: 3.1, maxWidth: 152, forceFit: true }))];
    pages.push({ kind: 'notes', cells, rules: [] });
  }
  return { pages, notes, geometry: INVOICE_GEOMETRY, customerName: view.customer.name, month: view.label };
}
function textSVG(item) {
  const { text: value, x, y, size = 3.2, bold, align = 'left', key = '', maxWidth, forceFit = false } = item;
  const fitted = value.length > 0 && maxWidth && (forceFit || widthOf(value) * size > maxWidth);
  const fittedWidth = forceFit ? Math.min(maxWidth, widthOf(value) * size) : maxWidth;
  return `<text x="${x}" y="${y}" xml:space="preserve" font-size="${size}"${bold ? ' font-weight="700"' : ''} text-anchor="${align === 'right' ? 'end' : align === 'center' ? 'middle' : 'start'}"${key ? ` data-cell="${esc(key)}"` : ''}${fitted ? ` textLength="${fittedWidth}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(value)}</text>`;
}
export function invoicePageSVG(document, index) {
  const page = document.pages[index];
  if (!page) throw new Error('出力ページがありません。');
  const g = INVOICE_GEOMETRY;
  const mark = textSVG(text('', 'SAMPLE ・ 架空データ / 請求には使用できません', 15, 9, { size: 2.2 }));
  const rules = page.rules.map(rule => `<line x1="${rule.x1}" y1="${rule.y1}" x2="${rule.x2}" y2="${rule.y2}" stroke="#000" stroke-width="${rule.width}"/>`).join('');
  const seal = page.kind === 'invoice' ? validateCanonicalSeal(page.seal ?? null) : null;
  const box = INVOICE_SEAL_BOX;
  const sealSVG = seal ? `<image data-invoice-seal="true" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" preserveAspectRatio="xMidYMid meet" href="${seal.dataURL}"/>` : '';
  const label = page.kind === 'invoice' ? '請求書の架空プレビュー' : page.kind === 'monthly-detail' ? '月間回収明細の架空プレビュー' : '備考別紙';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.pageWidth} ${g.pageHeight}" width="${g.pixelWidth}" height="${g.pixelHeight}" role="img" aria-label="${label} ${index + 1} / ${document.pages.length}"><rect width="${g.pageWidth}" height="${g.pageHeight}" fill="white" data-invoice-layer="paper"/>${sealSVG}<g data-invoice-layer="content" fill="#000" font-family="${esc(FONT)}">${mark}${rules}${page.cells.map(textSVG).join('')}${document.pages.length > 1 ? textSVG(text('', `${index + 1} / ${document.pages.length}`, 171, 252, { size: 2.1, align: 'right' })) : ''}</g></svg>`;
}

// Small binary PDF writer: JPEG page images are embedded without re-encoding.
// Non-selectable text is disclosed beside the download control.
export function jpegPagesToPDF(pages) {
  if (!pages.length) throw new Error('PDFにするページがありません。');
  const encoder = new TextEncoder(), chunks = [], offsets = [0];
  let length = 0;
  const append = part => { const bytes = typeof part === 'string' ? encoder.encode(part) : part; chunks.push(bytes); length += bytes.length; };
  const object = (id, parts) => { offsets[id] = length; append(`${id} 0 obj\n`); for (const p of parts) append(p); append('\nendobj\n'); };
  append('%PDF-1.4\n% raster invoice\n');
  object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  object(2, [`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`]);
  pages.forEach((page, i) => {
    if (!(page.jpeg instanceof Uint8Array) || page.jpeg[0] !== 255 || page.jpeg[1] !== 216 || !Number.isInteger(page.width) || page.width < 1 || !Number.isInteger(page.height) || page.height < 1) throw new Error('PDF画像が不正です。');
    const width = INVOICE_GEOMETRY.pdfWidth.toFixed(6), height = INVOICE_GEOMETRY.pdfHeight.toFixed(6);
    const id = 3 + i * 3, content = `q\n${width} 0 0 ${height} 0 0 cm\n/PageImage Do\nQ\n`;
    object(id, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /PageImage ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`]);
    object(id + 1, [`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`, page.jpeg, '\nendstream']);
    object(id + 2, [`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`]);
  });
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (let i = 1; i < offsets.length; i++) append(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const bytes = new Uint8Array(length); let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  return bytes;
}

export async function createInvoicePDF(view, doc = globalThis.document) {
  const document = buildInvoiceDocument(view), win = doc.defaultView;
  if (!document.pages.length) throw new Error('出力する取引先がありません。');
  await doc.fonts?.ready;
  const pages = [];
  // Sequential rasterization bounds memory. data: is allowed by the existing
  // img-src CSP; no blob: permission or remote resource is required for SVG.
  for (let i = 0; i < document.pages.length; i++) {
    const svg = invoicePageSVG(document, i), image = new win.Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve; image.onerror = () => reject(new Error('PDFの文字画像を作成できませんでした。'));
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    const canvas = doc.createElement('canvas');
    canvas.width = Math.round(INVOICE_GEOMETRY.pixelWidth * 2); canvas.height = Math.round(INVOICE_GEOMETRY.pixelHeight * 2);
    try {
      const context = canvas.getContext('2d'); if (!context) throw new Error('PDFの画像出力を利用できません。');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.97));
      if (!blob) throw new Error('PDF画像を保存できませんでした。');
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      pages.push({ jpeg, width: canvas.width, height: canvas.height });
    } finally { canvas.width = canvas.height = 1; image.onload = image.onerror = null; image.removeAttribute?.('src'); }
  }
  return new win.Blob([jpegPagesToPDF(pages)], { type: 'application/pdf' });
}
