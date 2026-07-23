'use strict';
// The status state machine, kept out of main.js so it's unit-testable in plain
// node (like screen.js / git.js / updater-core.js). main.js owns the headless
// terminal, the tick and IPC; this module owns the "what status is this?" decision
// and the «ждёт» latch. Everything here is pure w.r.t. its arguments — `decide`
// reads `d.lastDataAt`, `applyLatch` reads/mutates the latch fields on `d`, and
// both take the current screen `snap` as a string.

const { inferWaitingKind } = require('./screen');

const ACTIVE_MS = 1200;      // bytes seen this recently => the agent is working
// Once «ждёт» is latched we stop believing transient running/ready reads (repaint
// bursts, half-drawn prompts). We only release when the agent VISIBLY resumed —
// its spinner is back — or the wait chrome has been gone this long with no work
// (a just-answered trivial prompt). Debounce > a repaint blip so it can't flicker.
const LATCH_RELEASE_MS = 900;

// Waiting on me: a permission / confirm prompt sits on screen.
// Selection cursor before "1. Yes / 2. No": Claude Code often paints ❯ (heavy
// angle), but Cursor / some terminals use an arrow (→ ▸ ▶) or plain ">".
// Without those glyphs the tab never flips to «ждёт ответа».
const RE_WAIT = /Esc to cancel|Do you want|Enter to confirm|[❯>→➜▸►▶]\s*\d+\.\s|No, and tell Claude/i;
// Strong subset — prompt UI chrome that never appears in normal streamed output
// (numbered options, "Esc to cancel"). We trust these EVERY tick, even while bytes
// are still flowing, so a prompt is caught the instant it renders. The full RE_WAIT
// (with the looser "Do you want") stays gated behind the quiet window to avoid
// matching that phrase mid-sentence in streamed prose.
const RE_WAIT_NOW = /Esc to cancel|Enter to confirm|[❯>→➜▸►▶]\s*\d+\.\s|No, and tell Claude/i;

