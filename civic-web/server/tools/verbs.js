// The verbs: the few stable tools the model reaches for, whatever the sources behind them.
//
// THE WORDS IN THIS FILE ARE READ BY THE MODEL. They are the operator's text, like the prompts: CIVIC's
// code adds nothing to them but the list of sources when a verb has more than one. A verb is what the
// model can ask for (read a page, search the law); a source is who answers (the web, CourtListener,
// LexisNexis). Sources register for verbs in server/tools/adapters; the registry lists a verb only when
// a source can answer it, and adds a `source` parameter, naming the sources with each one's own line,
// only when more than one can. `npm run tools` prints the whole table as the model sees it.
//
// A verb is a stable interface: a hundred vendors behind a dozen verbs add nothing to what the model
// reads per claim. Adding a vendor never adds a verb; adding a domain (law, filings) adds one or two.
export const VERBS = {
  read_page: {
    description: 'Read a web page, article or PDF at its address, as CIVIC reads it: the whole text, with the page\'s title, its site and its publication date. When the site keeps the page from CIVIC (a refusal, a paywall, a page built in the browser, no answer), the tool returns that site\'s answer instead of the text.',
    params: { url: { type: 'string', description: 'The page\'s full address (https://…).' } },
    required: ['url'],
  },
  get_transcript: {
    description: 'Read the transcript of a video at its address (YouTube), with the video\'s title and channel. When YouTube keeps the captions from CIVIC, the tool returns that answer instead of the text.',
    params: { url: { type: 'string', description: 'The video\'s full address.' } },
    required: ['url'],
  },
};
