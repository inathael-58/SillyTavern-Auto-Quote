/*
 * Auto Quote — SillyTavern UI extension
 *
 *   • double space closes the innermost open mark: “hello␣␣ → “hello”␣
 *     (works for “ ” ‘ ’ * ** *** ( 「 『 … — the list is editable; iOS/Gboard's
 *     "double space = period" is caught too)
 *   • a curly quote typed the wrong way round is flipped: after a space or at the
 *     start it is always an opening one
 *   • a row of marks above the send box while it has focus: tap to insert an
 *     opener, or select text and tap to wrap / unwrap it (*“text”* etc.), plus
 *     a button that closes whatever is open
 *
 * Applies to the send box and message editing only (other fields optional);
 * never to Custom CSS or other code fields. Text logic lives in lib.js.
 */

import { BLOCKQUOTE, DEFAULT_PAIRS, DEFAULT_TOOLBAR, buildTable, correctQuote, openerInsert, pendingClose, toggleBlockquote, toggleWrap } from './lib.js';

const MODULE = 'auto_quote';
const LOG = '[AutoQuote]';
const VERSION = '1.0.0'; // keep in sync with manifest.json
const BASE_URL = new URL('.', import.meta.url);

const DEFAULTS = Object.freeze({
    enabled: true,
    autoClose: true,          // double space closes the open mark
    spaceAfterClose: true,
    fixDirection: true,       // ” typed after a space → “
    straightToCurly: false,   // " → “ / ”
    toolbar: true,
    closeButton: true,
    spaceBeforeOpen: true,    // tapping an opener right after a word adds a space first
    editMessages: true,       // also in message edit boxes
    otherFields: false,       // also in other text fields (card, lorebook, notes…)
    pairs: DEFAULT_PAIRS,
    toolbarItems: DEFAULT_TOOLBAR,
});

/** Never touched, whatever the settings: code and script editors. */
const CODE_FIELDS = '#customCSS, .monospace, [data-aq-off], .CodeMirror, .cm-editor, .qr--modal, .regex_editor, #regex_editor_template';

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();
const $id = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

const save = () => ctx().saveSettingsDebounced();

let table = buildTable(DEFAULT_PAIRS);
const rebuildTable = () => { table = buildTable(settings().pairs); };

const isSendBox = el => el?.id === 'send_textarea';

function inScope(el) {
    if (!(el instanceof HTMLTextAreaElement) || el.readOnly || el.disabled) return false;
    const s = settings();
    if (!s.enabled) return false;
    if (isSendBox(el)) return !/^\s*\//.test(el.value); // slash commands / STscript
    if (el.closest(CODE_FIELDS) || /(?:^|[_-])(?:css|regex|script|json|code)(?:[_-]|$)/i.test(el.id)) return false;
    if (el.matches('.edit_textarea, .reasoning_edit_textarea')) return s.editMessages;
    return s.otherFields;
}

/**
 * Replace value[start, end) with text through the browser's editing command,
 * so Ctrl+Z / shake-to-undo still work; falls back to setRangeText.
 */
