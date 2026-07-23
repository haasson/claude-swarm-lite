// diffview.js — unified-diff parsing + change-tree building. Dual-mode:
// window.SWARM_DIFF in the browser (loaded via <script> before renderer.js),
// module.exports under Node so test/diff.test.js can require it.
// NO DOM, NO git here — just strings in, structures out, so it's unit-testable.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_DIFF = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // A zero side renders as '' so the bar shows "+5" alone rather than "+5 −0".
  // U+2212 MINUS SIGN, not a hyphen: it aligns with digits in the mono font.
  function formatCount({ added = 0, removed = 0 } = {}) {
    return {
      added: added > 0 ? '+' + added : '',
      removed: removed > 0 ? '−' + removed : '',
    };
  }

  // Parse `git diff --numstat -z`. NUL-separated records, each 'added\tremoved\tpath\0'.
  // A rename has an EMPTY path field and is followed by two extra NUL fields —
  // old path, then new path ('3\t1\t\0old\0new\0'). We walk the fields with an
  // index rather than splitting on '\t' per line, because -z means a path can
  // itself contain anything except NUL (spaces, quotes, кириллица).
  // Binary files come back as '-\t-\tpath': Number('-') is NaN, which would reach
  // the bar as "+NaN", so they're pinned to 0 and flagged instead.
  function parseNumstatZ(text) {
    const fields = String(text || '').split('\0');
    const out = [];
    for (let i = 0; i < fields.length; i++) {
      const rec = fields[i];
      if (!rec) continue;
      const tab1 = rec.indexOf('\t');
      const tab2 = rec.indexOf('\t', tab1 + 1);
      if (tab1 < 0 || tab2 < 0) continue;
      const rawAdd = rec.slice(0, tab1);
      const rawDel = rec.slice(tab1 + 1, tab2);
      let path = rec.slice(tab2 + 1);
      let oldPath = null;
      if (path === '') { // rename/copy: the two paths follow as their own fields
        oldPath = fields[++i] || '';
        path = fields[++i] || '';
      }
      const binary = rawAdd === '-' || rawDel === '-';
      const added = binary ? 0 : (Number(rawAdd) || 0);
      const removed = binary ? 0 : (Number(rawDel) || 0);
      out.push({
        path,
        oldPath,
        added,
        removed,
        status: binary ? 'binary' : (oldPath ? 'renamed' : 'modified'),
        binary,
      });
    }
    return out;
  }

  const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  // Parse unified diff text into hunks of typed, numbered lines.
  // Everything before the first @@ (diff --git / index / --- / +++) is dropped:
  // we already know the path from numstat, and the file header is not content.
  //
  // '\' is a real marker line ('\ No newline at end of file'), NOT context —
  // typed 'meta' so it renders muted and, crucially, consumes no line number.
  function parseUnified(text) {
    const hunks = [];
    let cur = null;
    let oldNo = 0;
    let newNo = 0;
    for (const raw of String(text || '').split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // CRLF repos
      const m = HUNK_RE.exec(line);
      if (m) {
        cur = { header: line, lines: [] };
        hunks.push(cur);
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
        continue;
      }
      if (!cur) continue; // pre-hunk file headers
      const kind = line[0];
      const body = line.slice(1);
      if (kind === '+') cur.lines.push({ type: 'add', text: body, oldNo: null, newNo: newNo++ });
      else if (kind === '-') cur.lines.push({ type: 'del', text: body, oldNo: oldNo++, newNo: null });
      else if (kind === ' ') cur.lines.push({ type: 'ctx', text: body, oldNo: oldNo++, newNo: newNo++ });
      else if (kind === '\\') cur.lines.push({ type: 'meta', text: body.trim(), oldNo: null, newNo: null });
      // anything else (including the trailing '') is not diff content — skip
    }
    return hunks;
  }

  // Group a flat list of changed files into a folder tree, GitLab-MR style.
  // Only touched paths — this is NOT a project browser (see the spec's YAGNI).
  // Node shapes:
  //   dir  -> { kind:'dir',  name, path, added, removed, children: [] }
  //   file -> { kind:'file', name, path, added, removed, file }
  // Folders sort before files at each level; within a level, insertion order is
  // kept (git already hands paths back sorted, and re-sorting would fight it).
  function buildTree(files) {
    const root = { children: [], index: new Map() };

    for (const f of files || []) {
      const parts = String(f.path || '').split('/').filter(Boolean);
      if (!parts.length) continue;
      let node = root;
      let sofar = '';
      for (let i = 0; i < parts.length - 1; i++) {
        sofar = sofar ? sofar + '/' + parts[i] : parts[i];
        let dir = node.index.get(sofar);
        if (!dir) {
          // `index` is scratch: a path → node map so the second file in a folder
          // finds it instead of creating a twin. Stripped in clean() below.
          dir = { kind: 'dir', name: parts[i], path: sofar, added: 0, removed: 0, children: [], index: new Map() };
          node.index.set(sofar, dir);
          node.children.push(dir);
        }
        dir.added += f.added || 0;
        dir.removed += f.removed || 0;
        node = dir;
      }
      node.children.push({
        kind: 'file',
        name: parts[parts.length - 1],
        path: f.path,
        added: f.added || 0,
        removed: f.removed || 0,
        file: f,
      });
    }

    // Drop the internal index maps and put dirs first, depth-first.
    const clean = (nodes) => {
      const dirs = nodes.filter((n) => n.kind === 'dir');
      const leaves = nodes.filter((n) => n.kind === 'file');
      for (const d of dirs) { delete d.index; d.children = clean(d.children); }
      return [...dirs, ...leaves];
    };
    return clean(root.children);
  }

  return { formatCount, parseNumstatZ, parseUnified, buildTree };
});
