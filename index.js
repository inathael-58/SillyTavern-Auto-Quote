/*
 * Typing Buddy — SillyTavern UI extension
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
const LOG = '[TypingBuddy]';
const VERSION = '1.3.0'; // keep in sync with manifest.json
const BASE_URL = new URL('.', import.meta.url);

const DEFAULTS = Object.freeze({
    enabled: true,
    autoClose: true,          // a run of spaces closes the open mark…
    closeSpaces: 2,           // …this many (2 or 3)
    closeEnter: false,        // Enter closes the open mark (instead of a new line / sending)
    closeHold: false,         // holding the space bar closes it (physical keyboards only)
    spaceAfterClose: true,    // after closing by spaces or hold
    fixDirection: true,       // ” typed after a space → “
    straightToCurly: false,   // " → “ / ”
    toolbar: true,
    closeButton: true,
    undoButton: true,         // ↶ / ↷ on the bar (phone keyboards rarely have undo)
    spaceBeforeOpen: true,    // tapping an opener right after a word adds a space first
    editMessages: true,       // also in message edit boxes
    otherFields: false,       // also in other text fields (card, lorebook, notes…)
    pairs: DEFAULT_PAIRS,
    toolbarItems: DEFAULT_TOOLBAR,
    sample: '',               // example tab text; '' = built-in
});

/** Never touched, whatever the settings: code and script editors. */
const CODE_FIELDS = '#customCSS, .monospace, [data-aq-off], .CodeMirror, .cm-editor, .qr--modal, .regex_editor, #regex_editor_template';

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();
const $id = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Called on every key press: getContext() builds a large object each call, so keep
// SillyTavern's settings object (it is never replaced) and fill defaults once.
let extSettings = null;
let filled = null;
function settings() {
    extSettings ??= ctx().extensionSettings;
    if (!extSettings[MODULE]) extSettings[MODULE] = {};
    const s = extSettings[MODULE];
    if (s !== filled) {
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (s[k] === undefined) s[k] = v;
        }
        filled = s;
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
    const before = el.value;
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
    histRecord(el, before, 'edit');
    last = { el, value: el.value };
    spaceMark = null;
    scheduleBarUpdate();
}

// ---------------------------------------------------------------- undo / redo (send box)
//
// Our own history, because the browser's undo stack can't be reached from a
// button on phones. Typing is grouped into steps that end at a space or a
// one-second pause; every edit we make (closing, wrapping…) is its own step.

const HISTORY_MAX = 200;
const GROUP_MS = 1000;
const hist = { values: [], index: -1, at: 0, typing: false };

function histPush(v) {
    hist.values.length = hist.index + 1;
    hist.values.push(v);
    if (hist.values.length > HISTORY_MAX) hist.values.shift();
    hist.index = hist.values.length - 1;
}

/** `prev` is the value before this change, when known. */
function histRecord(el, prev, kind) {
    if (!isSendBox(el)) return;
    const v = el.value;
    if (hist.index < 0) histPush(prev ?? '');
    // changed behind our back (message sent, another extension, a draft restored)
    if (prev !== null && hist.values[hist.index] !== prev) { histPush(prev); hist.typing = false; }
    if (v === hist.values[hist.index]) return;
    const now = Date.now();
    if (kind === 'type' && hist.typing && now - hist.at < GROUP_MS) hist.values[hist.index] = v;
    else histPush(v);
    hist.typing = kind === 'type' && !/\s/.test(v[el.selectionStart - 1] ?? '');
    hist.at = now;
}

const canUndo = el => hist.index > 0 || (hist.index === 0 && el.value !== hist.values[0]);
const canRedo = el => hist.index < hist.values.length - 1 && el.value === hist.values[hist.index];

/** Put `target` in the box with the caret where the change was. */
function histApply(el, target, from) {
    let p = 0;
    while (p < target.length && p < from.length && target[p] === from[p]) p++;
    let q = 0;
    while (q < target.length - p && q < from.length - p && target[target.length - 1 - q] === from[from.length - 1 - q]) q++;
    busy = true;
    try {
        el.value = target;
        el.setSelectionRange(target.length - q, target.length - q);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
        busy = false;
    }
    hist.typing = false;
    last = { el, value: el.value };
    spaceMark = null;
    scheduleBarUpdate();
}