let busy = false;
function replaceRange(el, start, end, text, selStart = start + text.length, selEnd = selStart) {
    busy = true;
    try {
        if (document.activeElement !== el) el.focus({ preventScroll: true });
        el.setSelectionRange(start, end);
        let ok = false;
        try {
            if (text) ok = document.execCommand('insertText', false, text);
            else if (start < end) ok = document.execCommand('delete');
            else ok = true;
        } catch { ok = false; }
        if (!ok) {
            el.setRangeText(text, start, end, 'end');
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.setSelectionRange(selStart, selEnd);
    } finally {
        busy = false;
    }
    last = { el, value: el.value };
    spaceMark = null;
    scheduleBarUpdate();
}

// ---------------------------------------------------------------- typing

/** The textarea value after the previous input event (to see what this one changed). */
let last = { el: null, value: '' };
/** Set after the user types a space: { el, value, pos } with value[pos - 1] === ' '. */
let spaceMark = null;

/** Close the innermost open mark: cut [cutFrom, caret) and the whitespace before it, put the closer there. */
function closeAt(el, cutFrom, caret, spaceAfter) {
    const before = el.value.slice(0, cutFrom);
    const hit = pendingClose(before, table);
    if (!hit) return false;
    const text = hit.close + (spaceAfter ? ' ' : '');
    replaceRange(el, hit.at, caret, text);
    return true;
}

function onInput(e) {
    const el = e.target;
    if (busy || !(el instanceof HTMLTextAreaElement)) return;
    const prev = last.el === el ? last.value : null;
    const v = el.value;
    last = { el, value: v };
    if (!inScope(el)) { spaceMark = null; return; }
    scheduleBarUpdate();

    const c = el.selectionStart;
    if (c !== el.selectionEnd) { spaceMark = null; return; }
    const s = settings();
    const composing = e.isComposing;

    // second space (or the keyboard's "double space = period" rewrite of it)
    if (s.autoClose && spaceMark?.el === el && !composing) {
        const { value: A, pos: q } = spaceMark;
        if (v === A.slice(0, q) + ' ' + A.slice(q) && c === q + 1) {
            if (closeAt(el, q - 1, c, s.spaceAfterClose)) return;
        } else if (v === A.slice(0, q - 1) + '. ' + A.slice(q) && c === q + 1) {
            if (closeAt(el, q - 1, c, s.spaceAfterClose)) return;
            spaceMark = null;
            return;
        } else if (v === A.slice(0, q - 1) + A.slice(q) && c === q - 1) {
            return; // the keyboard removed the space and is about to insert ". "
        }
    }

    const inserted = prev !== null && v.length > prev.length;
    spaceMark = inserted && v[c - 1] === ' ' ? { el, value: v, pos: c } : null;

    // one quote character typed → point it the right way
    if (!composing && inserted && v.length === prev.length + 1 && (s.fixDirection || s.straightToCurly)) {
        const p = c - 1;
        const ch = v[p];
        if (v.slice(0, p) === prev.slice(0, p) && v.slice(p + 1) === prev.slice(p)) {
            const want = ch === '"'
                ? correctQuote(ch, v.slice(0, p), table, { straight: s.straightToCurly })
                : s.fixDirection ? correctQuote(ch, v.slice(0, p), table) : null;
            if (want) replaceRange(el, p, p + 1, want);
        }
    }
}

function onFocusIn(e) {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement)) return;
    last = { el, value: el.value };
    spaceMark = null;
    if (isSendBox(el)) showBar();
}

function onFocusOut(e) {
    if (!isSendBox(e.target)) return;
    // a tap on the bar keeps focus (mousedown is cancelled), so anything else really left the box
    setTimeout(() => { if (!isSendBox(document.activeElement)) hideBar(); }, 120);
}

// ---------------------------------------------------------------- toolbar

let bar = null;

function toolbarEntries() {
    const out = [];
    for (const tok of String(settings().toolbarItems ?? '').trim().split(/\s+/).filter(Boolean)) {
        if (tok === BLOCKQUOTE) { out.push({ tok, label: '>', wrap: '>…', title: 'Blockquote' }); continue; }
        const pair = table.byOpen.get(tok);
        if (pair) out.push({ tok, label: pair.open, wrap: `${pair.open}…${pair.close}`, title: `${pair.open} ${pair.close}` });
    }
    return out;
}

function renderBar() {
    const host = $id('send_form');
    if (!host) return;
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'aq_bar';
        bar.hidden = true;
        bar.innerHTML = '<div class="aq_row"><div class="aq_scroll"></div><button type="button" class="aq_btn aq_close" tabindex="-1" title="ปิดเครื่องหมายที่ค้างอยู่"></button></div>';
        // keep focus (and the keyboard, and the selection) in the send box
        bar.addEventListener('mousedown', e => e.preventDefault());
        bar.addEventListener('click', onBarClick);
    }
    if (bar.parentElement !== host) {
        host.classList.add('aq_host');
        host.prepend(bar);
    }
    bar.querySelector('.aq_scroll').innerHTML = toolbarEntries().map(t =>
        `<button type="button" class="aq_btn" tabindex="-1" data-tok="${esc(t.tok)}" title="${esc(t.title)}"><span class="aq_o">${esc(t.label)}</span><span class="aq_w">${esc(t.wrap)}</span></button>`).join('');
}

function showBar() {
    const s = settings();
    if (!s.enabled || !s.toolbar) return;
    if (!bar || !bar.isConnected) renderBar();
    if (!bar) return;
    bar.hidden = false;
    updateBar();
}

function hideBar() {
    if (bar) bar.hidden = true;
}

let barQueued = false;
function scheduleBarUpdate() {
    if (barQueued || !bar || bar.hidden) return;
    barQueued = true;
    requestAnimationFrame(() => { barQueued = false; updateBar(); });
}

function updateBar() {
    if (!bar || bar.hidden) return;
    const el = $id('send_textarea');
    if (!el) return;
    const selected = el.selectionStart !== el.selectionEnd;
    bar.classList.toggle('aq_selecting', selected);
    const btn = bar.querySelector('.aq_close');
    const hit = settings().closeButton && !selected && inScope(el) ? pendingClose(el.value.slice(0, el.selectionStart), table) : null;
    btn.hidden = !hit;
    if (hit) btn.textContent = hit.close;
}

