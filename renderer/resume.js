// resume.js — per-tab Claude session pinning for restore-after-relaunch.
// Dual-mode: window.SWARM_RESUME in the browser, module.exports under Node for tests.
// Pure helpers only — no DOM.
//
// Claude Code: start with `-n <key>` (a readable display name), restore with
// `--resume <handle>`. The handle is Claude's own session id (a UUID) whenever we
// know it — that reopens EXACTLY that conversation; the swarm-* name is the fallback
// for tabs saved before ids were kept, matched as a session title. Other agents are
// left alone here until they get their own adapters.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_RESUME = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Stem of a launch command (strip path separators). 'claude', 'cld', 'claude-glm'…
  function stemOf(cmd) {
    const raw = String(cmd || '').trim();
    if (!raw) return '';
    const base = raw.split(/[\\/]/).pop() || raw;
    return base.toLowerCase();
  }

  // Claude Code itself or common wrappers/aliases that accept its flags.
  function supports(cmd) {
    const s = stemOf(cmd);
    return s === 'claude' || s === 'cld' || s.startsWith('claude-');
  }

  // Stable handle we own; exact-match for `claude --resume <key>`.
  function newSessionKey() {
    let hex = '';
    for (let i = 0; i < 8; i++) hex += Math.floor(Math.random() * 16).toString(16);
    return 'swarm-' + hex;
  }

  // Drop flags that would fight with our -n / --resume injection. --fork-session goes
  // too: it only means anything next to --resume/--continue (both stripped here), and
  // left in it would give the resumed tab a NEW session id — so the id we saved, and
  // the transcript main binds the tab to, would point at the abandoned conversation.
  function stripSessionFlags(flags) {
    const tokens = String(flags || '').trim().split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '--continue' || t === '-c') continue;
      if (t === '--fork-session') continue;
      if (t === '--resume' || t === '-r' || t.startsWith('--resume=')) {
        if ((t === '--resume' || t === '-r') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++;
        continue;
      }
      if (t === '--name' || t === '-n' || t.startsWith('--name=')) {
        if ((t === '--name' || t === '-n') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++;
        continue;
      }
      out.push(t);
    }
    return out.join(' ');
  }

  // mode: 'start' → pin the display name with -n; 'resume' → --resume <handle>, where
  // the handle is the Claude session id if we have one, else the swarm-* name.
  // Non-Claude (or nothing to pin/resume with) → plain cmd + cleaned flags.
  function buildCommand({ cmd, flags, sessionKey, sessionId, mode } = {}) {
    const base = String(cmd || '').trim() || 'claude';
    const cleaned = stripSessionFlags(flags);
    const resuming = mode === 'resume';
    const handle = resuming ? (sessionId || sessionKey) : sessionKey;
    if (!handle || !supports(base)) {
      return (base + (cleaned ? ' ' + cleaned : '')).trim();
    }
    const pin = (resuming ? '--resume ' : '-n ') + handle;
    return (base + (cleaned ? ' ' + cleaned : '') + ' ' + pin).trim();
  }

  return { supports, newSessionKey, stripSessionFlags, buildCommand, stemOf };
});