function undo(el) {
    if (hist.index < 0) return;
    if (el.value !== hist.values[hist.index]) histPush(el.value);
    if (hist.index === 0) return;
    hist.index--;
    histApply(el, hist.values[hist.index], hist.values[hist.index + 1]);
}

function redo(el) {
    if (!canRedo(el)) return;
    hist.index++;
    histApply(el, hist.values[hist.index], hist.values[hist.index - 1]);
}

// ---------------------------------------------------------------- typing

/** The textarea value after the previous input event (to see what this one changed). */
let last = { el: null, value: '' };
/**
 * Set while the user types a run of spaces: { el, value, pos, count, start } —
 * value[pos - 1] is the last space, `count` spaces (or ". " from the keyboard's
 * double-space shortcut, counted as two) start at `start`.
 */
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
    histRecord(el, prev, 'type');
    if (!inScope(el)) { spaceMark = null; return; }
    scheduleBarUpdate();

    const c = el.selectionStart;
    if (c !== el.selectionEnd) { spaceMark = null; return; }
    const s = settings();
    const composing = e.isComposing;

    // one more space in a run (or the keyboard's "double space = period" rewrite of the first two)
    if (s.autoClose && spaceMark?.el === el && !composing) {
        const { value: A, pos: q, count, start } = spaceMark;
        const need = Number(s.closeSpaces) === 3 ? 3 : 2;
        let next = null;
        if (v === A.slice(0, q) + ' ' + A.slice(q) && c === q + 1) {
            next = { count: count + 1, start };
        } else if (count === 1 && v === A.slice(0, q - 1) + '. ' + A.slice(q) && c === q + 1) {
            next = { count: 2, start: q - 1, period: true };
        } else if (count === 1 && v === A.slice(0, q - 1) + A.slice(q) && c === q - 1) {
            return; // the keyboard removed the space and is about to insert ". "
        }
        if (next) {
            if (next.count >= need) {
                if (closeAt(el, next.start, c, s.spaceAfterClose)) return;
                if (next.period) { spaceMark = null; return; } // nothing open: leave the keyboard's period alone
            }
            spaceMark = { el, value: v, pos: c, count: next.count, start: next.start };
            return;
        }
    }

    const inserted = prev !== null && v.length > prev.length;
    spaceMark = inserted && v[c - 1] === ' ' ? { el, value: v, pos: c, count: 1, start: c - 1 } : null;

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

/** 'closed' / 'pass' while the space bar is held after its first auto-repeat, else null. */
let holding = null;
/** When a keydown last said "Enter" — the line break that follows is then already decided. */
let enterKeyAt = 0;

/** Enter and a held space bar, when they are chosen as ways to close. */
function onKeyDown(e) {
    const el = e.target;
    if (!e.isTrusted || e.isComposing || !(el instanceof HTMLTextAreaElement)) return;
    if (e.key === ' ' && !e.repeat) { holding = null; return; }
    if (e.key === 'Enter') enterKeyAt = e.timeStamp;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey && e.key === 'Enter') return;
    if (e.key !== 'Enter' && !(e.key === ' ' && e.repeat)) return;
    if (!inScope(el) || el.selectionStart !== el.selectionEnd) return;
    const s = settings();
    const c = el.selectionStart;
    let handled = false;
    if (e.key === 'Enter') {
        // only while something is open; otherwise Enter does what it always does (new line / send)
        handled = s.closeEnter && closeAt(el, c, c, false);
    } else if (s.closeHold) {
        // the first press already typed one space; closeAt replaces it. Later repeats are swallowed.
        if (holding === null) holding = closeAt(el, c, c, s.spaceAfterClose) ? 'closed' : 'pass';
        handled = holding === 'closed';
    }
    if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation(); // keep SillyTavern from sending the message on this Enter
    }
}

/** Phone keyboards may report Enter only as a line break being inserted. */
function onBeforeInput(e) {
    const el = e.target;
    if (!e.isTrusted || e.isComposing || !(el instanceof HTMLTextAreaElement)) return;
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    if (e.timeStamp - enterKeyAt < 500) return; // keydown saw this Enter (and its modifiers) and let it through
    if (!settings().closeEnter || !inScope(el) || el.selectionStart !== el.selectionEnd) return;
    const c = el.selectionStart;
    if (closeAt(el, c, c, false)) e.preventDefault();
}