function onBarClick(e) {
    const btn = e.target.closest('.aq_btn');
    const el = $id('send_textarea');
    if (!btn || !el) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    const s = settings();
    const start = el.selectionStart, end = el.selectionEnd;

    if (btn.classList.contains('aq_close')) {
        closeAt(el, end, end, false);
        return;
    }
    const tok = btn.dataset.tok;
    if (tok === BLOCKQUOTE) {
        const r = toggleBlockquote(el.value, start, end);
        replaceRange(el, r.start, r.end, r.text, r.selStart, r.selEnd);
        return;
    }
    const pair = table.byOpen.get(tok);
    if (!pair) return;
    const r = start !== end ? toggleWrap(el.value, start, end, pair, table) : null;
    if (r) {
        // keep the result selected, so the next tap wraps around it: “text” → *“text”*
        replaceRange(el, r.start, r.end, r.text, r.selStart, r.selEnd);
        return;
    }
    const text = openerInsert(el.value.slice(0, start), pair, table, s.spaceBeforeOpen);
    replaceRange(el, start, end, text);
}

// ---------------------------------------------------------------- settings panel

function renderSettings() {
    const host = $id('extensions_settings2') ?? $id('extensions_settings');
    if (!host || $id('aq_settings')) return;
    const s = settings();
    host.insertAdjacentHTML('beforeend', `
    <div id="aq_settings" class="aq_settings" data-aq-off>
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Auto Quote <small class="aq_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="aq_enabled"> เปิดใช้งาน</label>

                <div class="aq_set_title">ตอนพิมพ์</div>
                <label class="checkbox_label"><input type="checkbox" id="aq_autoclose"> เว้นวรรคสองครั้ง = ปิดเครื่องหมายที่เปิดค้างไว้</label>
                <label class="checkbox_label aq_indent"><input type="checkbox" id="aq_spaceafter"> เว้นวรรคหนึ่งช่องหลังปิด</label>
                <label class="checkbox_label"><input type="checkbox" id="aq_fixdir"> กลับทิศ “ ” ‘ ’ ที่พิมพ์ผิดด้าน</label>
                <small class="aq_note">หลังช่องว่างหรือต้นบรรทัดจะเป็นตัวเปิดเสมอ · พิมพ์ตัวเปิดต่อท้ายคำตอนที่มีตัวเปิดค้างอยู่จะกลายเป็นตัวปิด</small>
                <label class="checkbox_label"><input type="checkbox" id="aq_straight"> เปลี่ยน " ตรง ๆ เป็น “ ” อัตโนมัติ</label>

                <div class="aq_set_title">แถบเครื่องหมายเหนือช่องพิมพ์</div>
                <label class="checkbox_label"><input type="checkbox" id="aq_toolbar"> แสดงตอนเคอร์เซอร์อยู่ในช่องพิมพ์</label>
                <label class="checkbox_label aq_indent"><input type="checkbox" id="aq_closebtn"> ปุ่มปิดเครื่องหมายที่ค้างอยู่ (ขวาสุด)</label>
                <label class="checkbox_label aq_indent"><input type="checkbox" id="aq_spacebefore"> เว้นวรรคให้ก่อน ถ้ากดตัวเปิดต่อท้ายคำ</label>
                <label class="aq_field">ปุ่มบนแถบ <small>(ตัวเปิดคั่นด้วยช่องว่าง · <code>&gt;</code> = blockquote)</small>
                    <input type="text" id="aq_items" class="text_pole" data-aq-off autocomplete="off">
                </label>

                <div class="aq_set_title">ใช้กับ</div>
                <label class="checkbox_label"><input type="checkbox" checked disabled> ช่องพิมพ์ข้อความ (ยกเว้นตอนพิมพ์คำสั่ง /)</label>
                <label class="checkbox_label"><input type="checkbox" id="aq_edit"> ช่องแก้ไขข้อความในแชท</label>
                <label class="checkbox_label"><input type="checkbox" id="aq_other"> ช่องข้อความอื่น ๆ (การ์ดตัวละคร, lorebook, note …)</label>
                <small class="aq_note">ไม่ทำงานใน Custom CSS, regex, Quick Reply script และช่องเขียนโค้ดอื่น ๆ เสมอ</small>

                <div class="aq_set_title">คู่เครื่องหมาย</div>
                <small class="aq_note">บรรทัดละคู่: <code>ตัวเปิด ตัวปิด</code> · ใส่ตัวเดียวถ้าเปิดปิดเหมือนกัน เช่น <code>**</code></small>
                <textarea id="aq_pairs" class="text_pole monospace" rows="8" data-aq-off spellcheck="false"></textarea>
                <div class="aq_btns">
                    <div id="aq_reset" class="menu_button"><i class="fa-solid fa-rotate-left"></i> คืนค่าเริ่มต้น</div>
                </div>
            </div>
        </div>
    </div>`);

    const bind = (id, key, after) => {
        const el = /** @type {HTMLInputElement} */ ($id(id));
        el.checked = !!s[key];
        el.addEventListener('change', () => { s[key] = el.checked; save(); after?.(); });
    };
    const refreshBar = () => { renderBar(); if (isSendBox(document.activeElement)) showBar(); else hideBar(); };
    bind('aq_enabled', 'enabled', refreshBar);
    bind('aq_autoclose', 'autoClose');
    bind('aq_spaceafter', 'spaceAfterClose');
    bind('aq_fixdir', 'fixDirection');
    bind('aq_straight', 'straightToCurly');
    bind('aq_toolbar', 'toolbar', refreshBar);
    bind('aq_closebtn', 'closeButton', updateBar);
    bind('aq_spacebefore', 'spaceBeforeOpen');
    bind('aq_edit', 'editMessages');
    bind('aq_other', 'otherFields');

    const items = /** @type {HTMLInputElement} */ ($id('aq_items'));
    const pairs = /** @type {HTMLTextAreaElement} */ ($id('aq_pairs'));
    items.value = s.toolbarItems;
    pairs.value = s.pairs;
    items.addEventListener('input', () => { s.toolbarItems = items.value; save(); renderBar(); });
    pairs.addEventListener('input', () => { s.pairs = pairs.value; save(); rebuildTable(); renderBar(); });
    $id('aq_reset').addEventListener('click', () => {
        s.pairs = DEFAULT_PAIRS;
        s.toolbarItems = DEFAULT_TOOLBAR;
        items.value = s.toolbarItems;
        pairs.value = s.pairs;
        save();
        rebuildTable();
        renderBar();
    });
}

