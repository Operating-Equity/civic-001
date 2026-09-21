// The guard's stand-in for the web source: a page to read, and the probes that prove the adapter reads
// it through the gateway. The stand-in YouTube (a watch page, the player API, a caption file) is the
// guard's own, shared with the link checks; `settings` points the reader at it.
const PROSE = 'The Nile is about 6,650 kilometres long and flows north to the Mediterranean. ';

export default {
  mount(app) {
    app.get('/tool-page', (req, res) => {
      res.type('html').send(`<html><head><title>A page of river facts</title><meta property="og:site_name" content="The Daily Stand-in"></head><body><article><p>${PROSE.repeat(8)}</p></article></body></html>`);
    });
  },
  settings: (base) => ({ CIVIC_YOUTUBE_BASE: base }),
  probes: (base) => [
    {
      verb: 'read_page', args: { url: `${base}/tool-page` },
      expect: (out) => out.items?.length === 1 && out.items[0].kind === 'page' && out.items[0].title === 'A page of river facts' && out.items[0].site === 'The Daily Stand-in' && out.items[0].text.includes('The Nile is about 6,650 kilometres long') && out.items[0].source === 'the web' && typeof out.items[0].retrievedAt === 'string',
    },
    {
      verb: 'read_page', args: { url: `${base}/refuse` }, refused: true,
      expect: (text) => /does not let CIVIC read its pages from here/.test(text),
    },
    {
      verb: 'get_transcript', args: { url: 'https://www.youtube.com/watch?v=vid1' },
      expect: (out) => out.items?.length === 1 && out.items[0].kind === 'transcript' && out.items[0].title === 'A talk on water' && /Water boils at 100 degrees Celsius/.test(out.items[0].text),
    },
  ],
};
