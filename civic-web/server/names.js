// The words FactEngine reads the model's entries by: the headings under which an entry states its verdict, its
// confidence and its inspector, the verdict words themselves, and the listing's claim label, role label and role words.
// They are the operator's, like the prompts, and live where the prompts live: CIVIC_OUTPUT_NAMES (a JSON object) or
// CIVIC_OUTPUT_NAMES_FILE (a secret file holding one), never this repository. Unset, each is the word FactEngine has
// always read; the role words (24 October) are those of the listing prompt installed that day. A word the operator sets
// replaces its default, so a heading the prompt no longer writes is no longer read.
//
// {"conclusion": ["…"], "confidence": ["…"], "name": ["…"], "verdicts": {"true": ["…"], "false": ["…"],
//  "unverified": ["…"]}, "verdictTags": ["…"], "inspector": "Inspector {initial}", "titles": ["…"], "claim": ["…"],
//  "role": ["…"], "roles": {"central": ["…"], "supporting": ["…"], "incidental": ["…"], "unranked": ["…"]}}
//
// Every key is optional. A list that is not JSON, a key FactEngine does not read, or an empty word stops the service at
// start, naming the key and never a value (a deploy that cannot start leaves the one before it running).
import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULTS = {
  conclusion: ['Conclusion'],
  confidence: ['Confidence'],
  name: ['Name'],
  verdicts: { true: ['true'], false: ['false'], unverified: ['uncertain', 'unverified', 'unverifiable', 'indeterminate', 'inconclusive'] },
  verdictTags: ['verdict', 'determination'],
  inspector: 'Inspector {initial}',
  titles: [],
  claim: ['Claim'],
  // A claim's role, read from its role line (server/extract.js): where the page shows it (the operator's answers of 24
  // October). Supporting claims wait behind "Show the other claims"; Incidental ones are not offered for testing.
  role: ['Role'],
  roles: { central: ['Central'], supporting: ['Supporting'], incidental: ['Incidental'], unranked: ['Unranked'] },
};

const fail = (key, why) => { throw new Error(`CIVIC_OUTPUT_NAMES: ${key} ${why}`); };

function words(key, value) {
  const list = Array.isArray(value) ? value : [value];
  const out = list.map((s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''));
  if (!out.length || out.some((s) => !s)) fail(key, 'must be a word or a list of words, none of them empty');
  return out;
}

/** The names in force: the vault's list over the defaults. `installed` is its fingerprint, or null when none is set. */
export function loadNames(env = process.env) {
  let raw = String(env.CIVIC_OUTPUT_NAMES || '').trim();
  const file = String(env.CIVIC_OUTPUT_NAMES_FILE || '').trim();
  if (!raw && file) {
    try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { fail('(the file)', 'could not be read'); }
  }
  const out = { ...DEFAULTS, verdicts: { ...DEFAULTS.verdicts }, roles: { ...DEFAULTS.roles }, installed: null, keys: 0 };
  if (!raw) return out;
  let set;
  try { set = JSON.parse(raw); } catch { fail('(the list)', 'is not JSON'); }
  if (!set || typeof set !== 'object' || Array.isArray(set)) fail('(the list)', 'must be an object');
  for (const [key, value] of Object.entries(set)) {
    if (!(key in DEFAULTS)) fail(key, 'is not a name FactEngine reads');
    if (key === 'verdicts') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(key, 'must be an object of true, false and unverified');
      for (const [v, list] of Object.entries(value)) {
        if (!(v in DEFAULTS.verdicts)) fail(`verdicts.${v}`, 'is not a verdict FactEngine reads');
        out.verdicts[v] = words(`verdicts.${v}`, list).map((w) => w.toLowerCase());
      }
    } else if (key === 'roles') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(key, 'must be an object of central, supporting, incidental and unranked');
      for (const [r, list] of Object.entries(value)) {
        if (!(r in DEFAULTS.roles)) fail(`roles.${r}`, 'is not a role FactEngine reads');
        out.roles[r] = words(`roles.${r}`, list);
      }
    } else if (key === 'inspector') {
      if (typeof value !== 'string' || !value.includes('{initial}')) fail(key, 'must be words holding {initial}');
      out.inspector = value.trim();
    } else if (key === 'titles') {
      out.titles = Array.isArray(value) && value.length === 0 ? [] : words(key, value);
    } else out[key] = words(key, value);
  }
  out.installed = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  out.keys = Object.keys(set).length;
  return out;
}

export const names = loadNames();

/** Words as one pattern: each in any spacing, the longest first, so a longer heading is never read as a shorter one. */
export const anyOf = (list) => [...list].sort((a, b) => b.length - a.length)
  .map((s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');