// Working but momentarily quiet. While Claude thinks or runs a tool it can go
// >ACTIVE_MS without emitting a byte (model call with no repaint, a slow tool),
// yet it is NOT done — its spinner line stays on screen with a LIVE elapsed
// timer: "✶ Cooking… (12s · thinking)" / "…(3s · esc to interrupt)". Idle looks
// different: a past-tense summary "Worked for 12s" (no parens) or the bare input
// box — neither carries a running "(Ns" timer. The spinner GLYPH animates through
// many chars (✶ ✽ ✻ …), so we key off the ellipsis-then-timer text, not the glyph.
// Without this, decide() falls through to "ready" on every silent work pause and
// flashes «готов» — worse, the renderer paints ready instantly but buffers the
// return to running by ~2.5s, so each false idle lingers.
const RE_RUNNING = /(?:…|\.\.\.)\s*\(\d+\s*[smh]\b|\besc to interrupt\b/i;

// Waiting on me WITHOUT prompt chrome: the agent asked in prose and stopped. The
// task skills close every such message with the line «Сейчас от тебя: …» (see
// fastio CLAUDE.md), so that phrase — not a glyph — is the marker. Without this
// the tab paints «готов», identical to a tab that simply finished, and a question
// can sit unseen in a background tab.
// Checked LAST, only on the path that would otherwise return «готов»: a stale
// marker still on screen must never outvote real activity or the spinner.
const RE_WAIT_ASK = /Сейчас от тебя/i;

function mkWaiting(snap) {
  return { status: 'waiting', detail: 'ждёт ответа', kind: inferWaitingKind(snap) };
}

// The raw per-tick read from the screen (no latch). `snap` is the bottom rows of
// the emulator; `d.lastDataAt` is when bytes last flowed.
function decide(d, now, snap) {
  // A confirm/permission prompt on screen means "waiting on me" regardless of byte
  // activity — check it EVERY tick, not only when the stream goes quiet. Otherwise a
  // background tab keeps showing "работает" while the prompt renders in bursts, and
  // only flips to "ждёт ответа" once the stream finally falls silent for ACTIVE_MS
  // (a long, ragged lag). Uses the strong prompt-chrome markers, safe mid-stream.
  if (RE_WAIT_NOW.test(snap)) {
    return mkWaiting(snap);
  }
  // Active output => working. Only peek for the looser prompt once it goes quiet.
  if (now - d.lastDataAt < ACTIVE_MS) {
    return { status: 'running', detail: 'работает' };
  }
  if (RE_WAIT.test(snap)) {
    return mkWaiting(snap);
  }
  // Quiet, but the spinner (with its live timer) is still on screen => the agent
  // is thinking / running a tool, not idle. Keep it "работает" instead of the
  // false "готов" flash. See RE_RUNNING above for why we match the timer text.
  if (RE_RUNNING.test(snap)) {
    return { status: 'running', detail: 'работает' };
  }
  // Quiet, no spinner, no prompt box — but the agent signed off with a question.
  if (RE_WAIT_ASK.test(snap)) {
    return mkWaiting(snap);
  }

  return { status: 'ready', detail: 'готов' };
}

// Any on-screen evidence that we're still waiting on the user. When NONE of these
// match, the prompt/question is gone from the visible screen.
function hasWaitChrome(snap) {
  return RE_WAIT.test(snap) || RE_WAIT_NOW.test(snap) || RE_WAIT_ASK.test(snap);
}

// The latch: `raw` is decide()'s per-tick read; this holds «ждёт» through screen
// noise and releases only when the agent visibly resumed. NOT released by the user
// typing — a keystroke into an answer field isn't «resumed work». Returns the
// effective { status, detail, kind } and mutates the latch fields on `d`
// (waitLatched, waitKind, chromeGoneSince).
function applyLatch(d, now, snap, raw) {
  if (d.waitLatched) {
    if (hasWaitChrome(snap)) {
      // Still waiting on screen. Kind can only sharpen (question → permission),
      // never soften, so the label doesn't flip-flop.
      d.chromeGoneSince = 0;
      if (raw.status === 'waiting' && raw.kind === 'permission') d.waitKind = 'permission';
      return { status: 'waiting', detail: 'ждёт ответа', kind: d.waitKind };
    }
    if (RE_RUNNING.test(snap)) {
      // Spinner is back — the agent genuinely resumed. Release now.
      d.waitLatched = false; d.waitKind = null; d.chromeGoneSince = 0;
      return raw;
    }
    // Chrome gone but no spinner: a repaint blip, or a trivial prompt just answered
    // and the turn ended. Debounce — release only after it's been gone a while, so a
    // one-tick repaint can't flicker us out of «ждёт».
    if (!d.chromeGoneSince) d.chromeGoneSince = now;
    if (now - d.chromeGoneSince >= LATCH_RELEASE_MS) {
      d.waitLatched = false; d.waitKind = null; d.chromeGoneSince = 0;
      return raw;
    }
    return { status: 'waiting', detail: 'ждёт ответа', kind: d.waitKind };
  }
  if (raw.status === 'waiting') {
    d.waitLatched = true; d.waitKind = raw.kind; d.chromeGoneSince = 0;
  }
  return raw;
}

// --- hooks: the deterministic channel --------------------------------------
// A Claude hook prints a marker (parsed in osc.js) whose token we map to a status
// here — so the meaning lives in tested code, not in the installed hook script.
const HOOK_TOKEN = {
  busy: { status: 'running' },              // UserPromptSubmit / a normal tool starts
  idle: { status: 'ready' },                // Stop — the turn ended
  perm: { status: 'waiting', kind: 'permission' }, // PermissionRequest
  ask:  { status: 'waiting', kind: 'question' },    // AskUserQuestion tool
};

// Record a hook signal on `d`. Once ANY signal has arrived, hooksActive flips on
// and this session trusts hooks over the screen (see tickStatus). Returns whether
// the token was known.
function applyHook(d, token, now) {
  const m = HOOK_TOKEN[token];
  if (!m) return false;
  d.hooksActive = true;
  d.hookState = { status: m.status, kind: m.kind || null, at: now };
  return true;
}

function detailFor(status) {
  return status === 'running' ? 'работает' : status === 'waiting' ? 'ждёт ответа' : 'готов';
}

// Hooks are authoritative. The screen may ONLY add the one thing hooks can't see:
// a prose question after the agent ended its turn (Stop → ready, yet «Сейчас от
// тебя» sits on screen). It never overrides running / ready / permission.
function arbitrate(d, snap) {
  const hs = d.hookState || { status: 'ready', kind: null };
  if (hs.status === 'ready' && RE_WAIT_ASK.test(snap)) {
    return { status: 'waiting', detail: 'ждёт ответа', kind: 'question' };
  }
  return { status: hs.status, detail: detailFor(hs.status), kind: hs.status === 'waiting' ? hs.kind : null };
}

// The single entry point main's tick calls. Hooks-authoritative once the session
// has spoken through them; otherwise the screen-scrape + «ждёт» latch fallback.
function tickStatus(d, now, snap) {
  if (d.hooksActive) return arbitrate(d, snap);
  return applyLatch(d, now, snap, decide(d, now, snap));
}

module.exports = {
  ACTIVE_MS, LATCH_RELEASE_MS,
  RE_WAIT, RE_WAIT_NOW, RE_RUNNING, RE_WAIT_ASK,
  decide, hasWaitChrome, applyLatch,
  applyHook, arbitrate, tickStatus,
};
