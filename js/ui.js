// UI toolkit: DOM builder (no innerHTML with user data => XSS-safe), icons, sheets, toasts, forms, Excel export.

// ---------- DOM builder ----------
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'htmlFor']);
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    Element.prototype.append.call(el, k instanceof Node ? k : document.createTextNode(String(k))); // native call: router overrides view.append
  }
}
// Like el.append(), but accepts arrays and skips null/false (native append would print them as the text "null"/"false").
export function appendKids(el, ...kids) { append(el, kids); return el; }
// Like el.replaceChildren(), but accepts arrays and skips null/false (which replaceChildren would print as text).
export function setChildren(el, ...kids) {
  el.replaceChildren();
  append(el, kids);
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- Icons (24px stroke icons) ----------
const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 010 7"/><path d="M18 14.3c2 .8 3.5 2.6 3.5 5.7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
  truck: '<path d="M2 6h11v10H2z"/><path d="M13 9h4l3 3v4h-7"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
  building: '<path d="M4 21V4h11v17"/><path d="M15 9h5v12"/><path d="M8 8h3M8 12h3M8 16h3"/>',
  logout: '<path d="M9 4H5v16h4"/><path d="M16 8l4 4-4 4"/><path d="M20 12H9"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M16 7l3 3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13 7l4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  alert: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.7 9.7 0 0112 6c6.5 0 10 6 10 6a17 17 0 01-3.2 3.9M6.3 7.6A17 17 0 002 12s3.5 6 10 6c1.6 0 3-.4 4.2-.9"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>',
  dots: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>',
  mail: '<path d="M3 5h18v14H3z"/><path d="M3 7l9 6 9-6"/>',
  dollar: '<path d="M12 3v18"/><path d="M17 7.5C17 5.6 14.8 4.5 12 4.5S7 5.6 7 7.5s2.2 3 5 3.5 5 1.6 5 3.5-2.2 3-5 3-5-1.1-5-3"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 4l13 8-13 8V4z"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>',
  upload: '<path d="M12 20V9"/><path d="M7 13l5-5 5 5"/><path d="M4 20h16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  book: '<path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4z"/><path d="M5 17a3 3 0 013-3h11"/><path d="M9 8h6"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 12h11l2-8H6"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6"/>',
};
export function icon(name, size = 20) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}
export const iconBtn = (name, label, onclick, cls = '') => h('button', { type: 'button', class: 'icon-btn ' + cls, 'aria-label': label, title: label, onclick }, icon(name, 18));

// ---------- Formatting ----------
export const money = (n) => '$' + Number(n || 0).toFixed(2);
export const day = (iso) => (iso || '').slice(0, 10);
export const initials = (name) => (String(name || '?').trim().split(/[\s._-]+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase();
export const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const norm = (s) => String(s || '').toLowerCase();
export const errText = (e) => e?.message || String(e);

// ---------- Toasts ----------
export function toast(message, type = 'info') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: 'toast ' + type, role: 'status' }, type === 'success' ? icon('check', 18) : type === 'error' ? icon('alert', 18) : null, message);
  while (box.children.length >= 1) box.firstElementChild.remove(); // one toast at a time - stacked toasts cover too much of the page head on phones
  box.append(el);
  setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, type === 'error' ? 4500 : 2600);
}

// ---------- Sheets (bottom sheet on phones, centered dialog on desktop) ----------
export function sheet({ title, content, footer, onClose }) {
  const overlays = document.getElementById('overlays');
  const body = h('div', { class: 'sheet-body' }, content);
  const closeBtn = iconBtn('x', 'Close', () => close());
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h3', {}, title), closeBtn), body, footer ? h('div', { class: 'sheet-foot' }, footer) : null);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } }, panel);
  let closed = false;
  const onKey = (e) => { if (e.key === 'Escape' && overlays.lastElementChild === overlay) close(); };
  function close() {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (!overlays.children.length) document.body.classList.remove('noscroll');
    onClose?.();
  }
  document.addEventListener('keydown', onKey);
  overlays.append(overlay);
  document.body.classList.add('noscroll');
  return { close, body, panel };
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    let answered = false;
    const done = (v) => { answered = true; s.close(); resolve(v); };
    const s = sheet({
      title, content: h('p', { class: 'muted' }, message),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : ''), type: 'button', onclick: () => done(true) }, confirmLabel)],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// Typed confirmation for destructive actions: resolves true only if the user types `expected`.
export function typedConfirm({ title, message, expected, confirmLabel = 'Delete' }) {
  return new Promise(resolve => {
    let answered = false;
    const input = h('input', { class: 'input', placeholder: expected, 'aria-label': 'Confirmation text', autocomplete: 'off' });
    const ok = h('button', { class: 'btn danger', type: 'button', disabled: true, onclick: () => done(true) }, confirmLabel);
    input.addEventListener('input', () => { ok.disabled = input.value !== expected; });
    const done = (v) => { answered = true; s.close(); resolve(v); };
    const s = sheet({
      title, content: h('div', { class: 'stack' }, h('p', { class: 'muted' }, message), h('p', { class: 'small' }, 'Type ', h('b', {}, expected), ' to confirm.'), input),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => done(false) }, 'Cancel'), ok],
      onClose: () => { if (!answered) resolve(false); },
    });
    input.focus();
  });
}

