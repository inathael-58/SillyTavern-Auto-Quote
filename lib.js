/*
 * Auto Quote — text logic (no DOM)
 *
 * Everything here works on plain strings and selection offsets, so it can be
 * tested without a browser. index.js turns the results into textarea edits.
 */

export const DEFAULT_PAIRS = [
    '“ ”',
    '‘ ’',
    '" "',
    '*** ***',
    '** **',
    '* *',
    '( )',
    '「 」',
    '『 』',
    '（ ）',
    '【 】',
    '《 》',
    '〈 〉',
    '« »',
    '[ ]',
    '~~ ~~',
    '` `',
].join('\n');

export const DEFAULT_TOOLBAR = '“ ‘ * ** *** ( 「 『 【 >';

/** Toolbar token for "turn the line(s) into a Markdown blockquote". */
export const BLOCKQUOTE = '>';

const WS = /\s/;
const LETTER = /[\p{L}\p{N}]/u;
/** Curly quotes whose direction we correct as they are typed (fonts often draw both ends almost alike). */
const CURLY = Object.freeze({
    '“': { open: '“', close: '”', role: 'open' },
    '”': { open: '“', close: '”', role: 'close' },
    '‘': { open: '‘', close: '’', role: 'open' },
    '’': { open: '‘', close: '’', role: 'close' },
});
const ALWAYS_OPENING = '“‘«「『（【《〈([{';

/**
 * Parse "open close" lines into a lookup table. One token on a line = the same
 * mark on both sides (Markdown style). Unparseable lines are skipped.
 */
export function buildTable(text) {
    const pairs = [];
    for (const raw of String(text ?? '').split('\n')) {
        const parts = raw.trim().split(/\s+/).filter(Boolean);
        if (!parts.length) continue;
        const open = parts[0], close = parts[1] ?? parts[0];
        if (pairs.some(p => p.open === open)) continue;
        const sym = open === close;
        const run = sym && /^(.)\1*$/u.test(open) ? open[0] : null; // * ** *** ~~ ` "
        pairs.push({ open, close, sym, run });
    }

    /** run char → its pairs, longest first */
    const runs = new Map();
    for (const p of pairs.filter(p => p.run)) {
        if (!runs.has(p.run)) runs.set(p.run, []);
        runs.get(p.run).push(p);
    }
    for (const list of runs.values()) list.sort((a, b) => b.open.length - a.open.length);

    /** every other mark, longest first so “«” style multi-char marks win */
    const tokens = [];
    for (const p of pairs.filter(p => !p.run)) {
        if (p.sym) tokens.push({ s: p.open, pair: p, role: 'sym' });
        else tokens.push({ s: p.open, pair: p, role: 'open' }, { s: p.close, pair: p, role: 'close' });
    }
    tokens.sort((a, b) => b.s.length - a.s.length);

    const openChars = new Set(ALWAYS_OPENING);
    for (const p of pairs) if (!p.sym) openChars.add(p.open.at(-1));

    return { pairs, runs, tokens, openChars, byOpen: new Map(pairs.map(p => [p.open, p])) };
}

/** Start of the paragraph the offset is in — marks are never matched across a blank line. */
function paragraphStart(text) {
    const m = /\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/.exec(text);
    return m ? m.index + m[0].length : 0;
}

/**
 * Walk the text and return the marks that are still open at its end,
 * innermost last: [{ pair, end }] where end is the offset just after the opener.
 *
 * Openers must be followed by text (so “:(” and “2 * 3” are not openers);
 * closers must follow text. A closer only closes a matching open mark, and ’
 * between letters is an apostrophe, not a closer.
 */
