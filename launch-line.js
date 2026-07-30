'use strict';
// What a new tab SEES when it starts.
//
// A tab is a real login shell, and the agent is started by TYPING a command into it
// (main.js session:create). The shell echoes what it's told, so everything swarm adds
// to that command — the statusline settings path, the ask rule (agent-rules.js), the
// permission mode, the session id — is the first thing the user reads in a fresh tab.
// The ask rule alone is half a thousand characters of Russian prose: six wrapped lines
// at 80 columns, and xterm smears them into garbage when the tab's first resize reflows
// them. This module is the two answers to that, and neither changes a byte of what
// claude actually receives:
//
//   envPassing() — long values travel in the shell's ENVIRONMENT, so the line only says
//     `--append-system-prompt "$SWARM_ASK_RULE"`.
//   clearPrefix() — a `clear` in front of the command wipes even that, so the tab opens
//     on the agent instead of on our bookkeeping.
//
// Own module (and own test) rather than four functions in main because the cost of a
// mistake here is invisible in review and loud in use: a reference the shell doesn't
// expand hands claude a literal `$SWARM_ASK_RULE` as its system prompt, or a settings
// path that doesn't exist — and claude then refuses to start, so the tab greets its
// owner with a dead shell instead of an agent.
// Shells whose `"$VAR"` means what we think it means. Not a guess list: each of these
// expands a double-quoted reference the POSIX way (fish and csh included — they differ
// in plenty of things, but not in this one).
const POSIX_SHELLS = ['sh', 'bash', 'zsh', 'ksh', 'mksh', 'dash', 'ash', 'fish', 'csh', 'tcsh'];

// 'posix' | 'cmd' | 'powershell' | null. null means «unknown shell» (nushell, xonsh,
// elvish, something homegrown in $SHELL) — we then pass values inline instead of
// guessing a syntax, see envPassing.
// Split on both separators by hand instead of path.basename: this reads $SHELL/%COMSPEC%,
// and a `C:\…\cmd.exe` handed to a POSIX path.basename comes back whole — the family
// would be «unknown» and every Windows tab would take the fallback for no reason.
function shellFamily(shellPath) {
  const base = String(shellPath || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (base === 'cmd') return 'cmd';
  if (base === 'powershell' || base === 'pwsh') return 'powershell';
  if (POSIX_SHELLS.includes(base)) return 'posix';
  return null;
}

// A collector for the values we'd rather not show. `ref(name, value)` remembers the
// value under that name and returns how the command line should spell it — an
// environment reference for a shell we recognise, the plain quoted value otherwise.
// `env` is what main merges into pty.spawn's environment.
function envPassing(shellPath) {
  const family = shellFamily(shellPath);
  const env = {};
  return {
    env,
    ref(name, value) {
      const v = String(value == null ? '' : value);
      if (family === 'posix') { env[name] = v; return `"$${name}"`; }
      if (family === 'cmd') { env[name] = v; return `"%${name}%"`; }
      if (family === 'powershell') { env[name] = v; return `"$env:${name}"`; }
      return `"${v}"`;
    },
  };
}

// Run `clear` before the command. On an xterm `clear` also drops the scrollback
// (ESC[3J), so scrolling up in a fresh tab shows the conversation and nothing else.
// cmd.exe has its own name for it and its own separator; every other shell we can land
// in separates with `;` and has `clear` on PATH. If it somehow doesn't, the worst case
// is one «command not found» above the agent — the command after the separator still
// runs, which is why this is a prefix and not `clear && …`.
function clearPrefix(shellPath) {
  return shellFamily(shellPath) === 'cmd' ? 'cls&' : 'clear; ';
}

module.exports = { POSIX_SHELLS, shellFamily, envPassing, clearPrefix };
