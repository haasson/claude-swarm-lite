'use strict';
// The phrases an agent uses to CALL the user — «Сейчас от тебя: …» and whatever else
// the user teaches their agents to sign off with. This is the ONE thing neither the
// hooks nor the screen can tell us on their own: Claude ending its turn looks
// identical whether the work is done or a question was asked in prose. So the phrase
// is the marker, and since it's a convention from the user's own CLAUDE.md (not a
// Claude Code feature), it has to be configurable — hence this module.
//
// Three consumers, one source of truth:
//   • screen.js — scraping the terminal (sessions without hooks);
//   • hooks/swarm-signal.mjs — reading Stop's `last_assistant_message`;
//   • the settings UI — the live «позовёт / не позовёт» check, which MUST agree with
//     the real thing, so it runs this same matcher (window.SWARM_ASK_PHRASES).
// The hook is a standalone ESM script with no app imports, so it can't require this.
// Instead the app COMPILES the matcher here and writes the two regex sources into
// swarm-phrases.json (see main.js); the hook only applies them. That way the phrase
// logic lives in one tested place and the hook stays dumb.
//
// Dual-mode like renderer/tabstyle.js: module.exports under Node (main, screen.js,
// tests), window.SWARM_ASK_PHRASES in the renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_ASK_PHRASES = api;
})(typeof self !== 'undefined' ? self : this, function () {

// What ships out of the box. Matches the sign-off the task skills use.
const DEFAULT_ASK_PHRASES = ['Сейчас от тебя'];

// A phrase alone isn't a request: «Сейчас от тебя: ничего, жди результата» is the
// OPPOSITE — the agent says it needs nothing. So every phrase gets this tail check,
// and a hit here cancels the call. Not user-editable: it's about Russian wording,
// not about the marker, and getting it wrong would silently kill the signal.
const NONE_TAIL = '\\s*[:.\\u2014-]*\\s*(?:ничего|жд[иёе]|ждать|ждите|подожди(?:те)?|дождись|дождитесь|не\\s+(?:нужно|требуется|надо))';

const MAX_PHRASES = 12;   // a sane ceiling; the regex is run on every tick
const MAX_LEN = 60;       // one phrase, not a paragraph

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Clean whatever came from the settings box: trim, drop empties, cap length and
// count, de-dupe case-insensitively. Empty input => the defaults (never no marker).
function normalizePhrases(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_PHRASES) break;
  }
  return out.length ? out : DEFAULT_ASK_PHRASES.slice();
}

// The two regex SOURCES (strings, so they survive JSON on the way to the hook):
//   mark — any of the phrases;  none — a phrase followed by a «ничего/жди» tail.
function phraseSources(list) {
  const alt = normalizePhrases(list).map(escapeRe).join('|');
  return { mark: `(?:${alt})`, none: `(?:${alt})${NONE_TAIL}` };
}

// Compiled form for in-process use.
function buildAskMatcher(list) {
  const src = phraseSources(list);
  return { mark: new RegExp(src.mark, 'i'), none: new RegExp(src.none, 'i') };
}

// True only for a REAL call: a phrase is present and it isn't a «ничего/жди» one.
function asksWith(matcher, text) {
  const t = String(text == null ? '' : text);
  return matcher.mark.test(t) && !matcher.none.test(t);
}

// WHAT the agent is asking, as text — for the pult tooltip, the notification and
// (later) the Telegram bridge. The whole closing message is usually a report ending
// with the request, so the useful part starts AT the phrase: «Сейчас от тебя: путь к
// схеме». Falls back to the tail of the message when no phrase matched, because a
// waiting agent still has to show something. Collapses blank lines and caps the
// length — a chip tooltip is not a place for a page of text.
function askExcerpt(matcher, text, max) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  const cap = max || 500;
  const hit = matcher && matcher.mark ? t.match(matcher.mark) : null;
  const from = hit && hit.index != null ? t.slice(hit.index) : t.slice(-cap * 2);
  const flat = from.replace(/\s*\n\s*\n\s*/g, ' — ').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return flat.length > cap ? flat.slice(0, cap - 1).trimEnd() + '…' : flat;
}

// The default sources, so the hook's own fallback can be pinned against them.
const DEFAULT_SOURCES = phraseSources(DEFAULT_ASK_PHRASES);

return {
  DEFAULT_ASK_PHRASES, DEFAULT_SOURCES, MAX_PHRASES, MAX_LEN,
  normalizePhrases, phraseSources, buildAskMatcher, asksWith, askExcerpt,
};

});
