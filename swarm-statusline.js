#!/usr/bin/env node
// swarm-statusline.js — the statusline Claude Swarm injects into every Claude
// session it launches (via `--settings`, see main.js). It exists so the context
// progress bar on each tab works OUT OF THE BOX: the app can't measure context
// itself, it scrapes a "NN%" out of the statusline text — and stock Claude prints
// no such line. This one does.
//
// Runs under Electron-as-node (ELECTRON_RUN_AS_NODE=1) so it needs no separately
// installed Node. Output is plain text with ANSI colour; the app reads it with the
// colour stripped, so state is marked by GLYPHS, never by colour alone.
//
// Format: <model> │ <dir> ███░░░░░░░ 45% 1M │ 🔧 #162 task
//                                    ^^^^^ this % is what the app parses.

const fs = require('fs');
const path = require('path');
const os = require('os');

// A task a skill pinned to this tab (writes .claude/.task-<session>). Optional:
// absent for anyone without those skills, in which case we simply render nothing.
// The mode is marked by a glyph, not colour — the app reads the line without ANSI.
const PIN_GLYPH = { groom: '🔎', task: '🔧' };

function readPin(cwd, session) {
  if (!session || /[/\\]|\.\./.test(session)) return null;
  let cur = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    try {
      const p = path.join(cur, '.claude', `.task-${session}`);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) { return null; }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }

  return null;
}

function renderPin(pin) {
  if (!pin || !pin.number) return '';
  const glyph = PIN_GLYPH[pin.mode] || PIN_GLYPH.task;
  const raw = String(pin.title || '').trim();
  const title = raw.length > 36 ? raw.slice(0, 35).trimEnd() + '…' : raw;
  const phase = String(pin.phase || '').trim();

  return ` \x1b[2m│\x1b[0m ${glyph} \x1b[1m#${pin.number}\x1b[0m${title ? ` \x1b[2m${title}\x1b[0m` : ''}` +
    (phase ? ` \x1b[2m·\x1b[0m \x1b[36m${phase}\x1b[0m` : '');
}

let input = '';
const timeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input);
    const model = data.model?.display_name || 'Claude';
    const cwd = data.workspace?.current_dir || process.cwd();
    const dir = path.basename(cwd);
    const session = data.session_id || '';
    const pin = renderPin(readPin(cwd, session));
    const remaining = data.context_window?.remaining_percentage;

    let ctx = '';
    if (remaining != null) {
      // Claude auto-compacts before the window is truly full, so "used" is scaled
      // against the usable region (window minus the auto-compact buffer) — matches
      // the number Claude itself shows, not raw tokens / total.
      const totalCtx = data.context_window?.total_tokens || 1_000_000;
      const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
      const bufferPct = acw > 0 ? Math.min(100, (acw / totalCtx) * 100) : 16.5;
      const usableRemaining = Math.max(0, ((remaining - bufferPct) / (100 - bufferPct)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : Math.round(n / 1000) + 'K');
      const win = fmtTok(totalCtx);
      const filled = Math.floor(used / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      if (used < 50) ctx = ` \x1b[32m${bar} ${used}%\x1b[0m \x1b[2m${win}\x1b[0m`;
      else if (used < 65) ctx = ` \x1b[33m${bar} ${used}%\x1b[0m \x1b[2m${win}\x1b[0m`;
      else if (used < 80) ctx = ` \x1b[38;5;208m${bar} ${used}%\x1b[0m \x1b[2m${win}\x1b[0m`;
      else ctx = ` \x1b[5;31m💀 ${bar} ${used}%\x1b[0m \x1b[2m${win}\x1b[0m`;
    }

    process.stdout.write(`\x1b[2m${model}\x1b[0m │ \x1b[2m${dir}\x1b[0m${ctx}${pin}`);
  } catch (_) {
    // Bad/empty stdin must never make Claude show an error line — print nothing.
  }
});
