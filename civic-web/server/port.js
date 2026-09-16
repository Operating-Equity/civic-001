// Who holds CIVIC's port, and whether it is an older CIVIC.
//
// An update that looked as though it had not taken effect was an older CIVIC still holding the
// port: the new files were on disk, but yesterday's process went on answering, with yesterday's
// fault. The first remedy looked for the word "civic" in the process's command line. That line is
// "node --env-file-if-exists=.env server/index.js", which contains no such word, so nothing was
// ever closed, the new CIVIC could not start, and the browser opened on the old one again.
//
// A CIVIC is recognised here by evidence that cannot be spelled differently: the directory it runs
// from and the Node it runs on. Anything else on the port is described and left alone.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString();
  } catch (err) {
    return err?.stdout ? String(err.stdout) : '';   // lsof exits 1 when it finds nothing
  }
}

/** Process ids listening on the port, other than this one. Empty when nothing is, or nothing can be told. */
export function listenersOn(port) {
  return run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    .split(/\s+/).map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/** The command line, working directory and executable of a process, as far as the system will say. */
export function describeProcess(pid) {
  const info = { pid, command: run('ps', ['-p', String(pid), '-o', 'command=']).trim(), cwd: '', exe: '' };
  let fd = '';
  for (const line of run('lsof', ['-a', '-p', String(pid), '-d', 'cwd,txt', '-Ffn']).split('\n')) {
    if (line[0] === 'f') fd = line.slice(1);
    else if (line[0] === 'n') {
      if (fd === 'cwd' && !info.cwd) info.cwd = line.slice(1);
      if (fd === 'txt' && !info.exe) info.exe = line.slice(1);
    }
  }
  return info;
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const within = (p, dir) => Boolean(p && dir) && (p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep));

/** Whether a process is a CIVIC: it runs from a CIVIC directory, or on the Node the installer put there. */
export function isCivic(info, { appDir = '', home = process.env.HOME || '' } = {}) {
  const installDir = home ? real(path.join(home, 'civic')) : '';
  return within(info.cwd, appDir ? real(appDir) : '')   // this very copy
    || within(info.cwd, installDir)                      // the installed copy
    || within(info.exe, installDir)                      // the private Node inside the installed copy
    || /civic/i.test(info.cwd);                          // a copy kept somewhere named for it
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthBuild(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await res.json())?.build || '';
  } catch { return ''; }
}

/**
 * Closes every older CIVIC holding the port and reports what it found. A process that is not a
 * CIVIC is never touched; it is described, so the person can close it themselves. The strongest
 * evidence comes first: whatever holds the port answers CIVIC's own health check with a build
 * stamp, so it is a CIVIC, whatever the process list says of it.
 */
export async function takeOverPort(port, { appDir, home } = {}) {
  const found = { closed: [], foreign: [], unknown: false, build: '' };
  const pids = listenersOn(port);
  found.build = await healthBuild(port);
  if (!pids.length) { found.unknown = true; return found; }
  for (const pid of pids) {
    const info = describeProcess(pid);
    if (!found.build && !isCivic(info, { appDir, home })) { found.foreign.push(info); continue; }
    try { process.kill(pid, 'SIGTERM'); found.closed.push(info); }
    catch (err) { if (err.code !== 'ESRCH') found.foreign.push({ ...info, error: err.code }); }
  }
  if (!found.closed.length) return found;
  for (let i = 0; i < 20; i++) {                        // up to five seconds for a clean exit
    if (!listenersOn(port).some((pid) => found.closed.some((c) => c.pid === pid))) return found;
    await sleep(250);
  }
  for (const c of found.closed) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* already gone */ } }
  await sleep(500);
  return found;
}
