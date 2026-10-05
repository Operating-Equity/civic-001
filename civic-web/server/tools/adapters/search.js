// Source: the web's search service, the one FactEngine already uses to find a refused article elsewhere
// (server/copies.js), asked in the model's own words. On when the service's address and key are both set; the key
// stays in this process, carried as copies.js carries it. Each call is priced at the service's own figure for it.
// A model whose provider has no web search of its own (the listing on Fireworks) searches through this.
import { searchWeb } from '../../copies.js';
import { ToolRefusal } from '../contract.js';

// THE MODEL READS THE BLURB: the operator's text.
const BLURB = 'a web search engine: the pages found for a query, each with its text';

const siteOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; } };

export default {
  id: 'search',
  name: 'the web\'s search service',
  blurb: BLURB,
  settings: {
    url: { env: 'CIVIC_SEARCH_URL' },
    key: { env: 'CIVIC_SEARCH_KEY' },
  },
  verbs: {
    async search_web({ query }, { signal }) {
      const q = String(query || '').trim();
      if (!q) throw new ToolRefusal('Say what to search for.', 'search_empty');
      const got = await searchWeb(q, { signal });
      if (got.note) throw new ToolRefusal(`The search did not answer: ${got.note}.`, 'search_failed', got.note);
      const items = got.results.map((r) => ({
        kind: 'page',
        title: r?.title || null,
        site: siteOf(r?.url),
        url: r?.url || null,
        date: r?.publishedDate ? String(r.publishedDate).slice(0, 10) : null,
        text: String(r?.text || ''),
      }));
      return { items, cursor: null, usd: got.usd };
    },
  },
};