// ---------------------------------------------------------------- stale-code check
//
// SillyTavern loads extension files by a fixed URL, and a home-screen web app
// on iOS rarely does a real reload, so after "Update" the old code can keep
// running for a long time. Compare with the manifest on the server; if it is
// newer, refresh the cached files explicitly and reload.

let versionCheckedAt = 0;
let versionToastShown = false;

async function checkForNewVersion() {
    if (versionToastShown || Date.now() - versionCheckedAt < 10 * 60_000) return;
    versionCheckedAt = Date.now();
    let remote;
    try {
        const res = await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' });
        if (!res.ok) return;
        remote = String((await res.json())?.version ?? '');
    } catch { return; }
    if (!remote || remote === VERSION) return;
    versionToastShown = true;
    globalThis.toastr?.info(`ติดตั้ง v${esc(remote)} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION} อยู่<br>แตะที่นี่เพื่อโหลดเวอร์ชันใหม่`, 'Auto Quote', {
        timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false,
        onclick: () => reloadWithFreshFiles(),
    });
}

async function reloadWithFreshFiles() {
    try {
        // cache: 'reload' fetches from the server and overwrites the browser's cached copy,
        // so the page reload below picks up the new files.
        await Promise.all(['index.js', 'lib.js', 'style.css', 'manifest.json'].map(f =>
            fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
    } finally {
        location.reload();
    }
}

// ---------------------------------------------------------------- init

function init() {
    if (globalThis.AutoQuote) return; // loaded twice
    settings();
    rebuildTable();
    renderSettings();
    renderBar();

    document.addEventListener('input', onInput, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('selectionchange', scheduleBarUpdate);
    document.addEventListener('keyup', e => { if (isSendBox(e.target)) scheduleBarUpdate(); });
    document.addEventListener('pointerup', e => { if (isSendBox(e.target)) scheduleBarUpdate(); });
    if (isSendBox(document.activeElement)) showBar();

    const { eventSource, event_types: E } = ctx();
    eventSource.once(E.APP_READY, () => { renderBar(); if (isSendBox(document.activeElement)) showBar(); });

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForNewVersion(); });
    setTimeout(checkForNewVersion, 3000);
    globalThis.AutoQuote = { VERSION, settings, checkForNewVersion, reloadWithFreshFiles, get table() { return table; } };
    console.log(LOG, 'loaded', `v${VERSION}`);
}

if (typeof jQuery === 'function') jQuery(init); else init();
