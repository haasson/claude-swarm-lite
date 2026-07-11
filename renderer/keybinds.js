// keybinds.js — terminal input remaps + app hotkeys. Dual-mode: attaches to
// window.SWARM_KEYBINDS in the browser (loaded via <script> before renderer.js),
// and exports via module.exports under Node so test/keybinds.test.js can require it.
// NO DOM / xterm here — just data and matching, so it's unit-testable in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_KEYBINDS = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Fixed action list. `kind: 'input'` → send BYTES to the pty; `kind: 'app'` →
  // handled in the renderer (e.g. scrollToBottom).
  const ACTIONS = [
    { id: 'newline', kind: 'input', label: 'Перенос строки' },
    { id: 'wordLeft', kind: 'input', label: 'Слово влево' },
    { id: 'wordRight', kind: 'input', label: 'Слово вправо' },
    { id: 'lineStart', kind: 'input', label: 'В начало строки' },
    { id: 'lineEnd', kind: 'input', label: 'В конец строки' },
    { id: 'scrollBottom', kind: 'app', label: 'Прокрутка вниз' },
  ];

  // Canonical bytes Claude / readline understand (not the user's physical chord).
  const BYTES = {
    newline: '\n',       // Ctrl+J — universal newline in Claude Code
    wordLeft: '\x1bb',   // Esc+b
    wordRight: '\x1bf',  // Esc+f
    lineStart: '\x01',   // Ctrl+A
    lineEnd: '\x05',     // Ctrl+E
  };

  // macOS: ⌘ vs ⌃ distinguishes word vs line. Windows has no ⌘ — use Ctrl for
  // word/newline and Home/End for line ends (Ctrl+← would otherwise collide).
  const DEFAULT_KEYBINDS_DARWIN = {
    newline: { key: 'Enter', meta: true, ctrl: false, alt: false, shift: false },
    wordLeft: { key: 'ArrowLeft', meta: true, ctrl: false, alt: false, shift: false },
    wordRight: { key: 'ArrowRight', meta: true, ctrl: false, alt: false, shift: false },
    lineStart: { key: 'ArrowLeft', meta: false, ctrl: true, alt: false, shift: false },
    lineEnd: { key: 'ArrowRight', meta: false, ctrl: true, alt: false, shift: false },
    scrollBottom: { key: 'ArrowDown', meta: false, ctrl: false, alt: false, shift: true },
  };

  const DEFAULT_KEYBINDS_WIN = {
    newline: { key: 'Enter', meta: false, ctrl: true, alt: false, shift: false },
    wordLeft: { key: 'ArrowLeft', meta: false, ctrl: true, alt: false, shift: false },
    wordRight: { key: 'ArrowRight', meta: false, ctrl: true, alt: false, shift: false },
    lineStart: { key: 'Home', meta: false, ctrl: false, alt: false, shift: false },
    lineEnd: { key: 'End', meta: false, ctrl: false, alt: false, shift: false },
    scrollBottom: { key: 'ArrowDown', meta: false, ctrl: false, alt: false, shift: true },
  };

  // Alias kept for older callers/tests — mac defaults.
  const DEFAULT_KEYBINDS = DEFAULT_KEYBINDS_DARWIN;

  function isDarwin(platform) {
    return platform === 'darwin';
  }

  function defaultsFor(platform) {
    return isDarwin(platform) ? DEFAULT_KEYBINDS_DARWIN : DEFAULT_KEYBINDS_WIN;
  }

  // App shortcuts that must not be stolen by remaps (⌘T / Ctrl+T new, …).
  const RESERVED = [
    { key: 't', meta: true, ctrl: false, alt: false, shift: false },
    { key: 'w', meta: true, ctrl: false, alt: false, shift: false },
    { key: 'o', meta: true, ctrl: false, alt: false, shift: false },
    { key: 'k', meta: true, ctrl: false, alt: false, shift: false },
    { key: ',', meta: true, ctrl: false, alt: false, shift: false },
    { key: 'l', meta: true, ctrl: false, alt: false, shift: false },
    { key: '1', meta: true, ctrl: false, alt: false, shift: false },
    { key: '2', meta: true, ctrl: false, alt: false, shift: false },
    { key: '3', meta: true, ctrl: false, alt: false, shift: false },
    { key: '4', meta: true, ctrl: false, alt: false, shift: false },
    { key: '5', meta: true, ctrl: false, alt: false, shift: false },
    { key: '6', meta: true, ctrl: false, alt: false, shift: false },
    { key: '7', meta: true, ctrl: false, alt: false, shift: false },
    { key: '8', meta: true, ctrl: false, alt: false, shift: false },
    { key: '9', meta: true, ctrl: false, alt: false, shift: false },
  ];

  function chordEqual(a, b) {
    if (!a || !b) return false;
    return a.key === b.key
      && !!a.meta === !!b.meta
      && !!a.ctrl === !!b.ctrl
      && !!a.alt === !!b.alt
      && !!a.shift === !!b.shift;
  }

  // Normalize a stored/captured chord. Returns null for "unbound" / garbage.
  function normalizeChord(raw) {
    if (raw == null) return null;
    if (typeof raw !== 'object') return null;
    const key = typeof raw.key === 'string' ? raw.key : '';
    if (!key) return null;
    // Modifier-only presses are not valid bindings.
    if (['Meta', 'Control', 'Alt', 'Shift', 'MetaLeft', 'MetaRight',
         'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
         'ShiftLeft', 'ShiftRight'].includes(key)) return null;
    return {
      key,
      meta: !!raw.meta,
      ctrl: !!raw.ctrl,
      alt: !!raw.alt,
      shift: !!raw.shift,
    };
  }

  function chordFromEvent(ev) {
    return normalizeChord({
      key: ev.key,
      meta: ev.metaKey,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      shift: ev.shiftKey,
    });
  }

  function chordMatches(chord, ev) {
    if (!chord) return false;
    return chordEqual(chord, chordFromEvent(ev));
  }

  function isReserved(chord) {
    if (!chord) return false;
    // Reserved list is meta-only on mac; also treat ctrl+same-key as reserved on
    // non-mac where the app listener uses ctrl as the accelerator.
    const lower = { ...chord, key: String(chord.key).toLowerCase() };
    for (const r of RESERVED) {
      if (chordEqual(lower, r)) return true;
      if (chordEqual(lower, { ...r, meta: false, ctrl: true })) return true;
    }
    return false;
  }

  // Coerce any stored/garbage value into a full keybinds object. Never throws.
  // Missing / invalid action → that action's platform default. Explicit null stays
  // null (user cleared the binding). On win/linux, leftover mac defaults (⌘…)
  // are rewritten to the Windows set so first-run mac-shaped storage is fixed.
  function normalizeKeybinds(raw, platform) {
    const defaults = defaultsFor(platform);
    const r = (raw && typeof raw === 'object') ? raw : {};
    const out = {};
    for (const a of ACTIONS) {
      if (Object.prototype.hasOwnProperty.call(r, a.id) && r[a.id] === null) {
        out[a.id] = null;
        continue;
      }
      const c = normalizeChord(r[a.id]);
      if (c && !isReserved(c)) {
        if (!isDarwin(platform) && chordEqual(c, DEFAULT_KEYBINDS_DARWIN[a.id])) {
          out[a.id] = { ...defaults[a.id] };
        } else {
          out[a.id] = c;
        }
      } else {
        out[a.id] = { ...defaults[a.id] };
      }
    }
    return out;
  }

  // First matching input-kind action id, or null.
  function matchInputKeybind(binds, ev) {
    const b = binds || DEFAULT_KEYBINDS;
    for (const a of ACTIONS) {
      if (a.kind !== 'input') continue;
      if (chordMatches(b[a.id], ev)) return a.id;
    }
    return null;
  }

  // App-kind action id matching the event, or null.
  function matchAppKeybind(binds, ev) {
    const b = binds || DEFAULT_KEYBINDS;
    for (const a of ACTIONS) {
      if (a.kind !== 'app') continue;
      if (chordMatches(b[a.id], ev)) return a.id;
    }
    return null;
  }

  const KEY_LABELS = {
    // Only widely recognized key glyphs; modifiers are always plain text.
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Esc',
    Home: 'Home',
    End: 'End',
    ' ': 'Space',
  };

  // Ordered list of keycap labels for a chord (modifiers then key). Empty if unbound.
  function chordParts(chord, platform) {
    if (!chord) return [];
    const parts = [];
    if (isDarwin(platform)) {
      if (chord.ctrl) parts.push('Ctrl');
      if (chord.alt) parts.push('Option');
      if (chord.shift) parts.push('Shift');
      if (chord.meta) parts.push('Cmd');
    } else {
      if (chord.ctrl) parts.push('Ctrl');
      if (chord.alt) parts.push('Alt');
      if (chord.shift) parts.push('Shift');
      if (chord.meta) parts.push('Win');
    }
    const k = KEY_LABELS[chord.key]
      || (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
    parts.push(k);
    return parts;
  }

  function formatChord(chord, platform) {
    if (!chord) return 'не задано';
    return chordParts(chord, platform).join('+');
  }

  return {
    ACTIONS,
    BYTES,
    DEFAULT_KEYBINDS,
    DEFAULT_KEYBINDS_DARWIN,
    DEFAULT_KEYBINDS_WIN,
    RESERVED,
    defaultsFor,
    normalizeChord,
    normalizeKeybinds,
    chordFromEvent,
    chordEqual,
    chordMatches,
    isReserved,
    matchInputKeybind,
    matchAppKeybind,
    chordParts,
    formatChord,
  };
});
