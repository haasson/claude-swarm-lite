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
// Format: <model> │ <dir> ███░░░░░░░ 45% 1M │ 5ч 37% · 7д 62% │ 🔧 #162 task
//                                             ^^^^^^^^^^^^^^^ subscription spent,
//                                             same direction as the site's account page.
//                                    ^^^^^ this % is what the app parses — it takes
// the FIRST one in the line, so nothing carrying a % may go before the context bar.

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

// --- the subscription budget: 5-hour window and week -------------------------
// Claude Code hands us these on stdin (rate_limits.*), so showing them costs no API
// call and no bookkeeping of our own. They are NOT always there: subscription
// accounts only, and only from the first API response of the session on. Missing ⇒
// we print nothing, because a bare "0%" is indistinguishable from a real reading.
//
// We show SPENT, the same direction as the account page on the site — so the two
// never have to be mentally inverted against each other — and round UP, because a
// spend figure must not report less than has actually gone.
//
// The reset countdown appears only once the window is nearly spent: that's when
// «how long until it refills» becomes the actionable number, and before that it
// would just eat width. Nearly-spent is marked by a GLYPH (⚠), never by colour
// alone — the app reads this line with ANSI stripped.
const LIMIT_TIGHT = 75;  // % spent at which the reset countdown starts showing
const LIMIT_CRIT = 90;   // % spent at which the line says «about to run out»

function usedPct(limit) {
  const used = limit && typeof limit.used_percentage === 'number' ? limit.used_percentage : null;
  if (used == null || !isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.ceil(used)));
}

// "2ч14м" / "18м" / "3д4ч" — coarse on purpose: it's a countdown to a reset hours or
// days out, so seconds would be noise and minute-level precision matters only at the end.
function fmtEta(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}д${h}ч` : `${d}д`;
  if (h > 0) return m > 0 ? `${h}ч${m}м` : `${h}ч`;
  return `${m}м`;
}

function renderLimit(label, limit, nowSec) {
  const spent = usedPct(limit);
  if (spent == null) return null;
  const resetsAt = limit && typeof limit.resets_at === 'number' ? limit.resets_at : null;
  const eta = spent >= LIMIT_TIGHT && resetsAt != null && resetsAt > nowSec
    ? ` ↻${fmtEta(resetsAt - nowSec)}` : '';
  const text = `${label} ${spent}%${eta}`;
  if (spent >= LIMIT_CRIT) return `\x1b[31m⚠ ${text}\x1b[0m`;
  if (spent >= LIMIT_TIGHT) return `\x1b[33m${text}\x1b[0m`;
  return `\x1b[2m${text}\x1b[0m`;
}

function renderLimits(rateLimits, nowSec) {
  if (!rateLimits || typeof rateLimits !== 'object') return '';
  const parts = [
    renderLimit('5ч', rateLimits.five_hour, nowSec),
    renderLimit('7д', rateLimits.seven_day, nowSec),
  ].filter(Boolean);
  if (!parts.length) return '';

  return ` \x1b[2m│\x1b[0m ${parts.join(' \x1b[2m·\x1b[0m ')}`;
}

// The whole line, from the JSON Claude Code sends on stdin. Pure so it's testable.
function renderLine(data, nowSec) {
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

  // Limits only alongside the context bar, and always after it: the app takes the
  // FIRST % in the line as the context fill, so a limit % reaching it first would
  // paint the wrong number on the tab. Both come from the same first API response,
  // so in practice they appear together anyway — this just makes that load-bearing.
  const limits = ctx ? renderLimits(data.rate_limits, nowSec) : '';

  return `\x1b[2m${model}\x1b[0m │ \x1b[2m${dir}\x1b[0m${ctx}${limits}${pin}`;
}

function main() {
  let input = '';
  const timeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    try {
      process.stdout.write(renderLine(JSON.parse(input), Math.floor(Date.now() / 1000)));
    } catch (_) {
      // Bad/empty stdin must never make Claude show an error line — print nothing.
    }
  });
}

// Only read stdin when actually run as the statusline; the tests require this file.
if (require.main === module) main();

module.exports = { renderLine, renderLimits, usedPct, fmtEta };
