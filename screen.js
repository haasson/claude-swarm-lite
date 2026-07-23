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

module.exports = { extractQuestion };