function onFocusIn(e) {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement)) return;
    last = { el, value: el.value };
    spaceMark = null;
    // SillyTavern focuses the box by itself when a chat opens (no keyboard on phones), so
    // focus alone doesn't show the bar — only focus that follows a real tap on the box does.
    if (isSendBox(el) && Date.now() - lastTapOnBox < 1500) showBar();
}

/** Time of the last real (not scripted) tap or click on the send box. */
let lastTapOnBox = 0;

function onUserTouch(e) {
    if (!e.isTrusted || !isSendBox(e.target)) return;
    if (e.type === 'pointerdown') lastTapOnBox = Date.now();
    else if (document.activeElement === e.target) showBar(); // tapped a box that was already focused: no focusin
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
        bar.innerHTML = '<div class="aq_row">'
            + '<button type="button" class="aq_btn aq_undo" tabindex="-1" title="เลิกทำ (Undo)"><i class="fa-solid fa-rotate-left"></i></button>'
            + '<button type="button" class="aq_btn aq_redo" tabindex="-1" title="ทำซ้ำ (Redo)"><i class="fa-solid fa-rotate-right"></i></button>'
            + '<div class="aq_scroll"></div>'
            + '<button type="button" class="aq_btn aq_close" tabindex="-1" title="ปิดเครื่องหมายที่ค้างอยู่"></button></div>';
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

// The bar's state (close button, undo) is refreshed once typing pauses, not on every key.
let barTimer = null;
function scheduleBarUpdate() {
    if (!bar || bar.hidden) return;
    clearTimeout(barTimer);
    barTimer = setTimeout(updateBar, 150);
}

/** Write to the DOM only when something changes, so a refresh costs no layout. */
const setHidden = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };

function updateBar() {
    if (!bar || bar.hidden) return;
    const el = $id('send_textarea');
    if (!el) return;
    const selected = el.selectionStart !== el.selectionEnd;
    bar.classList.toggle('aq_selecting', selected);
    const btn = bar.querySelector('.aq_close');
    const hit = settings().closeButton && !selected && inScope(el) ? pendingClose(el.value.slice(0, el.selectionStart), table) : null;
    setHidden(btn, !hit);
    if (hit && btn.textContent !== hit.close) btn.textContent = hit.close;
    const showUndo = settings().undoButton;
    const u = bar.querySelector('.aq_undo'), r = bar.querySelector('.aq_redo');
    setHidden(u, !showUndo);
    u.classList.toggle('aq_off', !canUndo(el)); // not `disabled`: taps on a disabled button would move focus out of the box
    setHidden(r, !showUndo || !canRedo(el));
}

