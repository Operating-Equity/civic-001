// The guard's stand-in for the search source: a search service answering in the shape of Exa's /search (the one the
// copies door was tested against), and the probe that proves the adapter reads it through the gateway.
export default {
  mount(app) {
    app.post('/search-standin', (req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* the stand-in answers whatever it was asked */ }
        res.json({
          requestId: 'standin',
          results: [{ url: 'https://www.example.org/nile', title: 'The Nile, measured', publishedDate: '2026-09-01T00:00:00.000Z', author: '', text: `${body.query}: The Nile is about 6,650 kilometres long.` }],
          costDollars: { total: 0.005 },
        });
      });
    });
  },
  settings: (base) => ({ CIVIC_SEARCH_URL: `${base}/search-standin`, CIVIC_SEARCH_KEY: 'standin-search-key-1c7e' }),
  probes: () => [
    {
      verb: 'search_web', args: { query: 'length of the Nile' },
      expect: (out) => out.items?.length === 1 && out.items[0].kind === 'page' && out.items[0].title === 'The Nile, measured' && out.items[0].site === 'example.org' && out.items[0].date === '2026-09-01' && /^length of the Nile: The Nile is about 6,650 kilometres long\./.test(out.items[0].text) && out.items[0].source === 'the web\'s search service' && out.usd === undefined,
    },
  ],
};
