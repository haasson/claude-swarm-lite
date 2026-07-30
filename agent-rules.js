'use strict';
// What we ASK THE AGENT to do so the tab can tell «работает» from «ждёт ответа».
//
// The status channels we own are deterministic because the HARNESS emits them: the
// hooks print an invisible OSC marker (see hooks/swarm-signal.mjs, osc.js), the
// screen detector reads the pty. The one thing no harness can know is intent — a
// turn that ended with a question looks exactly like a turn that ended done. That
// part has to come from the agent, so it needs a convention, and a convention only
// works if somebody teaches it. This module is that text, in two shapes:
//
//   systemPromptRule() — one line for `claude --append-system-prompt`, injected by
//     main at launch (see injectAgentRules). Costs the user nothing to set up and
//     touches no file of theirs, but lives only inside swarm-launched tabs.
//   claudeMdRule()     — a markdown block for the user's own CLAUDE.md, offered as
//     a copy button in Settings. For people who also run the agent outside swarm.
//
// Both say the same two things, and both are generated from the phrase list the user
// edits in Settings (ask-phrases.js) — so the rule we teach and the marker we match
// can never drift apart. That's the whole point of generating instead of shipping a
// static paragraph: an example phrase hardcoded here would silently stop matching the
// moment somebody edits the box.
//
// The FIRST rule (ask via AskUserQuestion) is the better one: a tool call gives the
// PreToolUse hook an exact signal plus the question text, with no text matching at
// all. The phrase is the fallback for questions that stay in prose.
//
// Dual-mode like ask-phrases.js: module.exports under Node (main, tests),
// window.SWARM_AGENT_RULES in the renderer (the copy button).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_AGENT_RULES = api;
})(typeof self !== 'undefined' ? self : this, function () {

// Kept in sync with ask-phrases.js DEFAULT_ASK_PHRASES[0] by a test. Duplicated
// rather than required, because this module is also loaded as a plain script in the
// renderer, where there is no require().
const DEFAULT_MARKER = 'Сейчас от тебя';

// The CLAUDE.md block is fenced with markers so it can be found and replaced whole
// instead of piling up copies. The user may edit the text inside; we never write
// this file ourselves — it's theirs — the markers are for THEM (and for a future
// «обновить правило»).
const MD_BEGIN = '<!-- claude-swarm-lite:begin -->';
const MD_END = '<!-- claude-swarm-lite:end -->';

// The marker phrase, made safe to embed in a shell command line. The launch command
// is typed into an interactive shell (main writes it to the pty), so a stray quote,
// `$`, backtick or `!` in a user-typed phrase would not just break the flag — it
// could swallow the rest of the line. Phrases are markers like «Сейчас от тебя»;
// none of these characters belong in one, so dropping them loses nothing.
function markerOf(phrases) {
  const list = Array.isArray(phrases) ? phrases : [];
  for (const raw of list) {
    const safe = String(raw == null ? '' : raw)
      .replace(/["'`$\\!<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (safe) return safe;
  }
  return DEFAULT_MARKER;
}

// ONE LINE, on purpose: it goes inside double quotes on a shell command line, where
// a newline would end the command. Wording stays short for the same reason — this
// text is visible for a moment in the terminal when the tab starts.
function systemPromptRule(phrases) {
  const m = markerOf(phrases);
  return [
    'Ты работаешь внутри Swarm: пользователь видит статус этой вкладки со стороны',
    'и может смотреть на неё из другой вкладки или с телефона, поэтому момент, когда ты ждёшь его,',
    'должен быть виден. Когда тебе нужен ответ, выбор или решение пользователя — задавай вопрос',
    'инструментом AskUserQuestion, а не только текстом. Если вопрос всё-таки остаётся в тексте,',
    `заканчивай сообщение отдельной строкой: ${m}: и дальше то, что от него нужно.`,
    `Если от пользователя ничего не нужно, эту строку не пиши, либо напиши ${m}: ничего, жди результата.`,
  ].join(' ');
}

// The same rule as a markdown section for the user's own CLAUDE.md. Free to be
// multi-line and a bit more explicit — nothing here goes through a shell.
function claudeMdRule(phrases) {
  const m = markerOf(phrases);
  return [
    MD_BEGIN,
    '## Как звать меня',
    '',
    'Я смотрю на агентов через Swarm: каждая вкладка показывает статус, и я могу быть',
    'в другой вкладке или в телефоне. Вкладка не может сама понять, закончил ты работу или задал',
    'вопрос — со стороны это выглядит одинаково. Поэтому:',
    '',
    '- Нужен ответ, выбор или решение — спрашивай инструментом `AskUserQuestion`, а не только текстом:',
    '  тогда вкладка сразу покажет, что ты ждёшь, и вопрос с вариантами дойдёт до меня в телефон.',
    `- Если вопрос остаётся в тексте, заканчивай сообщение отдельной строкой: \`${m}: …\` и дальше то,`,
    '  что от меня нужно.',
    `- Если от меня ничего не нужно, эту строку не пиши — или напиши \`${m}: ничего, жди результата\`,`,
    '  это считается «не зовёт».',
    MD_END,
  ].join('\n');
}

// Ready-to-append flag for the launch command line. Double quotes on both platforms:
// cmd.exe has no single-quote syntax, and the rule text is generated here, so we know
// it carries nothing that needs escaping inside them.
function appendSystemPromptFlag(phrases) {
  return `--append-system-prompt "${systemPromptRule(phrases)}"`;
}

return {
  DEFAULT_MARKER, MD_BEGIN, MD_END,
  markerOf, systemPromptRule, claudeMdRule, appendSystemPromptFlag,
};

});
