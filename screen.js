'use strict';
// Pure screen-scraping helpers for the status detector. Kept out of main.js so
// they're unit-testable in plain node, like git.js / updater-core.js.

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
const RE_ASK = /Сейчас от тебя/i;

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
  if (RE_ASK.test(text)) return 'question';
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

module.exports = { extractQuestion, inferWaitingKind, countSubagents };