// ---------- Forms in a sheet ----------
// fields: [{ name, label, type, value, required, placeholder, options:[{value,label}], help, min, step, inputMode, autocomplete, node }]
// onSubmit(values) may throw; the message is shown inline and the sheet stays open.
export function openForm({ title, fields, submitLabel = 'Save', onSubmit, danger = false }) {
  const errorBox = h('div', { class: 'form-error hidden', role: 'alert' });
  const controls = {};
  const form = h('form', { class: 'form', novalidate: true }, errorBox);
  for (const f of fields) {
    if (f.node) { form.append(f.node); continue; }
    const id = 'f_' + f.name + '_' + Math.random().toString(36).slice(2, 7);
    let control;
    if (f.type === 'select') {
      control = h('select', { id, name: f.name }, (f.options || []).map(o => h('option', { value: o.value, selected: String(o.value) === String(f.value) }, o.label)));
    } else if (f.type === 'switch') {
      control = h('input', { id, name: f.name, type: 'checkbox', checked: !!f.value });
      controls[f.name] = control;
      form.append(h('label', { class: 'toggle-row', htmlFor: id }, h('span', {}, h('b', {}, f.label), f.help ? h('div', { class: 'help muted small' }, f.help) : null), h('span', { class: 'switch' }, control, h('span'))));
      continue;
    } else {
      control = h('input', { id, name: f.name, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', min: f.min, step: f.step, inputmode: f.inputMode,
        autocomplete: f.autocomplete || 'off', required: f.required ? true : null, maxlength: f.maxLength });
    }
    controls[f.name] = control;
    form.append(h('div', { class: 'field' }, h('label', { htmlFor: id }, f.label, f.required ? ' *' : ''), control, f.help ? h('div', { class: 'help' }, f.help) : null));
  }
  const submit = h('button', { class: 'btn' + (danger ? ' danger' : ''), type: 'submit' }, submitLabel);
  form.append(h('div', { class: 'sheet-foot', style: 'padding:0;border:0' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Cancel'), submit));
  const s = sheet({ title, content: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    for (const f of fields) {
      const c = controls[f.name];
      if (f.required && c && c.type !== 'checkbox' && !String(c.value).trim()) { showError(`${f.label} is required`); c.focus(); return; }
    }
    const values = {};
    for (const [n, c] of Object.entries(controls)) values[n] = c.type === 'checkbox' ? c.checked : c.value;
    submit.disabled = true; const label = submit.textContent; submit.textContent = 'Saving…';
    try { await onSubmit(values); s.close(); }
    catch (err) { console.error(err); showError(errText(err)); }
    finally { submit.disabled = false; submit.textContent = label; }
  });
  function showError(msg) { errorBox.textContent = msg; errorBox.classList.remove('hidden'); }
  // Focus the first field, unless the user has already started interacting inside the sheet (don't steal focus).
  setTimeout(() => { if (!form.contains(document.activeElement)) form.querySelector('input:not([type=checkbox]),select')?.focus(); }, 60);
  return s;
}

// ---------- Small components ----------
export function switchRow(label, help, checked = false) {
  const input = h('input', { type: 'checkbox', checked });
  const node = h('label', { class: 'toggle-row' }, h('span', {}, h('b', {}, label), help ? h('div', { class: 'help muted small' }, help) : null), h('span', { class: 'switch' }, input, h('span')));
  return { node, input };
}
export const badge = (text, tone = '', iconName = null) => h('span', { class: 'badge ' + tone }, iconName ? icon(iconName, 12) : null, text);
export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'big' }, icon(iconName, 30)), h('h3', {}, title), text ? h('p', {}, text) : null, action || null);
}
export const skeletons = (n = 3) => h('div', { class: 'list' }, Array.from({ length: n }, () => h('div', { class: 'skeleton' })));

export function pageHead(title, actions = []) {
  return h('div', { class: 'page-head' }, h('h2', {}, title), h('div', { class: 'actions' }, actions));
}
export const fab = (label, onclick) => h('button', { class: 'fab', type: 'button', onclick, 'aria-label': label }, icon('plus', 22), h('span', {}, label));

export function statCard({ icon: ic, label, value, tone = '', href, onclick }) {
  const tag = href || onclick ? 'button' : 'div';
  return h(tag, { class: 'stat ' + tone, type: tag === 'button' ? 'button' : null, onclick: onclick || (href ? () => { location.hash = href; } : null) },
    h('div', { class: 'chip-icon' }, icon(ic, 20)), h('div', { class: 'value' }, value), h('div', { class: 'label' }, label));
}