function onBarClick(e) {
    const btn = e.target.closest('.aq_btn');
    const el = $id('send_textarea');
    if (!btn || !el) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    const s = settings();
    const start = el.selectionStart, end = el.selectionEnd;

    if (btn.classList.contains('aq_undo')) { undo(el); return; }
    if (btn.classList.contains('aq_redo')) { redo(el); return; }
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
                <b>Typing Buddy <small class="aq_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="aq_tabs">
                    <div class="aq_tab aq_active" data-tab="settings"><i class="fa-solid fa-sliders"></i> ตั้งค่า</div>
                    <div class="aq_tab" data-tab="example"><i class="fa-solid fa-palette"></i> ตัวอย่างการแสดงผล</div>
                </div>
                <div class="aq_page" data-page="settings">
                <label class="checkbox_label"><input type="checkbox" id="aq_enabled"> เปิดใช้งาน</label>

                <div class="aq_set_title">ปิดเครื่องหมายที่เปิดค้างด้วย… <small class="aq_note aq_inline">(เลือกได้หลายแบบ)</small></div>
                <div class="aq_set_row">
                    <label class="checkbox_label"><input type="checkbox" id="aq_autoclose"> เว้นวรรคติดกัน</label>
                    <select id="aq_spaces" class="text_pole aq_select">
                        <option value="2">2 ครั้ง</option>
                        <option value="3">3 ครั้ง</option>
                    </select>
                </div>
                <label class="checkbox_label"><input type="checkbox" id="aq_enter"> Enter หนึ่งครั้ง</label>
                <small class="aq_note aq_indent">ตอนมีเครื่องหมายเปิดค้าง Enter จะปิดให้แทนการขึ้นบรรทัดหรือส่งข้อความ · ปิดครบแล้วกด Enter อีกทีถึงจะขึ้นบรรทัด/ส่งตามปกติ</small>
                <label class="checkbox_label"><input type="checkbox" id="aq_hold"> กด spacebar ค้าง</label>
                <small class="aq_note aq_indent">ใช้ได้กับคีย์บอร์ดจริงเท่านั้น (คอม, คีย์บอร์ดบลูทูธ) · คีย์บอร์ดมือถือใช้การกด spacebar ค้างเลื่อนเคอร์เซอร์ และไม่ส่งสัญญาณนี้ให้หน้าเว็บ</small>
                <label class="checkbox_label"><input type="checkbox" id="aq_spaceafter"> เว้นวรรคหนึ่งช่องหลังปิด <small class="aq_note aq_inline">(แบบเว้นวรรคและกดค้าง)</small></label>

                <div class="aq_set_title">ตอนพิมพ์</div>
                <label class="checkbox_label"><input type="checkbox" id="aq_fixdir"> กลับทิศ “ ” ‘ ’ ที่พิมพ์ผิดด้าน</label>
                <small class="aq_note">หลังช่องว่างหรือต้นบรรทัดจะเป็นตัวเปิดเสมอ · พิมพ์ตัวเปิดต่อท้ายคำตอนที่มีตัวเปิดค้างอยู่จะกลายเป็นตัวปิด</small>
                <label class="checkbox_label"><input type="checkbox" id="aq_straight"> เปลี่ยน " ตรง ๆ เป็น “ ” อัตโนมัติ</label>

                <div class="aq_set_title">แถบเครื่องหมายเหนือช่องพิมพ์</div>
                <label class="checkbox_label"><input type="checkbox" id="aq_toolbar"> แสดงตอนเคอร์เซอร์อยู่ในช่องพิมพ์</label>
                <label class="checkbox_label aq_indent"><input type="checkbox" id="aq_closebtn"> ปุ่มปิดเครื่องหมายที่ค้างอยู่ (ขวาสุด)</label>
                <label class="checkbox_label aq_indent"><input type="checkbox" id="aq_undobtn"> ปุ่มเลิกทำ / ทำซ้ำ (ซ้ายสุด)</label>
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

                <div class="aq_page" data-page="example" hidden>
                    <small class="aq_note">ข้อความด้านล่างผ่านตัวแปลง Markdown ตัวเดียวกับแชท (รวม regex ที่ใช้ตอนแสดงผล) และใช้โครงสร้างข้อความแชทจริง แก้ Custom CSS แล้วเห็นผลทันที</small>
                    <div class="aq_btns">
                        <div class="aq_seg">
                            <div class="menu_button aq_who aq_active" data-who="char"><i class="fa-solid fa-robot"></i> ตัวละคร</div>
                            <div class="menu_button aq_who" data-who="user"><i class="fa-solid fa-user"></i> ผู้ใช้</div>
                        </div>
                        <div id="aq_ex_chat" class="menu_button" title="ใส่ข้อความตัวอย่างชั่วคราวท้ายแชท สำหรับ CSS ที่เขียนแบบ #chat .mes … (ไม่บันทึกลงแชท หายเองตอนส่งข้อความหรือเปลี่ยนแชท)"><i class="fa-solid fa-comment-dots"></i> แสดงในแชท</div>
                        <div id="aq_ex_editbtn" class="menu_button"><i class="fa-solid fa-pen"></i> แก้ข้อความตัวอย่าง</div>
                    </div>
                    <div id="aq_ex_editor" hidden>
                        <textarea id="aq_ex_text" class="text_pole" rows="10" data-aq-off spellcheck="false"></textarea>
                        <div class="aq_btns">
                            <div id="aq_ex_reset" class="menu_button"><i class="fa-solid fa-rotate-left"></i> ใช้ข้อความเริ่มต้น</div>
                        </div>
                    </div>
                    <div id="aq_ex_preview" class="aq_ex_preview"></div>

                    <div class="aq_set_title">สีจากธีม <small class="aq_note aq_inline">(ตัวแปร CSS · แตะเพื่อคัดลอกชื่อ)</small> <i id="aq_ex_refresh" class="fa-solid fa-arrows-rotate aq_icon_btn" title="อ่านค่าใหม่"></i></div>
                    <div id="aq_ex_vars" class="aq_ex_vars"></div>
                </div>
            </div>
        </div>
    </div>`);

    const bind = (id, key, after) => {
        const el = /** @type {HTMLInputElement} */ ($id(id));
        el.checked = !!s[key];
        el.addEventListener('change', () => { s[key] = el.checked; save(); after?.(); });
    };
    const refreshBar = () => { renderBar(); if (!s.enabled || !s.toolbar) hideBar(); else updateBar(); };
    bind('aq_enabled', 'enabled', refreshBar);
    bind('aq_autoclose', 'autoClose');
    bind('aq_enter', 'closeEnter');
    bind('aq_hold', 'closeHold');
    const spaces = /** @type {HTMLSelectElement} */ ($id('aq_spaces'));
    spaces.value = String(s.closeSpaces === 3 ? 3 : 2);
    spaces.addEventListener('change', () => { s.closeSpaces = Number(spaces.value); save(); });
    bind('aq_spaceafter', 'spaceAfterClose');
    bind('aq_fixdir', 'fixDirection');
    bind('aq_straight', 'straightToCurly');
    bind('aq_toolbar', 'toolbar', refreshBar);
    bind('aq_closebtn', 'closeButton', updateBar);
    bind('aq_undobtn', 'undoButton', updateBar);
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

    const root = $id('aq_settings');
    root.querySelectorAll('.aq_tab').forEach(tab => tab.addEventListener('click', () => {
        root.querySelectorAll('.aq_tab').forEach(t => t.classList.toggle('aq_active', t === tab));
        root.querySelectorAll('.aq_page').forEach(p => { p.hidden = p.dataset.page !== tab.dataset.tab; });
        if (tab.dataset.tab === 'example') renderExample();
    }));
    root.querySelectorAll('.aq_who').forEach(b => b.addEventListener('click', () => {
        exampleWho = b.dataset.who;
        root.querySelectorAll('.aq_who').forEach(x => x.classList.toggle('aq_active', x === b));
        renderExample();
    }));
    const exText = /** @type {HTMLTextAreaElement} */ ($id('aq_ex_text'));
    exText.value = s.sample || DEFAULT_SAMPLE;
    $id('aq_ex_editbtn').addEventListener('click', () => { $id('aq_ex_editor').hidden = !$id('aq_ex_editor').hidden; });
    exText.addEventListener('input', () => { s.sample = exText.value === DEFAULT_SAMPLE ? '' : exText.value; save(); renderExampleSoon(); });
    $id('aq_ex_reset').addEventListener('click', () => { exText.value = DEFAULT_SAMPLE; s.sample = ''; save(); renderExample(); });
    $id('aq_ex_chat').addEventListener('click', showExampleInChat);
    $id('aq_ex_refresh').addEventListener('click', renderThemeVars);
    $id('aq_ex_vars').addEventListener('click', e => {
        const row = e.target.closest('[data-var]');
        if (!row) return;
        navigator.clipboard?.writeText(`var(${row.dataset.var})`).then(() => globalThis.toastr?.success(`คัดลอก var(${row.dataset.var}) แล้ว`, 'Typing Buddy'), () => {});
    });
}

// ---------------------------------------------------------------- example tab
//
// A chat message built from SillyTavern's own message template and formatted
// by its own messageFormatting(), so theme CSS hits it the way it hits chat.

const DEFAULT_SAMPLE = [
    '# หัวข้อ (h1)',
    '## หัวข้อรอง (h2)',
    '### หัวข้อย่อย (h3)',
    '',
    'บรรยายธรรมดา *ตัวเอียง* **ตัวหนา** ***หนาเอียง*** __ขีดเส้นใต้__ ~~ขีดฆ่า~~ `โค้ด`',
    '',
    '"straight quote" “curly quote” «guillemets» 「かぎかっこ」 『二重かぎかっこ』',
    '',
    '*“คำพูดในตัวเอียง”* · “คำพูดที่มี *ตัวเอียง* ข้างใน” · **“คำพูดตัวหนา”** · “คำพูดที่มี **ตัวหนา** ข้างใน”',
    '',
    '*บรรยายตัวเอียงที่มี “คำพูด” อยู่ข้างใน* (วงเล็บ) 【วงเล็บญี่ปุ่น】',
    '',
    '> blockquote — *ตัวเอียง* **ตัวหนา** และ “คำพูด”',
    '',
    '- รายการ',
    '- รายการที่มี “คำพูด”',
    '  1. รายการซ้อน',
    '',
    '| หัวตาราง | หัวตาราง |',
    '|---|---|',
    '| ช่อง | “คำพูด” |',
    '',
    '[ลิงก์](https://github.com/SillyTavern/SillyTavern)',
    '',
    '---',
    '',
    '```',
    'code block',
    '```',
].join('\n');

