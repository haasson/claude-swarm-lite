'use strict';
// Pure screen-scraping helpers for the status detector. Kept out of main.js so
// they're unit-testable in plain node, like git.js / updater-core.js.

// --- the snapshot window ------------------------------------------------------
// What the detector actually looks at: the bottom rows of the emulator. The window
// must be anchored to the last row that HAS content, never to buf.length.
//
// Claude Code's UI is a TUI frame that grows and shrinks (spinner block, permission
// box, a multi-line input collapsing after submit). Shrinking is drawn as "cursor up
// N rows + erase to end of screen" — the rows the tall frame had scrolled into the
// buffer stay allocated, just blank, and buf.length NEVER shrinks. A window anchored
// to buf.length then slides off the real screen into that emptiness, so every marker
// (prompt box, spinner, «Сейчас от тебя») reads as absent and the tab paints a false
// «готов» while a question sits visible on screen.

// The row after the last one with content (an exclusive end index).
function contentEnd(buf) {
  let end = buf.length;
  while (end > 0) {
    const line = buf.getLine(end - 1);
    const text = line ? line.translateToString(true) : '';
    if (text.trim()) break;
    end--;
  }
  return end;
}

// The bottom `rows` rows of the screen that carry content, as one string.
function snapshotRows(buf, rows) {
  const end = contentEnd(buf);
  const start = Math.max(0, end - rows);
  const out = [];
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    if (line) out.push(line.translateToString(true));
  }
  return out.join('\n');
}

// A selection row before the answer: "❯ 1. Yes". Claude Code paints ❯, but
// Cursor / some terminals use an arrow (→ ▸ ▶) or a plain ">".
const OPTION_RE = /^\s*[❯>→➜▸►▶]?\s*\d+\.\s/;
const HINT_RE = /Esc to cancel|Enter to confirm/i;
// After edge trimming, a leftover │ or a progress bar means we're looking at the
// user's Claude statusline ("model │ dir │ ███░ 65%"), not at a question.
const STATUSLINE_RE = /[│┃█░]/;
const HAS_TEXT_RE = /[\p{L}\p{N}]/u;
const MAX = 80;

// Strip the box drawing that frames a prompt, then normalise spacing. Edges
// only: an inner │ is the statusline tell, so it must survive this.
function clean(line) {
  return String(line)
    .replace(/^[\s│┃┌└├╭╰]+/, '')
    .replace(/[\s│┃┐┘┤╮╯]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The one-line gist of what an agent is asking, for the pult chip. Scans bottom
// -up because the live prompt sits at the bottom of the screen. Best effort by
// design: null just means the chip shows the tab name (see the spec).
function extractQuestion(snapshot) {
  const lines = String(snapshot == null ? '' : snapshot).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = clean(lines[i]);
    if (!t) continue;
    if (!HAS_TEXT_RE.test(t)) continue;   // frames, rules, the empty "> " box
    if (STATUSLINE_RE.test(t)) continue;  // the user's statusline
    if (OPTION_RE.test(t)) continue;      // "❯ 1. Yes"
    if (HINT_RE.test(t)) continue;        // "Esc to cancel"
    return t.length > MAX ? t.slice(0, MAX - 1).trimEnd() + '…' : t;
  }
  return null;
}

// Permission prompts carry phrasing that AskUserQuestion / prose questions never
// do: Claude asks to run a tool or edit ("Do you want to proceed?") and always
// offers the "No, and tell Claude what to do differently" escape. That's the tell.
const PERMISSION_RE = /No, and tell Claude|Do you want\b/i;
// A selection cursor immediately before a numbered option ("❯ 1. …"). Mirrors the
// detector's RE_WAIT_NOW option pattern; used here to spot an AskUserQuestion list.
// Not anchored — we scan the whole snapshot, not one line.
const OPTIONS_RE = /[❯>→➜▸►▶]\s*\d+\.\s/;
// «Сейчас от тебя: …» closes a turn saying what the user must do — but ONLY when it
// actually asks for something. "Сейчас от тебя: ничего, жди результата" is the
// opposite: the agent says nothing is needed. So the marker alone isn't enough —
// if the first word after it is a nothing/wait word, it's NOT a request.
const RE_ASK_MARK = /Сейчас от тебя/i;
const RE_ASK_NONE = /Сейчас от тебя\s*[:.—-]*\s*(?:ничего|жд[иёе]|ждать|ждите|подожди(?:те)?|дождись|дождитесь|не\s+(?:нужно|требуется|надо))/i;

// True only for a REAL «Сейчас от тебя» request (marker present, not a «ничего/жди»).
function asksForInput(snapshot) {
  const t = String(snapshot == null ? '' : snapshot);
  return RE_ASK_MARK.test(t) && !RE_ASK_NONE.test(t);
}

// WHY a waiting agent is calling — for the pult chip, tab sub-label and notify.
// Only sensible once status is already «waiting». Returns:
//   'permission' — a tool/edit approval prompt (act fast: yes/no)
//   'question'   — AskUserQuestion options, a prose "Сейчас от тебя", or any
//                  extractable question line
//   null         — nothing confident to say; caller keeps the generic «ждёт ответа»
// Order matters: permission phrasing must be checked before options, or a
// permission prompt (which also has "❯ 1. Yes") would misread as a question.
function inferWaitingKind(snapshot) {
  const text = String(snapshot == null ? '' : snapshot);
  if (PERMISSION_RE.test(text)) return 'permission';
  if (OPTIONS_RE.test(text)) return 'question';
  if (asksForInput(text)) return 'question';
  if (extractQuestion(text)) return 'question';
  return null;
}

// Sub-agents (Claude Code's Task/agent tool). Claude runs them in the background
// by default and pins a status line just above the input box:
//   "✻ Waiting for N background agents to finish"
// It stays whether the main turn is busy OR the prompt is idle — and the idle case
// is exactly when the byte-flow/spinner heuristic wrongly reads «готов» (green),
// which is the bug this detects. When the roster panel is expanded (↓ to manage)
// each RUNNING agent is a hollow-circle row, while «⏺ main» / finished agents use a
// filled glyph:
//   "◯ Explore  <desc>   2m 2s · ↓ 28.4k tokens"
const RE_AGENTS_WAIT = /Waiting for (\d+) background agents?\b/i;
const RE_AGENT_ROW = /^\s*[◯○]\s/;   // a running sub-agent row (hollow circle)

// How many sub-agents are running per the current screen (0 = none). Prefers the
// explicit "Waiting for N …" count — it's present even when the roster is collapsed
// and it never counts the main thread. Falls back to counting expanded hollow-circle
// roster rows (filled ⏺/● rows — main + finished agents — are deliberately excluded).
function countSubagents(snapshot) {
  const text = String(snapshot == null ? '' : snapshot);
  const m = text.match(RE_AGENTS_WAIT);
  if (m) return parseInt(m[1], 10) || 0;
  let rows = 0;
  for (const line of text.split('\n')) if (RE_AGENT_ROW.test(line)) rows++;
  return rows;
}

module.exports = {
  extractQuestion, inferWaitingKind, asksForInput, countSubagents,
  contentEnd, snapshotRows,
};
