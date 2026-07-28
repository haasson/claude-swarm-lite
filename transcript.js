'use strict';
// Reading the status off Claude's OWN transcript — the third channel, next to screen
// scraping (screen.js) and hooks (osc.js). Claude Code appends every message to
// ~/.claude/projects/<slug>/<session-id>.jsonl as it happens, so the file tells us
// what the agent is doing without a single spawned process per tool call and without
// guessing from pixels:
//
//   last entry is assistant/tool_use   → a tool is running        → работает
//   last entry is user/tool_result     → the model is thinking    → работает
//   last entry is a user prompt        → you just sent something  → работает
//   last entry is assistant text, quiet→ the turn ended           → готов / ждёт
//
// What it CANNOT see is UI state: a permission dialog on screen looks exactly like a
// long-running tool (an open tool_use with no result yet). That stays with the
// PermissionRequest hook / the prompt box on screen.
//
// This module is pure — it takes already-read text and returns a verdict, so it's
// unit-testable on fixtures. The file I/O and the tab↔file matching live in main.js.

// Claude Code's folder name for a project: the absolute path with every separator
// (and dot) flattened to '-'. We don't rely on this being exact — main.js verifies a
// candidate file by the `cwd` recorded INSIDE it — but it gets us to the right
// directory on the first try.
function projectSlug(cwd) {
  return String(cwd || '').replace(/[/\\.]/g, '-');
}

// Lines that are conversation; everything else in the file (mode, permission-mode,
// ai-title, last-prompt, file-history-*) is bookkeeping we skip.
const MSG_TYPES = new Set(['assistant', 'user']);

// Parse the tail of a .jsonl into conversation entries, newest last. Broken lines are
// skipped: the tail read can start mid-line, and the file may be written as we read.
function parseEntries(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let d;
    try { d = JSON.parse(t); } catch (_) { continue; }
    if (!d || !MSG_TYPES.has(d.type)) continue;
    out.push(d);
  }
  return out;
}

// The content blocks of an entry, as a list of types ('text' | 'thinking' |
// 'tool_use' | 'tool_result'). A string content counts as one text block.
function blockTypes(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return ['text'];
  if (!Array.isArray(c)) return [];
  return c.map((b) => (b && b.type) || '');
}

// The plain text of an entry (all text blocks joined) — this is what the call phrases
// are matched against. Thinking blocks are NOT included: the user never sees them.
function entryText(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n');
}

function tsOf(entry) {
  const t = Date.parse((entry && entry.timestamp) || '');
  return Number.isFinite(t) ? t : 0;
}

// The last entry of the MAIN thread. Sub-agent lines (isSidechain) interleave with it
// and must not drive the tab's status — a sub-agent finishing is not the turn ending.
function lastMain(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i].isSidechain) return entries[i];
  }
  return null;
}

// How long after the last assistant text we still say «работает». Claude routinely
// writes a paragraph and then keeps going (another tool, more text), so calling
// «готов» on the first quiet tick would flap. This is the only timer here, and it's
// over structured events, not over bytes on screen.
const READY_DEBOUNCE_MS = 1200;

// The verdict. `asks(text)` decides whether a finished turn is actually a question
// (the user's call phrases — see ask-phrases.js); pass a function so this module
// stays free of that config. Returns null when the transcript says nothing yet.
//   { status, kind, why, at, text }
function classify(entries, now, asks) {
  const e = lastMain(entries);
  if (!e) return null;
  const at = tsOf(e);
  const kinds = blockTypes(e);

  if (kinds.includes('tool_use')) {
    // A tool was requested. It's either running, or sitting behind a permission
    // dialog — the transcript can't tell those apart, both are «not your turn yet».
    return { status: 'running', kind: null, why: 'tool_use', at, text: '' };
  }
  if (kinds.includes('tool_result')) {
    return { status: 'running', kind: null, why: 'tool_result', at, text: '' };
  }
  if (e.type === 'user') {
    // A real prompt from you (not a tool result) — the agent is about to work.
    return { status: 'running', kind: null, why: 'prompt', at, text: '' };
  }
  // An assistant message with only text/thinking: the turn MAY have ended.
  const text = entryText(e);
  if (now - at < READY_DEBOUNCE_MS) {
    return { status: 'running', kind: null, why: 'text (fresh)', at, text };
  }
  if (typeof asks === 'function' && asks(text)) {
    return { status: 'waiting', kind: 'question', why: 'text + call phrase', at, text };
  }
  return { status: 'ready', kind: null, why: 'text (quiet)', at, text };
}

// The cwd a transcript belongs to, from the newest entry that records one. Used to
// bind a file to the right tab instead of trusting the folder-name slug.
function cwdOf(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].cwd) return entries[i].cwd;
  }
  return null;
}

// Tabs whose Claude session id we know bind by file name. This is for the others (a
// resumed tab with hooks off, `claude` typed by hand): pick the file among candidates
// main already read off disk — `{ file, mtimeMs, cwdInside }`.
//
// A candidate must have been written since the tab opened (an older file belongs to a
// past session) and record the same cwd inside. And if TWO survive that, we bind
// NOTHING: driving a tab off another agent's transcript is far worse than falling back
// to the screen scraper. Pure, so that rule is pinned by a test.
const BIND_MTIME_SLACK_MS = 2000;   // clock/fs jitter around the tab's own start

function pickBinding(cands, opts) {
  const o = opts || {};
  const taken = o.taken || new Set();
  const hits = [];
  for (const c of Array.isArray(cands) ? cands : []) {
    if (!c || !c.file || taken.has(c.file)) continue;
    if (!(c.mtimeMs >= (o.startedAt || 0) - BIND_MTIME_SLACK_MS)) continue;
    if (c.cwdInside !== o.cwd) continue;
    hits.push(c.file);
    if (hits.length > 1) return null;
  }
  return hits[0] || null;
}

module.exports = {
  READY_DEBOUNCE_MS, BIND_MTIME_SLACK_MS,
  projectSlug, parseEntries, blockTypes, entryText, lastMain, classify, cwdOf, pickBinding,
};