export function openMarks(text, table) {
    const stack = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        const runPairs = table.runs.get(ch);
        if (runPairs) {
            let n = 1;
            while (text[i + n] === ch) n++;
            const prev = text[i - 1], next = text[i + n];
            const canClose = prev !== undefined && !WS.test(prev);
            const canOpen = next === undefined || !WS.test(next);
            let left = n;
            if (canClose) {
                while (left > 0) {
                    const top = stack.at(-1);
                    if (!top || top.pair.run !== ch) break;
                    const len = top.pair.open.length;
                    if (len <= left) { left -= len; stack.pop(); continue; }
                    const rest = runPairs.find(p => p.open.length === len - left); // "***bold italic* bold" → ** stays open
                    if (rest) { top.pair = rest; left = 0; }
                    break;
                }
            }
            if (left > 0 && canOpen) {
                const p = runPairs.find(q => q.open.length <= left);
                if (p) stack.push({ pair: p, end: i + n });
            }
            i += n;
            continue;
        }

        const tok = table.tokens.find(t => text.startsWith(t.s, i));
        if (tok) {
            const prev = text[i - 1], next = text[i + tok.s.length];
            const followedByText = next === undefined || !WS.test(next);
            const k = stack.findLastIndex(e => e.pair === tok.pair);
            if (tok.role === 'open' || (tok.role === 'sym' && k < 0)) {
                if (followedByText) stack.push({ pair: tok.pair, end: i + tok.s.length });
            } else if (k >= 0 && prev !== undefined && !WS.test(prev)) {
                const apostrophe = (tok.s === '’' || tok.s === "'") && next !== undefined && LETTER.test(next);
                if (!apostrophe) stack.length = k;
            }
            i += tok.s.length;
            continue;
        }
        i++;
    }
    return stack;
}

/**
 * The closing mark that belongs at the end of `before` (the text before the
 * caret), or null when nothing is open or the open mark has nothing after it yet.
 * `trimmed` is `before` without trailing whitespace — where the closer goes.
 */
export function pendingClose(before, table) {
    const trimmed = before.replace(/\s+$/, '');
    const start = paragraphStart(trimmed);
    const para = trimmed.slice(start);
    const top = openMarks(para, table).at(-1);
    if (!top || !para.slice(top.end).trim()) return null;
    return { close: top.pair.close, pair: top.pair, at: trimmed.length };
}

/**
 * True when a quote typed after `before` should be an opening one: at the
 * start, after whitespace or after another opening bracket. Markdown marks in
 * between are skipped, so ` *“` opens and `word*”` closes.
 */
export function isOpeningContext(before, table) {
    let j = before.length;
    while (j > 0 && table.runs.has(before[j - 1])) j--;
    const ch = before[j - 1];
    return ch === undefined || WS.test(ch) || table.openChars.has(ch);
}

/**
 * The character that should replace a quote `ch` just typed after `before`,
 * or null when it is already right.
 */
export function correctQuote(ch, before, table, { straight = false } = {}) {
    if (ch === '"') {
        if (!straight) return null;
        const want = isOpeningContext(before, table) ? '“' : '”';
        return want;
    }
    const q = CURLY[ch];
    if (!q) return null;
    const opening = isOpeningContext(before, table);
    let want = ch;
    if (q.role === 'close' && opening) want = q.open;
    else if (q.role === 'open' && !opening) {
        if (q.open === '‘' && LETTER.test(before.at(-1) ?? '')) want = '’'; // it‘s → it’s
        else {
            const para = before.slice(paragraphStart(before));
            if (openMarks(para, table).some(e => e.pair.open === q.open && e.pair.close === q.close)) want = q.close;
        }
    }
    return want === ch ? null : want;
}

/** Text to insert for an opener tapped on the toolbar: a space first when it would stick to a word. */
export function openerInsert(before, pair, table, spaceBefore) {
    const needSpace = spaceBefore && before.length > 0 && !isOpeningContext(before, table);
    return (needSpace ? ' ' : '') + pair.open;
}

const leadWs = s => s.length - s.trimStart().length;
const trailWs = s => s.length - s.trimEnd().length;
const runAt = (s, i, ch, dir) => { let n = 0; while (s[i + dir * n + (dir < 0 ? -1 : 0)] === ch) n++; return n; };

