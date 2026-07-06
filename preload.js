// preload.js — the only bridge between the sandboxed renderer and Node/main.
//
// With contextIsolation on, the renderer has no `require`. We expose a tiny,
// explicit API on window.swarm. Nothing else leaks in. Keep this surface small.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swarm', {
  // Open a native folder picker. Returns the chosen path, or null if cancelled.
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  // Ask main to spawn a session. Returns { id }.
  // opts: { cwd?, cols?, rows?, command? }
  createSession: (opts) => ipcRenderer.invoke('session:create', opts),

  // Send user keystrokes to a session's pty.
  sendInput: (id, data) => ipcRenderer.send('session:input', { id, data }),

  // Tell main the terminal grid changed size.
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', { id, cols, rows }),

  // Close a session.
  killSession: (id) => ipcRenderer.send('session:kill', { id }),

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
});
