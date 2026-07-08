// git.js — all git plumbing for the branch status bar. Pure Node on purpose
// (child_process only, no Electron), so it can be required from a plain
// `node -e` script and main.js just wires the IPC.
//
// Every command runs via execFile (no shell → a branch name can't inject) with
// GIT_TERMINAL_PROMPT=0 so a repo that needs interactive credentials fails fast
// instead of hanging this background process. Auth is inherited from the same
// environment the terminal uses (Keychain / ssh-agent), so normally these run
// silently just like `git` in the shell. No UI login by design.

const { execFile } = require('child_process');

const NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};

// Run a git subcommand in cwd. Never rejects — resolves { code, stdout, stderr }.
// code 0 = success; anything else (non-zero exit, ENOENT, timeout) = failure.
function runGit(cwd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...NO_PROMPT_ENV },
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

// { isRepo, branch, ahead, behind, dirty }. Non-repo / no git → { isRepo:false }.
async function gitInfo(cwd) {
  if (!cwd) return { isRepo: false };
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout !== 'true') return { isRepo: false };

  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let branch = head.stdout || 'HEAD';
  if (branch === 'HEAD') { // detached — show a short hash instead
    const short = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    branch = short.code === 0 && short.stdout ? `(${short.stdout})` : 'HEAD';
  }

  const status = await runGit(cwd, ['status', '--porcelain']);
  const dirty = status.stdout.length > 0;

  let ahead = 0, behind = 0;
  const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (counts.code === 0) { // no upstream → non-zero exit → leaves both 0
    const [l, r] = counts.stdout.split(/\s+/);
    behind = Number(l) || 0; // upstream has it, HEAD doesn't → behind
    ahead = Number(r) || 0;  // HEAD has it, upstream doesn't → ahead
  }

  return { isRepo: true, branch, ahead, behind, dirty };
}

// Local branch names. Caller marks which one is current (from gitInfo.branch).
async function gitBranches(cwd) {
  if (!cwd) return [];
  const res = await runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (res.code !== 0) return [];
  return res.stdout.split(/\r?\n/).filter(Boolean);
}

// Shape every mutating action the same way: { ok, error }.
function actionResult(res, fallback) {
  return { ok: res.code === 0, error: res.code === 0 ? null : (res.stderr || res.stdout || fallback) };
}

async function gitCheckout(cwd, branch) {
  return actionResult(await runGit(cwd, ['checkout', branch]), 'не удалось переключиться');
}

// Network op → longer timeout. --prune drops refs deleted on the remote.
async function gitFetch(cwd) {
  return actionResult(await runGit(cwd, ['fetch', '--prune'], 20000), 'не удалось обновить');
}

// --ff-only: never create a merge commit or leave a conflict behind our back.
// If it can't fast-forward, git errors and we surface it (user resolves in the terminal).
async function gitPull(cwd) {
  return actionResult(await runGit(cwd, ['pull', '--ff-only'], 20000), 'не удалось подтянуть');
}

module.exports = { runGit, gitInfo, gitBranches, gitCheckout, gitFetch, gitPull };
