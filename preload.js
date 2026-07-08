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
});
