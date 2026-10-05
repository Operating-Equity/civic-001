// What the two requests to OpenAI carry for tools, what a listing on Fireworks carries, and how a tool
// call in the stream becomes a step of the trail the page shows.
//
// Web search is always there for OpenAI (both prompts were tested with it). The gateway is there when the
// operator has set its address and pass: one entry in the same `tools` list, no other parameter. The
// prompts are not touched: a tool is reachable because it is declared here, and whether the model
// calls it is the model's decision. `npm run verify` inspects this entry and fails on any other key.
//
// Fireworks has no web search of its own, so a listing there names the gateway alone, at the service's
// own address with a pass derived from its secret unless the two settings say otherwise (config.js): the
// model searches, reads a page or a transcript through FactEngine, as it searched through OpenAI.
import { config } from '../config.js';

export const toolsOn = () => Boolean(config.toolsUrl && config.toolsPass);

/** The one entry that names FactEngine's tool server in a request. */
function gatewayEntry(url, pass) {
  return {
    type: 'mcp',
    server_label: 'civic',
    server_url: url,
    headers: { authorization: `Bearer ${pass}` },
    require_approval: 'never', // the model's call is answered at once; there is no one to ask
  };
}

export function requestTools() {
  const tools = [{ type: 'web_search' }];
  if (toolsOn()) tools.push(gatewayEntry(config.toolsUrl, config.toolsPass));
  return tools;
}

/** A listing on Fireworks: the tool server alone, when it has an address and a pass; else nothing (said on /check). */
export function gatewayTools() {
  return config.gatewayUrl && config.gatewayPass ? [gatewayEntry(config.gatewayUrl, config.gatewayPass)] : [];
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
