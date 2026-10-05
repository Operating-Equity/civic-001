// Where FactEngine's own key comes from. One rule, no conditions.
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
//   The settings file beside the server is FactEngine's configuration. If it names a key, that key is
//   the one FactEngine uses. The environment is used only when the settings file says nothing.
//
// This keeps hosts working, where there is no settings file and the environment is the only source.
// It makes an installed copy predictable: what the installer wrote is what runs. And when the two
// disagree, FactEngine says so rather than choosing in silence.
// The same rule serves every key FactEngine holds: OpenAI's (the default name below) and, since 4 October,
// DeepSeek's for the listing (DEEPSEEK_API_KEY) and, since 5 October, Fireworks' (FIREWORKS_API_KEY), so a stale shell
// can never beat any of them.
import fs from 'node:fs';

const NAME = 'OPENAI_API_KEY';

/** What an HTTP header may carry. A key outside this cannot be sent at all. */
export const HEADER_SAFE = /^[\x21-\x7E]+$/;

/**
 * A key from the environment under its name, or else under a name that differs from it only in capitals: the operator
 * saved DeepSeek's key in Render as DEEPSEEK_API_Key on 5 October (and the transcript key as CIVIC_TRANSCRIPT_KEy on
 * 22 September), and names are case-sensitive. The exact name wins. Spellings that hold different keys are not
 * guessed between: no key, and the names are reported so /check can say which to keep.
 */
export function envByName(environment, name) {
  const exact = String(environment[name] || '').trim();
  if (exact) return { value: exact, savedAs: name, ambiguous: [] };
  const upper = name.toUpperCase();
  const spellings = Object.keys(environment).filter((k) => k !== name && k.toUpperCase() === upper && String(environment[k] || '').trim());
  const values = new Set(spellings.map((k) => String(environment[k]).trim()));
  if (values.size === 1) return { value: [...values][0], savedAs: spellings.sort()[0], ambiguous: [] };
  return { value: '', savedAs: null, ambiguous: values.size > 1 ? spellings.sort() : [] };
}

function fromSettingsFile(file, name = NAME) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no settings file, or unreadable: the environment is then the only source */ }
  return '';
}

/**
 * Decides the key and reports everything about the decision, so startup and the check page can
 * explain it rather than assert it.
 */
export function resolveKey({ settingsFile, environment = process.env, name = NAME } = {}) {
  const inFile = settingsFile ? fromSettingsFile(settingsFile, name) : '';
  const env = envByName(environment, name);
  const inEnv = env.value;

  const chosen = inFile || inEnv;
  const source = inFile ? 'the settings file next to FactEngine'
    : (inEnv ? (env.savedAs === name ? 'this computer\'s environment' : `this computer's environment, saved as ${env.savedAs}`) : 'nowhere');

  return {
    name,
    value: chosen,
    source,
    // The name the key was saved under when it is not `name` exactly (its capitals differ), and the spellings that
    // disagree when more than one holds a key.
    savedAs: !inFile && inEnv && env.savedAs !== name ? env.savedAs : null,
    ambiguous: !inFile && !inEnv ? env.ambiguous : [],
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
export function whereTheShellSetsIt(home = process.env.HOME || '', name = NAME) {
  const found = [];
  if (!home) return found;
  for (const rc of ['.zshrc', '.zprofile', '.zshenv', '.bash_profile', '.bashrc', '.profile']) {
    const file = `${home}/${rc}`;
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (new RegExp(`\\b${name}\\s*=`).test(line) && !line.trim().startsWith('#')) {
          found.push({ file, line: i + 1 });
        }
      });
    } catch { /* not present, or not readable: nothing to report from this one */ }
  }
  return found;
}
