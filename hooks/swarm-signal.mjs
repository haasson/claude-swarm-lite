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

// --- the «agent is calling you» phrases --------------------------------------
// Compiled by the app (ask-phrases.js) and written next to this script as
// swarm-phrases.json, because the user can edit the phrase list in Settings. We only
// APPLY the two regexes — no phrase logic here, so there's nothing to drift. If the
// file is missing or broken we fall back to the shipped default (pinned by a test
// against ask-phrases.js DEFAULT_SOURCES).
const FALLBACK = {
  mark: '(?:Сейчас от тебя)',
  none: '(?:Сейчас от тебя)\\s*[:.\\u2014-]*\\s*(?:ничего|жд[иёе]|ждать|ждите|подожди(?:те)?|дождись|дождитесь|не\\s+(?:нужно|требуется|надо))',
};

function loadMatcher(readJson) {
  let src = null;
  try { src = readJson(); } catch (_) { /* missing / unreadable → defaults */ }
  const mark = (src && typeof src.mark === 'string' && src.mark) || FALLBACK.mark;
  const none = (src && typeof src.none === 'string' && src.none) || FALLBACK.none;
  try {
    return { mark: new RegExp(mark, 'i'), none: new RegExp(none, 'i') };
  } catch (_) {
    return { mark: new RegExp(FALLBACK.mark, 'i'), none: new RegExp(FALLBACK.none, 'i') };
  }
}

// Stop's `last_assistant_message` is not reliably a plain string: depending on the Claude
// Code version it's the text, an object `{ type, text }`, or the message's content blocks.
// String()ing an object yields "[object Object]", which silently never matches a phrase —
// so unwrap all three shapes instead of trusting one.
function messageText(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(messageText).filter(Boolean).join('\n');
  if (typeof m === 'object') {
    if (typeof m.text === 'string') return m.text;
    if (m.content != null) return messageText(m.content);
    if (m.message != null) return messageText(m.message);
  }
  return '';
}

// Did the agent's closing message actually ask for something?
function callsUser(matcher, text) {
  const t = messageText(text);
  return matcher.mark.test(t) && !matcher.none.test(t);
}

// event JSON → one of: busy | idle | perm | ask (see detector.js HOOK_TOKEN). null
// => emit nothing (event we don't care about).
function tokenFor(p, matcher) {
  switch (p && p.hook_event_name) {
    case 'UserPromptSubmit': return 'busy';           // you sent a prompt → working
    case 'Stop':
      // The turn ended — but «done» and «I asked you something and stopped» are the
      // SAME event. The payload carries the closing text, so decide from it: a call
      // phrase makes this «ждёт», not «готов». This is the signal that used to be
      // scraped off the screen, where a stale line kept the tab yellow for seconds.
      return matcher && callsUser(matcher, p.last_assistant_message) ? 'ask' : 'idle';
    case 'PermissionRequest': return 'perm';          // approval prompt → разрешение
    case 'Notification':
      if (p.notification_type === 'permission_prompt') return 'perm';
      if (p.notification_type === 'idle_prompt') return 'idle';
      if (p.notification_type === 'agent_needs_input') return 'ask';
      return null;
    case 'PreToolUse':
      // The AskUserQuestion tool is a real question; any other tool starting just
      // reasserts «working».
      return p.tool_name === 'AskUserQuestion' ? 'ask' : 'busy';
    // A tool finished => work is flowing again. Without this the app stays «ждёт»
    // after you approve a permission, until the NEXT tool starts or the turn ends.
    case 'PostToolUse': return 'busy';
    default: return null;
  }
}

// Build the marker osc.js expects: a valid OSC 777 «notify» carrying our payload —
// ESC ] 777 ; notify ; swarm ; <token> ; <sessionId> BEL.
// sessionId is a cross-check only (routing is by pty). JSON.stringify encodes the
// control bytes ( / ) for us.
function markerFor(payload, matcher) {
  const token = tokenFor(payload, matcher);
  if (!token) return null;
  const sid = String((payload && payload.session_id) || '').replace(/[\x07\x1b;]/g, '');
  return `\x1b]777;notify;swarm;${token};${sid}\x07`;
}

// --- refusing the picker while the user is on a phone -------------------------
// AskUserQuestion paints an interactive «choose 1/2/3» box in the terminal. Over Telegram
// that's a dead end: there's no way to press a key in a box that only exists on a screen
// nobody is looking at. So while a session is being driven from the phone (the app lists
// those in swarm-tgmode.json beside this script) we DENY the tool. Claude gets the reason
// and asks in prose instead — which the bridge can deliver and answer.
const DENY_REASON = 'Пользователь отвечает из Telegram: интерактивный выбор ему недоступен.'
  + ' Задай тот же вопрос обычным текстом (варианты — списком в тексте) и заверши ход.';

function deniesPicker(payload, tgSessions) {
  if (!payload || payload.hook_event_name !== 'PreToolUse') return false;
  if (payload.tool_name !== 'AskUserQuestion') return false;
  const sid = String((payload && payload.session_id) || '');
  return !!sid && Array.isArray(tgSessions) && tgSessions.includes(sid);
}

// The whole stdout payload for one event. terminalSequence sits at the top level (where
// this hook has always put it) AND inside hookSpecificOutput, because which one a given
// Claude Code version reads is not worth betting a status on — the token is idempotent,
// so being read twice costs nothing, while being read zero times costs a wrong status.
function outputFor(payload, matcher, tgSessions) {
  const seq = markerFor(payload, matcher);
  const deny = deniesPicker(payload, tgSessions);
  if (!seq && !deny) return null;
  const out = {};
  if (seq) out.terminalSequence = seq;
  if (deny) {
    out.hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    };
    if (seq) out.hookSpecificOutput.terminalSequence = seq;
  }
  return out;
}

// The files the app writes beside this script (all three live in userData).
async function readJsonBeside(name) {
  const { readFileSync } = await import('node:fs');
  return JSON.parse(readFileSync(new URL('./' + name, import.meta.url), 'utf8'));
}

async function main() {
  let phrases = null;
  try { phrases = await readJsonBeside('swarm-phrases.json'); } catch (_) { /* → FALLBACK */ }
  let tgSessions = [];
  try { tgSessions = (await readJsonBeside('swarm-tgmode.json')).sessions || []; } catch (_) { /* none */ }
  const matcher = loadMatcher(() => phrases);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try {
      const out = outputFor(JSON.parse(input || '{}'), matcher, tgSessions);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (_) { /* malformed payload → emit nothing */ }
    process.exit(0);
  });
}

// Run only when invoked directly (so tests can import the pure helpers).
if (import.meta.url === `file://${process.argv[1]}`) main();

export { tokenFor, markerFor, loadMatcher, callsUser, messageText, deniesPicker, outputFor, DENY_REASON, FALLBACK };
