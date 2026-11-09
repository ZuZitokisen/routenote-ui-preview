// Private invoice artwork: user-selected PNG -> pixels -> fresh PNG. No network,
// report/settings storage, or persistence is used by preparation/validation.
export const SEAL_LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, side: 4096, pixels: 16000000 });
const PREFIX = 'data:image/png;base64,';
const MAX_URL = PREFIX.length + 4 * Math.ceil(SEAL_LIMITS.bytes / 3);
const DB_NAME = 'routenote-ui-preview:seal:v1';
const STORE = 'private-seal';
export class InvoiceSealError extends Error {
  constructor(message, code) { super(message); this.name = 'InvoiceSealError'; this.code = code; }
}
const invalid = () => new InvoiceSealError('印影は5MB以下・4096×4096以内（1600万画素以下）の有効なPNGを選んでください。', 'invalid-png');
const storageError = () => new InvoiceSealError('印影の端末内保存を利用できません。報告・設定データは変更していません。', 'storage-unavailable');
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > SEAL_LIMITS.side || height > SEAL_LIMITS.side || width * height > SEAL_LIMITS.pixels) throw invalid();
}
function crc(bytes, start, end) {
  let value = 0xffffffff;
  for (let i = start; i < end; i++) {
    value ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}
export function validateSealPNGHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > SEAL_LIMITS.bytes || ![137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12,16)) !== 'IHDR' || view.getUint32(29) !== crc(bytes,12,29)) throw invalid();
  const width = view.getUint32(16), height = view.getUint32(20);
  dimensions(width, height);
  const validDepths = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
  if (!validDepths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) throw invalid();
  return { width, height };
}
function encode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return PREFIX + globalThis.btoa(binary);
}
export function validateCanonicalSeal(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || !['dataURL','width','height'].every(key => Object.hasOwn(value,key))) throw invalid();
  const { dataURL, width, height } = value;
  dimensions(width, height);
  if (typeof dataURL !== 'string' || dataURL.length > MAX_URL || !dataURL.startsWith(PREFIX)) throw invalid();
  const base64 = dataURL.slice(PREFIX.length);
  if (!base64.length || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw invalid();
  let bytes;
  try { bytes = Uint8Array.from(globalThis.atob(base64), c => c.charCodeAt(0)); } catch { throw invalid(); }
  if (encode(bytes) !== dataURL) throw invalid();
  const header = validateSealPNGHeader(bytes);
  if (width !== header.width || height !== header.height) throw invalid();
  // Only raster payload and canvas color-profile chunks are accepted. Reject
  // text/EXIF/animation metadata, trailing bytes, malformed lengths and CRCs.
  const view = new DataView(bytes.buffer); let offset = 33, sawData = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset), end = offset + 12 + size;
    if (end > bytes.length) throw invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!['IDAT','IEND','sRGB','gAMA','cHRM'].includes(type) || view.getUint32(end - 4) !== crc(bytes,offset + 4,end - 4)) throw invalid();
    if (type === 'IDAT') sawData ||= size > 0;
    if (type === 'IEND') { if (size || end !== bytes.length) throw invalid(); ended = true; break; }
    offset = end;
  }
  if (!sawData || !ended) throw invalid();
  return { dataURL, width, height };
}
export async function prepareInvoiceSeal(file, doc = globalThis.document) {
  if (!file || typeof file !== 'object' || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 33 || file.size > SEAL_LIMITS.bytes || (file.type && file.type !== 'image/png')) throw invalid();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw invalid();
  const expected = validateSealPNGHeader(bytes);
  const ImageClass = doc?.defaultView?.Image;
  if (!ImageClass || !doc?.createElement) throw new InvoiceSealError('このブラウザでは印影を処理できません。', 'canvas-unavailable');
  const image = new ImageClass();
  let canvas, output;
  try {
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => { image.onload = image.onerror = null; image.src = ''; reject(invalid()); }, 15000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(invalid()); };
      image.src = encode(bytes);
    });
    if (image.naturalWidth !== expected.width || image.naturalHeight !== expected.height) throw invalid();
    canvas = doc.createElement('canvas'); canvas.width = expected.width; canvas.height = expected.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new InvoiceSealError('印影の画像処理を利用できません。', 'canvas-unavailable');
    ctx.drawImage(image,0,0);
    const pixels = ctx.getImageData(0,0,canvas.width,canvas.height);
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1, hasTransparency = false;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (pixels.data[i + 3] < 255) hasTransparency = true;
      if (pixels.data[i + 3]) { left = Math.min(left,x); top = Math.min(top,y); right = Math.max(right,x); bottom = Math.max(bottom,y); }
      pixels.data[i] = 201; pixels.data[i + 1] = 45; pixels.data[i + 2] = 41;
    }
    if (right < 0) throw new InvoiceSealError('透明な画像だけでは印影を作成できません。', 'empty-image');
    if (!hasTransparency) throw new InvoiceSealError('背景が透明なPNGを選んでください。不透明な画像は印影として使えません。', 'opaque-image');
    ctx.putImageData(pixels,0,0);
    // Crop surplus transparent margins, keeping up to two pixels of padding.
    left = Math.max(0,left - 2); top = Math.max(0,top - 2);
    right = Math.min(canvas.width - 1,right + 2); bottom = Math.min(canvas.height - 1,bottom + 2);
    output = doc.createElement('canvas'); output.width = right - left + 1; output.height = bottom - top + 1;
    const out = output.getContext('2d');
    if (!out) throw new InvoiceSealError('印影の画像処理を利用できません。', 'canvas-unavailable');
    // No rescaling: preserve each original alpha sample exactly.
    out.putImageData(ctx.getImageData(left,top,output.width,output.height),0,0);
    return validateCanonicalSeal({ dataURL: output.toDataURL('image/png'), width: output.width, height: output.height });
  } finally {
    // Release temporary decoded artwork on both success and rejection.
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    if (output) { output.width = 0; output.height = 0; }
    image.onload = image.onerror = null; image.src = '';
  }
}
// A single public, low-resolution asset is allowlisted. Never persist it into
// the private override store, accept redirects, or bypass raster validation.
export async function loadDefaultInvoiceSeal(){return validateCanonicalSeal({"dataURL": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAYAAACLz2ctAAADIUlEQVR4nO3YP4gcVQDH8V/0DJaCaGcpPCzFRkghA2JjIxb2gnZiHauUFiIWdv7FUoVAsB4CEQUtbV4drKzsBDGexa2ySE4v65nfsfv5wMI8ZubxFr68md0EAAAAAABgX10664XrGMf/50LYP8uc/9rXA/djIXAaAVIlQKqOdr3xLM93DssuvxPsgFQJkCoBUiVAqgRIlQCpEiBVAqRKgFQJkCoBUiVAqgRIlQCpEiBVAqRKgFQJkCoBUiVAqgRIlQCpEiBVAqRKgFQJkCoBUiVAqgRIlQCpEiBVAqRKgFQJkCoBUiVAqgRIlQCpEiBVAqRKgFQJkCoBUiVAqgRIlQCpEiBVAqRKgFQJkCoBUiVAqo7aC/gn6xg/L3M+crfxXc69lOTNzfBKkq83x+8n+SzJd1tT31jmfHcd4+kkbyd5KMlvSV5N8sxp8yxzfnluX44kFzzAe7HMeT3J9eSvOJ/789w6xofb4y0fJ3lxmfPHdYyXk7yzzPnKafNw/vYmwB09nuThzfGNJD8V13KQDv0d8K0kt9YxPkpyZZnzVntBh+ZQAry8jnFz6/NskixzfprkqZy85723jnGtuMaDdNEfwb+vYzy4zHlnHeMoJz8UdvHr39/l1jEeS/LkMuc3ST5Zx/gqyQ9Jrv2XBXNvLvoO+H2S5zfHL2zG5+U4yefrGE9sxo8muX2O83MGF30HfCPJB+sYVzfj13ac5/I6xs2t8bfLnFfXMV5P8sU6xi9J7uTkbxjuo0tnvXAd43h7vMx55ns5DLs0ctEfwew5AVIlQKoESJUAqRIgVQKkSoBUCZAqAVIlQKoESJUAqRIgVQKkSoBUCZAqAVIlQKoESJUAqRIgVQKkSoBUCZAqAVIlQKoESJUAqRIgVQKkSoBUCZAqAVIlQKoESJUAqRIgVQKkSoBUCZAqAVIlQKoESJUAqRIgVQKkSoBUCZAqAVIlQKoESJUAqRIgVQKkSoBUCZAqAVIlQKoESJUAqRIgVQKkSoBUCZAqAVIlQKoESJUAqRIgVQKk6mjXG9cxjs9zIRwmOyBVAqRKgAAAAAAAwP76Ay42gKFlDzROAAAAAElFTkSuQmCC", "width": 160, "height": 160});}
// Calling this factory is inert. Persistence occurs only through explicit
// load/save/remove calls; callers opt in, and may otherwise keep bytes in memory.
export function createSealStore(indexedDB,{key='current',guard=()=>{}}={}) {
  async function run(mode, action) {
    guard();
    if (!indexedDB?.open) throw storageError();
    return new Promise((resolve,reject) => {
      let db, transaction, settled = false;
      const finish = (error,value) => {
        if (settled) return; settled = true; clearTimeout(timer); db?.close();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => { try { transaction?.abort(); } catch {} finish(storageError()); }, 10000);
      let request;
      try { request = indexedDB.open(DB_NAME,1); } catch { finish(storageError()); return; }
      request.onerror = request.onblocked = () => finish(storageError());
      request.onupgradeneeded = () => {
        if (settled) { try { request.transaction.abort(); } catch {} return; }
        try { request.result.createObjectStore(STORE); } catch { finish(storageError()); }
      };
      request.onsuccess = () => {
        db = request.result;
        if (settled) { db.close(); return; }
        try {
          guard();transaction = db.transaction(STORE,mode);
          const operation = action(transaction.objectStore(STORE)); let result;
          operation.onsuccess = () => { result = operation.result; };
          operation.onerror = () => finish(storageError());
          transaction.oncomplete = () => finish(null,result);
          transaction.onerror = transaction.onabort = () => finish(storageError());
        } catch { try { transaction?.abort(); } catch {} finish(storageError()); }
      };
    });
  }
  return {
    async load() { const value = await run('readonly',store => store.get(key)); return value === undefined ? null : validateCanonicalSeal(value); },
    async save(value) { const clean = validateCanonicalSeal(value); if (!clean) throw invalid(); await run('readwrite',store => store.put(clean,key)); return clean; },
    async remove() { await run('readwrite',store => store.delete(key)); }
  };
}
