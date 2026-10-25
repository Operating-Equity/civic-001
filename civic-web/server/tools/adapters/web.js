// Source: the web, read by CIVIC's own link reader (server/fetchurl.js) with all of its rules: the
// silence memory, the paywall marker, the YouTube doors and the transcript service the operator set.
// No key: always on. It costs nothing but the reader's time, so its ledger line is priced at zero
// unless the operator sets a figure.
import { readUrl, youtubeTranscript } from '../../fetchurl.js';
import { listedSite, NOT_CONSULTED } from '../../sites.js';
import { ToolRefusal } from '../contract.js';

// THE MODEL READS THE BLURB: the operator's text.
const BLURB = 'any public web page, article or PDF, and the transcripts of YouTube videos';

const item = (got) => ({
  kind: got.kind === 'youtube' ? 'transcript' : got.kind || 'page',
  title: got.title || null,
  site: got.site || got.author || null,
  url: got.url || null,
  date: got.published || null,
  text: got.text || '',
  // A page its site marks as for subscribers, sent whole or in part: the model reads what came and decides (the operator's rule of 19 September).
  note: got.wall ? 'The site marks this article as for subscribers; this is what it sent.' : got.note || null,
});

// What the operator keeps out of the research (server/sites.js): refused before it is asked, when the address it is
// asked for ends there, and when the page's markup names it one of the kinds kept out. The model reads the one sentence;
// the site is not named.
const refuse = () => { throw new ToolRefusal(NOT_CONSULTED, 'site_kept_out'); };
const refuseListed = (address) => { if (listedSite(address)) refuse(); };

export default {
  id: 'web',
  name: 'the web',
  blurb: BLURB,
  settings: {},
  usdPerCall: { env: 'CIVIC_WEB_USD_PER_CALL', fallback: '0' },
  verbs: {
    async read_page({ url }, { signal }) {
      refuseListed(url);
      const got = await readUrl(String(url || ''), { signal });
      refuseListed(got.url);
      if (got.kept) refuse();
      return { items: [item(got)], cursor: null };
    },
    async get_transcript({ url }, { signal }) {
      refuseListed(url);
      const got = await youtubeTranscript(String(url || ''), { signal });
      return { items: [item({ ...got, url: got.url || String(url || '') })], cursor: null };
    },
  },
};
