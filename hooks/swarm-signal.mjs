#!/usr/bin/env node
'use strict';
// Claude Code hook for Claude Swarm Lite. Normalises the current event to a status
// token and emits it as an INVISIBLE OSC 777 marker in the session terminal; the
// app parses it out of the pty (see osc.js) for a deterministic status, no screen
// scraping. Opt-in — installed only when the user enables «Точный статус через
// хуки». Self-contained on purpose (no app imports): it's run as a standalone
// script by Claude Code, possibly from an unpacked resources dir.
//
// Contract: read the event JSON on stdin, print {"terminalSequence": "<OSC>"} on
// stdout and exit 0. It prints nothing else and never blocks or returns a decision,
// so it can't interfere with Claude's own prompt / permission flow.

// event JSON → one of: busy | idle | perm | ask (see detector.js HOOK_TOKEN). null
// => emit nothing (event we don't care about).
function tokenFor(p) {
  switch (p && p.hook_event_name) {
    case 'UserPromptSubmit': return 'busy';           // you sent a prompt → working
    case 'Stop':             return 'idle';           // the turn ended → ready
    case 'PermissionRequest': return 'perm';          // approval prompt → разрешение
    case 'Notification':
      if (p.notification_type === 'permission_prompt') return 'perm';
      if (p.notification_type === 'idle_prompt') return 'idle';
      return null;
    case 'PreToolUse':
      // The AskUserQuestion tool is a real question; any other tool starting just
      // reasserts «working».
      return p.tool_name === 'AskUserQuestion' ? 'ask' : 'busy';
    default: return null;
  }
}

// Build the marker osc.js expects: a valid OSC 777 «notify» carrying our payload —
// ESC ] 777 ; notify ; swarm ; <token> ; <sessionId> BEL.
// sessionId is a cross-check only (routing is by pty). JSON.stringify encodes the
// control bytes ( / ) for us.
function markerFor(payload) {
  const token = tokenFor(payload);
  if (!token) return null;
  const sid = String((payload && payload.session_id) || '').replace(/[\x07\x1b;]/g, '');
  return `\x1b]777;notify;swarm;${token};${sid}\x07`;
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try {
      const seq = markerFor(JSON.parse(input || '{}'));
      if (seq) process.stdout.write(JSON.stringify({ terminalSequence: seq }));
    } catch (_) { /* malformed payload → emit nothing */ }
    process.exit(0);
  });
}

// Run only when invoked directly (so tests can import the pure helpers).
if (import.meta.url === `file://${process.argv[1]}`) main();

export { tokenFor, markerFor };
