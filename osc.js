'use strict';
// Parse the invisible status markers our Claude hooks print into the pty. A hook
// returns { terminalSequence } and Claude Code emits it as an OSC 777 sequence;
// xterm (real and headless) consumes it — the user never sees it — and we sniff it
// out of the raw pty chunk here. Kept pure so it's unit-testable in plain node.
//
// Marker format (see hooks/swarm-signal.mjs, added in the hooks task):
//   ESC ] 777 ; swarm ; <token> ; <sessionId> BEL
// token ∈ busy | idle | perm | ask — the hook normalises Claude's events to these;
// their meaning (→ status/kind) lives in detector.js. sessionId is optional and
// only a cross-check: routing is by pty, since each agent has its own.
//
// Terminated by BEL (\x07) or ST (ESC \). Not anchored — a chunk may hold several.
const MARKER_RE = /\x1b\]777;swarm;([a-z]+)(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;
const CARRY_CAP = 128; // enough to reassemble a marker split across two chunks

// Extract every complete marker from `buf` (a chunk, optionally prefixed with the
// leftover tail from last time). Returns the signals plus the `rest` to carry: the
// text after the last complete marker, capped so non-marker output can't grow
// unbounded while still letting a marker cut at a chunk boundary finish assembling.
function extractHookSignals(buf) {
  const text = String(buf == null ? '' : buf);
  const signals = [];
  let lastEnd = 0;
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text)) !== null) {
    signals.push({ token: m[1], sessionId: m[2] || null });
    lastEnd = MARKER_RE.lastIndex;
  }
  let rest = text.slice(lastEnd);
  if (rest.length > CARRY_CAP) rest = rest.slice(-CARRY_CAP);
  return { signals, rest };
}

module.exports = { extractHookSignals };
