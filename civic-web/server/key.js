// Where CIVIC's own key comes from. One rule, no conditions.
//
// A reader lost an afternoon to two keys disagreeing. A truncated one exported in their shell weeks
// earlier beat the correct one the installer had just written beside the server, because
// `node --env-file` never overrides a variable already in the environment. Every request then failed
// inside the HTTP library, on every reinstall, in every browser.
//
// The first repair was a patch: prefer the settings file only when the environment's key was
// malformed. That was wrong twice over. It left the bad key in place to poison the next thing they
// ran, and it would still have let a well-formed but WRONG shell key silently beat the right one,
// which is the same fault wearing a disguise.
//
// The rule now is plain, and it is the same whether or not either key is any good:
//
//   The settings file beside the server is CIVIC's configuration. If it names a key, that key is
//   the one CIVIC uses. The environment is used only when the settings file says nothing.
//
// This keeps hosts working, where there is no settings file and the environment is the only source.
// It makes an installed copy predictable: what the installer wrote is what runs. And when the two
// disagree, CIVIC says so rather than choosing in silence.
import fs from 'node:fs';

const NAME = 'OPENAI_API_KEY';

/** What an HTTP header may carry. A key outside this cannot be sent at all. */
export const HEADER_SAFE = /^[\x21-\x7E]+$/;

function fromSettingsFile(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*${NAME}\\s*=\\s*(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no settings file, or unreadable: the environment is then the only source */ }
  return '';
}

/**
 * Decides the key and reports everything about the decision, so startup and the check page can
 * explain it rather than assert it.
 */
export function resolveKey({ settingsFile, environment = process.env } = {}) {
  const inFile = settingsFile ? fromSettingsFile(settingsFile) : '';
  const inEnv = String(environment[NAME] || '').trim();

  const chosen = inFile || inEnv;
  const source = inFile ? 'the settings file next to CIVIC' : (inEnv ? 'this computer\'s environment' : 'nowhere');

  return {
    value: chosen,
    source,
    fromFile: Boolean(inFile),
    // Both exist and differ: the reader has two answers to one question and deserves to be told.
    conflict: Boolean(inFile && inEnv && inFile !== inEnv),
    ignoredEnvKey: inFile && inEnv && inFile !== inEnv ? inEnv : '',
    usable: chosen ? HEADER_SAFE.test(chosen) : false,
    // The character that makes a key unsendable, for a message that names the real problem.
    offending: chosen ? offendingCharacter(chosen) : null,
  };
}

function offendingCharacter(key) {
  for (let i = 0; i < key.length; i++) {
    const code = key.codePointAt(i);
    if (code > 126 || code < 33) return { index: i, code, char: key[i] };
  }
  return null;
}

/** Where a shell variable of this name is set, so a reader can go and remove it. */
export function whereTheShellSetsIt(home = process.env.HOME || '') {
  const found = [];
  if (!home) return found;
  for (const name of ['.zshrc', '.zprofile', '.zshenv', '.bash_profile', '.bashrc', '.profile']) {
    const file = `${home}/${name}`;
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (new RegExp(`\\b${NAME}\\s*=`).test(line) && !line.trim().startsWith('#')) {
          found.push({ file, line: i + 1 });
        }
      });
    } catch { /* not present, or not readable: nothing to report from this one */ }
  }
  return found;
}
