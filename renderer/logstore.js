// logstore.js — a tiny in-memory ring buffer for app logs. Dual-mode: attaches to
// window.SWARM_LOGSTORE in the browser (loaded via <script> before renderer.js) and
// exports via module.exports under Node for test/logstore.test.js. Pure, no DOM.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_LOGSTORE = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Entry shape: { ts, source, level, msg }. Keeps the last `cap` entries; tracks
  // how many of those are error-level (drives the red "!" indicator).
  function createLogStore(cap) {
    cap = cap || 200;
    const items = [];
    let errors = 0;
    // Прочитанное отдельно от накопленного: красным горит только то, что человек ещё не
    // видел. Иначе одна ночная ошибка светится до перезапуска приложения и перестаёт
    // что-либо значить — на такой значок просто перестают смотреть.
    let unseen = 0;
    return {
      push(entry) {
        entry = entry || {};
        const e = {
          ts: entry.ts || '',
          source: entry.source || 'ui',
          level: entry.level || 'error',
          msg: String(entry.msg == null ? '' : entry.msg),
        };
        items.push(e);
        if (e.level === 'error') { errors++; unseen++; }
        while (items.length > cap) {
          const removed = items.shift();
          if (removed.level === 'error') errors--;
        }
        if (unseen > errors) unseen = errors; // вытеснили из кольца непрочитанное
        return e;
      },
      entries() { return items.slice(); },
      errorCount() { return errors; },
      unseenCount() { return unseen; },
      markSeen() { unseen = 0; },
      size() { return items.length; },
      text() {
        return items.map((e) => `[${e.ts}] ${e.source}/${e.level}: ${e.msg}`).join('\n');
      },
      clear() { items.length = 0; errors = 0; unseen = 0; },
    };
  }
  return { createLogStore };
});