let exampleWho = 'char';

/** Avatar of the latest message from that side, so the example looks like this chat. */
function exampleAvatar(isUser) {
    const img = [...document.querySelectorAll(`#chat .mes[is_user="${isUser}"]:not(.aq_preview_mes) .avatar img`)].at(-1);
    return img?.getAttribute('src') || 'img/ai4.png';
}

function buildExampleMessage() {
    const isUser = exampleWho === 'user';
    const c = ctx();
    const name = (isUser ? c.name1 : c.name2) || (isUser ? 'User' : 'Character');
    const text = settings().sample || DEFAULT_SAMPLE;
    let html;
    try {
        html = c.messageFormatting(text, name, false, isUser, -1);
    } catch (err) {
        console.warn(LOG, 'messageFormatting failed', err);
        html = `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
    }
    const tpl = document.querySelector('#message_template .mes');
    const mes = tpl ? /** @type {HTMLElement} */ (tpl.cloneNode(true)) : document.createElement('div');
    if (!tpl) mes.innerHTML = '<div class="mes_block"><div class="ch_name"><span class="name_text"></span></div><div class="mes_text"></div></div>';
    mes.classList.add('mes', 'aq_example_mes');
    mes.removeAttribute('mesid');
    mes.setAttribute('ch_name', name);
    mes.setAttribute('is_user', String(isUser));
    mes.setAttribute('is_system', 'false');
    // nothing in here may act on a real message
    mes.querySelectorAll('.mes_buttons, .mes_edit_buttons, .swipe_left, .swipe_right, .swipeRightBlock, .del_checkbox, .for_checkbox, .mes_bookmark').forEach(n => n.remove());
    const img = mes.querySelector('.avatar img');
    if (img) img.setAttribute('src', exampleAvatar(isUser));
    const nameEl = mes.querySelector('.name_text');
    if (nameEl) nameEl.textContent = name;
    const textEl = mes.querySelector('.mes_text');
    if (textEl) textEl.innerHTML = html;
    return mes;
}

function renderExample() {
    const box = $id('aq_ex_preview');
    if (!box || $id('aq_settings').querySelector('[data-page="example"]').hidden) return;
    box.replaceChildren(buildExampleMessage());
    renderThemeVars();
}

let exampleTimer = null;
const renderExampleSoon = () => { clearTimeout(exampleTimer); exampleTimer = setTimeout(renderExample, 300); };

const THEME_VARS = [
    ['--SmartThemeBodyColor', 'ตัวอักษรหลัก', 'Main Text'],
    ['--SmartThemeEmColor', 'ตัวเอียง', 'Italics Text'],
    ['--SmartThemeUnderlineColor', 'ขีดเส้นใต้', 'Underlined Text'],
    ['--SmartThemeQuoteColor', 'คำพูด', 'Quote Text'],
    ['--SmartThemeShadowColor', 'เงาตัวอักษร', 'Shadow Color'],
    ['--SmartThemeChatTintColor', 'พื้นแชท', 'Chat Background'],
    ['--SmartThemeBlurTintColor', 'พื้นเบลอ', 'UI Background'],
    ['--SmartThemeUserMesBlurTintColor', 'ข้อความผู้ใช้', 'User Message'],
    ['--SmartThemeBotMesBlurTintColor', 'ข้อความตัวละคร', 'AI Message'],
    ['--SmartThemeBorderColor', 'ขอบ', 'UI Border'],
    ['--SmartThemeBlurStrength', 'ความเบลอ', 'Blur Strength'],
    ['--mainFontSize', 'ขนาดตัวอักษร', 'Font Scale'],
    ['--mainFontFamily', 'ฟอนต์หลัก', 'Main Font'],
];

function renderThemeVars() {
    const box = $id('aq_ex_vars');
    if (!box) return;
    const cs = getComputedStyle(document.documentElement);
    box.innerHTML = THEME_VARS.map(([v, label, stName]) => {
        const val = cs.getPropertyValue(v).trim();
        if (!val) return '';
        const isColor = /color/i.test(v);
        return `<div class="aq_var" data-var="${v}" title="${esc(stName)} (User Settings) · แตะเพื่อคัดลอก var(${v})">
            ${isColor ? `<span class="aq_swatch" style="box-shadow: inset 0 0 0 20px ${esc(val)}"></span>` : '<span class="aq_swatch aq_noswatch"><i class="fa-solid fa-font"></i></span>'}
            <span class="aq_var_text"><b>${esc(label)}</b><code>${esc(v)}</code><small>${esc(val)}</small></span>
        </div>`;
    }).join('');
}

/** A temporary copy of the example at the end of the chat, for CSS written as #chat .mes …; never saved. */
function showExampleInChat() {
    const chat = $id('chat');
    if (!chat) return;
    removeExampleFromChat();
    const mes = buildExampleMessage();
    mes.classList.add('aq_preview_mes');
    const close = document.createElement('div');
    close.className = 'aq_preview_close menu_button';
    close.innerHTML = '<i class="fa-solid fa-xmark"></i> เอาตัวอย่างออก';
    close.addEventListener('click', removeExampleFromChat);
    mes.querySelector('.mes_block')?.append(close);
    chat.append(mes);
    mes.scrollIntoView({ block: 'start', behavior: 'smooth' });
    globalThis.toastr?.info('ใส่ตัวอย่างไว้ท้ายแชทแล้ว ปิดหน้าตั้งค่าเพื่อดู · หายเองตอนส่งข้อความหรือเปลี่ยนแชท', 'Typing Buddy');
}

function removeExampleFromChat() {
    document.querySelectorAll('#chat .aq_preview_mes').forEach(n => n.remove());
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
    globalThis.toastr?.info(`ติดตั้ง v${esc(remote)} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION} อยู่<br>แตะที่นี่เพื่อโหลดเวอร์ชันใหม่`, 'Typing Buddy', {
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
    if (globalThis.TypingBuddy) return; // loaded twice
    settings();
    rebuildTable();
    renderSettings();
    renderBar();

    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', e => { if (e.key === ' ') holding = null; }, true);
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('selectionchange', scheduleBarUpdate);
    document.addEventListener('keyup', e => { if (isSendBox(e.target)) scheduleBarUpdate(); });
    document.addEventListener('pointerup', e => { if (isSendBox(e.target)) scheduleBarUpdate(); });
    document.addEventListener('pointerdown', onUserTouch, true);
    document.addEventListener('click', onUserTouch, true);
    // typing into a box that was focused by script (desktop) shows the bar too
    document.addEventListener('keydown', e => { if (bar?.hidden !== false && e.isTrusted && isSendBox(e.target) && document.activeElement === e.target) showBar(); }, true);

    const { eventSource, event_types: E } = ctx();
    eventSource.once(E.APP_READY, renderBar);
    if (E.CHAT_CHANGED) eventSource.on(E.CHAT_CHANGED, hideBar);
    // the in-chat example must be gone before SillyTavern touches the message list
    for (const ev of ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'GENERATION_STARTED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED']) {
        if (E[ev]) eventSource.on(E[ev], removeExampleFromChat);
    }
    if (E.MESSAGE_SENT) eventSource.on(E.MESSAGE_SENT, () => { hist.typing = false; });

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForNewVersion(); });
    setTimeout(checkForNewVersion, 3000);
    globalThis.TypingBuddy = { VERSION, settings, checkForNewVersion, reloadWithFreshFiles, get table() { return table; } };
    console.log(LOG, 'loaded', `v${VERSION}`);
}

if (typeof jQuery === 'function') jQuery(init); else init();