/**
 * Toggle `pair` around the selected text [s, e) of `value`.
 * Returns { start, end, text, selStart, selEnd }: replace value[start, end)
 * with text, then select [selStart, selEnd).
 *
 * - whitespace at the selection edges stays outside the marks
 * - already wrapped (inside or just outside the selection) → unwrap
 * - * / ** / *** combine: italic on bold gives ***, italic off *** gives **
 * - several lines → each non-empty line separately (Markdown marks don't span lines)
 */
export function toggleWrap(value, s, e, pair, table) {
    const seg = value.slice(s, e);
    if (seg.includes('\n')) {
        const text = seg.split('\n').map(line => {
            const a = leadWs(line), b = line.length - trailWs(line);
            if (a >= b) return line;
            return line.slice(0, a) + toggleCore(line, a, b, pair, table, false).text + line.slice(b);
        }).join('\n');
        return { start: s, end: e, text, selStart: s, selEnd: s + text.length };
    }
    const cs = s + leadWs(seg), ce = e - trailWs(seg);
    if (cs >= ce) return null;
    const r = toggleCore(value, cs, ce, pair, table, true);
    return { start: r.start, end: r.end, text: r.text, selStart: r.start, selEnd: r.start + r.text.length };
}

/** Does `core` start with an opener of `pair` that stays open until its last `closeLen` characters? */
function wrapsWhole(core, pair, openLen, closeLen, table) {
    return openMarks(core.slice(0, core.length - closeLen), table)
        .some(m => m.end === openLen && (m.pair === pair || m.pair.run && m.pair.run === pair.run));
}

function toggleCore(value, cs, ce, pair, table, lookOutside) {
    const core = value.slice(cs, ce);
    if (pair.run && (pair.run === '*' || pair.run === '_')) {
        const ch = pair.run;
        // all-marks selections ("***") have no inside; just wrap them
        let n = /^(.)\1*$/u.test(core) && core[0] === ch ? 0 : Math.min(runAt(core, 0, ch, 1), runAt(core, core.length, ch, -1), 3);
        if (n > 0 && !wrapsWhole(core, pair, runAt(core, 0, ch, 1), n, table)) n = 0; // "*a* and *b*" is two spans, not one
        let start = cs, end = ce, inner = core.slice(n, core.length - n);
        if (n === 0 && lookOutside) {
            const o = Math.min(runAt(value, cs, ch, -1), runAt(value, ce, ch, 1), 3);
            if (o > 0) { n = o; start = cs - o; end = ce + o; inner = core; }
        }
        const k = pair.open.length;
        const next = k >= 3 ? (n === 3 ? 0 : 3) : n ^ k;
        const marks = ch.repeat(next);
        return { start, end, text: marks + inner + marks };
    }
    const { open, close } = pair;
    if (core.length >= open.length + close.length && core.startsWith(open) && core.endsWith(close)
        && wrapsWhole(core, pair, open.length, close.length, table)) {
        return { start: cs, end: ce, text: core.slice(open.length, core.length - close.length) };
    }
    if (lookOutside && value.slice(cs - open.length, cs) === open && value.slice(ce, ce + close.length) === close) {
        return { start: cs - open.length, end: ce + close.length, text: core };
    }
    return { start: cs, end: ce, text: open + core + close };
}

/**
 * Toggle "> " on every non-empty line touched by [s, e).
 * Returns the same shape as toggleWrap.
 */
export function toggleBlockquote(value, s, e) {
    const start = value.lastIndexOf('\n', s - 1) + 1;
    let end = value.indexOf('\n', Math.max(e - (e > s && value[e - 1] === '\n' ? 1 : 0), s));
    if (end < 0) end = value.length;
    const lines = value.slice(start, end).split('\n');
    const filled = lines.filter(l => l.trim());
    const quoted = filled.length > 0 && filled.every(l => /^\s*>/.test(l));
    const text = lines.map(l => !l.trim() ? l : quoted ? l.replace(/^(\s*)> ?/, '$1') : '> ' + l).join('\n');
    const caretShift = text.length - (end - start);
    const collapsed = s === e;
    return {
        start, end, text,
        selStart: collapsed ? Math.max(start, s + caretShift) : start,
        selEnd: collapsed ? Math.max(start, s + caretShift) : start + text.length,
    };
}