// rows: [{ label, value (number), text, onclick? }]; bar widths are relative to the largest value. A row with an
// onclick becomes a tappable button (e.g. drill down into what that bar represents) instead of a plain row.
export function barCard(title, rows, tone = '') {
  if (!rows.length) return null;
  const max = Math.max(...rows.map(r => r.value), 1);
  return h('div', { class: 'card' }, h('h3', {}, title), rows.map(r => h(r.onclick ? 'button' : 'div',
    { class: 'bar-row' + (r.onclick ? ' tap' : ''), type: r.onclick ? 'button' : null, onclick: r.onclick || null,
      style: r.onclick ? 'width:100%;text-align:left;background:none;border:0;cursor:pointer;font:inherit;color:inherit' : null },
    h('span', { class: 'ellipsis' }, r.label),
    h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill ' + tone, style: `width:${Math.max(4, Math.round(r.value / max * 100))}%` })),
    h('span', { class: 'bar-val' }, r.text))));
}

export function searchBox(placeholder, onInput, initial = '') {
  const input = h('input', { type: 'search', placeholder, 'aria-label': placeholder, autocomplete: 'off', value: initial });
  input.addEventListener('input', debounce(() => onInput(input.value), 120));
  return h('div', { class: 'search' }, icon('search', 18), input);
}

export function chipGroup(options, active, onChange) {
  const wrap = h('div', { class: 'chips', role: 'tablist' });
  const draw = () => { wrap.replaceChildren(...options.map(o => h('button', { type: 'button', class: 'chip' + (o.value === active ? ' active' : ''), onclick: () => { active = o.value; draw(); onChange(active); } }, o.label))); };
  draw();
  return wrap;
}

// ---------- Excel export (SheetJS from CDN; static, free) ----------
export async function exportXlsx(filename, sheets) {
  let XLSX;
  try { XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs'); }
  catch (e) { console.error(e); toast('Could not load the Excel library. Check your connection.', 'error'); return false; }
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = aoa[0].map((_, c) => ({ wch: Math.min(40, Math.max(...aoa.map(r => String(r[c] ?? '').length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename);
  toast('Excel file downloaded', 'success');
  return true;
}
export const exportButton = (getSheets, filenameBase) => h('button', { class: 'btn soft sm', type: 'button', onclick: async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try { await exportXlsx(`${filenameBase()}-${new Date().toISOString().slice(0, 10)}.xlsx`, getSheets()); } finally { b.disabled = false; }
} }, icon('download', 16), 'Export');

// ---------- Excel/CSV import (SheetJS from CDN) ----------
// Opens a file picker, parses the first sheet into row objects (keyed by header, trimmed), and resolves with them
// (or null if the user cancelled). Column names are matched case-insensitively by callers, so header spelling is flexible.
export function pickSpreadsheet(accept = '.xlsx,.xls,.csv') {
  return new Promise((resolve, reject) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    let settled = false;
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.remove();
      if (!file) { settled = true; return resolve(null); }
      try {
        const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs');
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
        settled = true; resolve(rows);
      } catch (e) { settled = true; reject(e); }
    });
    document.body.append(input);
    input.click();
    // Some browsers never fire `change` on cancel; treat a long silence as "the user cancelled", not an error.
    setTimeout(() => { if (!settled) { input.remove(); resolve(null); } }, 5 * 60 * 1000);
  });
}
// onRows(rows) does the page-specific mapping/validation and returns a short result message, or throws.
export const importButton = (onRows) => h('button', { class: 'btn ghost sm', type: 'button', onclick: async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try {
    const rows = await pickSpreadsheet();
    if (!rows) return; // cancelled
    if (!rows.length) return toast('That file has no rows', 'error');
    await onRows(rows);
  } catch (err) { console.error(err); toast('Could not read that file - export a template first and match its columns.', 'error'); }
  finally { b.disabled = false; }
} }, icon('upload', 16), 'Import');

// One discreet button standing in for both exportButton and importButton: opens a small sheet to choose which.
// Keeps a page's header from needing two separate buttons for what is really one "spreadsheet" action.
// canImport lets a page hide the Import option for someone without create permission, while still offering Export.
export const exportImportButton = ({ getSheets, filenameBase, onImportRows, canImport = true }) => h('button', { class: 'btn soft sm', type: 'button', onclick: () => {
  const s = sheet({
    title: 'Export / import',
    content: h('div', { class: 'list' },
      h('button', { class: 'item tap', type: 'button', onclick: async () => {
        s.close(); await exportXlsx(`${filenameBase()}-${new Date().toISOString().slice(0, 10)}.xlsx`, getSheets());
      } }, h('div', { class: 'avatar' }, icon('download', 20)), h('div', { class: 'title grow' }, 'Export to Excel'), icon('chevron', 18)),
      canImport ? h('button', { class: 'item tap', type: 'button', onclick: async () => {
        s.close();
        try {
          const rows = await pickSpreadsheet();
          if (!rows) return; // cancelled
          if (!rows.length) return toast('That file has no rows', 'error');
          await onImportRows(rows);
        } catch (err) { console.error(err); toast('Could not read that file - export a template first and match its columns.', 'error'); }
      } }, h('div', { class: 'avatar' }, icon('upload', 20)), h('div', { class: 'title grow' }, 'Import from Excel'), icon('chevron', 18)) : null),
  });
} }, icon('download', 16), 'Export / Import');
