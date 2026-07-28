// preload.js — the only bridge between the sandboxed renderer and Node/main.
//
// With contextIsolation on, the renderer has no `require`. We expose a tiny,
// explicit API on window.swarm. Nothing else leaks in. Keep this surface small.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swarm', {
  // The host OS ('darwin' | 'win32' | 'linux'), so the UI can drop mac-only
  // chrome (traffic-light gaps) on Windows/Linux.
  platform: process.platform,

  // Open a native folder picker (opens at defaultPath if given).
  // Returns the chosen path, or null if cancelled.
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),

  // List custom slash commands for a project dir (+ global). [{name, hint, arg, scope}]
  listCommands: (cwd) => ipcRenderer.invoke('commands:list', cwd),

  // Ask main to spawn a session. Returns { id }.
  // opts: { cwd?, cols?, rows?, command? }
  createSession: (opts) => ipcRenderer.invoke('session:create', opts),

  // Send user keystrokes to a session's pty.
  sendInput: (id, data) => ipcRenderer.send('session:input', { id, data }),

  // Tell main the terminal grid changed size.
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', { id, cols, rows }),

  // Close a session.
  killSession: (id) => ipcRenderer.send('session:kill', { id }),

  // Bring the app window forward (used when a notification is clicked).
  focusApp: () => ipcRenderer.send('app:focus'),

  // Tell main a UI action (tab switch / layout change) is about to repaint the
  // terminals — so their focus/redraw burst isn't mistaken for real activity.
  uiRepaint: () => ipcRenderer.send('ui:repaint'),

  // Opt-in «precise status via Claude hooks». Renderer pushes the saved pref on
  // startup and on toggle; main adds/removes the hooks block in swarm-settings.json
  // (scoped to swarm sessions). Takes effect on sessions started after the change.
  setHooksEnabled: (on) => ipcRenderer.send('settings:hooks', on),

  // The phrases that mean «the agent is calling me» (Settings → Запуск). Pushed on
  // startup and on save; main feeds both the screen detector and the Stop hook.
  setAskPhrases: (list) => ipcRenderer.send('settings:askPhrases', list),

  // Git plumbing for the branch status bar. Each call targets a folder path
  // (the active session's cwd). info → { isRepo, branch, ahead, behind, dirty };
  // branches → string[]; fetch/pull/checkout → { ok, error };
  // diffstat → { added, removed, files[] }; difftext → unified diff of one file.
  git: {
    info:     (cwd)         => ipcRenderer.invoke('git:info', cwd),
    branches: (cwd)         => ipcRenderer.invoke('git:branches', cwd),
    fetch:    (cwd)         => ipcRenderer.invoke('git:fetch', cwd),
    pull:     (cwd)         => ipcRenderer.invoke('git:pull', cwd),
    checkout: (cwd, branch) => ipcRenderer.invoke('git:checkout', cwd, branch),
    diffstat: (cwd)         => ipcRenderer.invoke('git:diffstat', cwd),
    difftext: (cwd, path)   => ipcRenderer.invoke('git:difftext', cwd, path),
  },

  // Open a file in the OS' default editor (the diff overlay's way out to an IDE).
  // cwd + relative path — main joins them platform-correctly.
  openPath: (cwd, rel) => ipcRenderer.invoke('shell:openPath', cwd, rel),

  // Subscribe to pty output. cb({ id, data }). Returns an unsubscribe fn.
  onData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:data', handler);
    return () => ipcRenderer.removeListener('session:data', handler);
  },

  // Subscribe to session exit. cb({ id, code }). Returns an unsubscribe fn.
  onExit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:exit', handler);
    return () => ipcRenderer.removeListener('session:exit', handler);
  },

  // Subscribe to inferred status changes. cb({ id, status, detail }).
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:status', handler);
    return () => ipcRenderer.removeListener('session:status', handler);
  },

  // Native "Справка" menu item (main) asks the renderer to open the help overlay.
  onOpenHelp: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('open-help', handler);
    return () => ipcRenderer.removeListener('open-help', handler);
  },

  // Copy a string to the system clipboard via Electron (correct UTF-8 encoding).
  // Used for ⌘C so a terminal/modal selection with Cyrillic doesn't get mangled.
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),

  // Open a clicked terminal link in the default browser. Main validates the
  // scheme (http/https only) before handing it to the OS.
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  // Native Edit → Copy (⌘C) asks the renderer to copy the current selection.
  onMenuCopy: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('menu:copy', handler);
    return () => ipcRenderer.removeListener('menu:copy', handler);
  },

  // Main-process errors, forwarded so they land in the in-app log viewer.
  // cb({ ts, source, level, msg }). Returns an unsubscribe fn.
  onAppError: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('app:error', handler);
    return () => ipcRenderer.removeListener('app:error', handler);
  },

  // --- auto-update ---
  getVersion: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: (url, sha256) => ipcRenderer.invoke('update:apply', { url, sha256 }),
  updateDownloadInstaller: (url, filename) => ipcRenderer.invoke('update:installer', { url, filename }),
  updateRelaunch: () => ipcRenderer.send('update:relaunch'),
  onUpdateProgress: (cb) => {
    const handler = (_e, pct) => cb(pct);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
});
