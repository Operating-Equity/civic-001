// What the two requests to OpenAI carry for tools, what a listing on Fireworks carries, and how a tool
// call in the stream becomes a step of the trail the page shows.
//
// Web search is always there for OpenAI (both prompts were tested with it), with one option alone: the sites the
// operator keeps out of the research (server/sites.js, 25 October), when a list is set. The gateway is there when the
// operator has set its address and pass: one entry in the same `tools` list, no other parameter. The
// prompts are not touched: a tool is reachable because it is declared here, and whether the model
// calls it is the model's decision. `npm run verify` inspects this entry and fails on any other key.
//
// Fireworks has no web search of its own, so a listing there names the gateway alone, at the service's
// own address (config.js), through a door opened for that listing (doors.js): the model searches, reads a
// page or a transcript through FactEngine, as it searched through OpenAI. Fireworks forwards no header of
// the entry's, so its entry carries none and no pass goes to Fireworks.
import { config } from '../config.js';
import { blockedSites, sitesState } from '../sites.js';

export const toolsOn = () => Boolean(config.toolsUrl && config.toolsPass);

/** The listing on Fireworks can reach the tool server: it has a public address (config.js). */
export const gatewayOn = () => Boolean(config.gatewayUrl);

/** The one entry that names FactEngine's tool server in a request: with the pass in its headers (OpenAI's), or with
 *  the door in its address and no header at all (Fireworks'). */
function gatewayEntry(url, pass = '') {
  return {
    type: 'mcp',
    server_label: 'civic',
    server_url: url,
    ...(pass ? { headers: { authorization: `Bearer ${pass}` } } : {}),
    require_approval: 'never', // the model's call is answered at once; there is no one to ask
  };
}

export function requestTools() {
  // The operator's list, when one is set: OpenAI's search returns no page of those sites or their subdomains. Without
  // one, the entry is the bare search, as it always was.
  const sites = blockedSites();
  const tools = [sites.length ? { type: 'web_search', filters: { blocked_domains: sites } } : { type: 'web_search' }];
  if (toolsOn()) tools.push(gatewayEntry(config.toolsUrl, config.toolsPass));
  return tools;
}

/** What a fact-check asks OpenAI to add to its reply: with anything kept out of the research set, every address each
 *  search consulted, not only those the entry cites, so what it took of them can be counted (server/sites.js); with
 *  nothing set, nothing. */
export const requestInclude = () => (sitesState() ? ['web_search_call.action.sources'] : null);

/** A listing on Fireworks: the tool server alone, at the address of the door opened for this listing; with no public
 *  address (or no door), nothing (said on /check). */
export function gatewayTools(door) {
  return gatewayOn() && door ? [gatewayEntry(`${config.gatewayUrl}/t/${door}`)] : [];
}

/** What a step of the research did, in a plain word for the reader's work log, never naming the tool that did it:
 *  'search', 'open' or 'find' (a web search's own actions), 'read' (a page read through FactEngine's reader) or
 *  'transcript'. */
export function verbOf(step) {
  if (step?.kind === 'tool') return step.name === 'search_web' ? 'search' : step.name === 'get_transcript' ? 'transcript' : 'read';
  return step?.kind === 'open_page' ? 'open' : step?.kind === 'find_in_page' ? 'find' : 'search';
}

/** The trail step for an `mcp_call` output item: the verb, what it was asked, and how it ended. Fireworks may
 *  carry the call's name and arguments in an `mcp` object of the item rather than on it. */
export function toolStep(item) {
  const call = item.mcp && typeof item.mcp === 'object' ? { ...item.mcp, ...Object.fromEntries(Object.entries(item).filter(([, v]) => v != null && v !== '')) } : item;
  let args = {};
  const raw = call.arguments;
  if (raw && typeof raw === 'object') args = raw;
  else { try { args = JSON.parse(raw || '{}') || {}; } catch { /* the arguments as sent; nothing to read */ } }
  const error = call.error == null ? null : typeof call.error === 'string' ? call.error : call.error.message || call.error.code || 'failed';
  return {
    kind: 'tool',
    verb: verbOf({ kind: 'tool', name: call.name }),
    name: call.name || null,
    source: args.source || null,
    url: args.url || null,
    query: args.query || null,
    status: error ? 'failed' : call.status || 'completed',
    error,
  };
}

/** How many of the trail's steps were web searches (a tool call is priced on its own ledger line). */
export const searchCount = (trail) => trail.filter((s) => s.kind !== 'tool').length;
