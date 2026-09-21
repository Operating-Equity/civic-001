// What the two requests to OpenAI carry for tools, and how a tool call in the stream becomes a step
// of the trail the page shows.
//
// Web search is always there (both prompts were tested with it). The gateway is there when the
// operator has set its address and pass: one entry in the same `tools` list, no other parameter. The
// prompts are not touched: a tool is reachable because it is declared here, and whether the model
// calls it is the model's decision. `npm run verify` inspects this entry and fails on any other key.
import { config } from '../config.js';

export const toolsOn = () => Boolean(config.toolsUrl && config.toolsPass);

export function requestTools() {
  const tools = [{ type: 'web_search' }];
  if (toolsOn()) {
    tools.push({
      type: 'mcp',
      server_label: 'civic',
      server_url: config.toolsUrl,
      headers: { authorization: `Bearer ${config.toolsPass}` },
      require_approval: 'never', // the model's call is answered at once; there is no one to ask
    });
  }
  return tools;
}

/** The trail step for an `mcp_call` output item: the verb, what it was asked, and how it ended. */
export function toolStep(item) {
  let args = {};
  try { args = JSON.parse(item.arguments || '{}') || {}; } catch { /* the arguments as sent; nothing to read */ }
  const error = item.error == null ? null : typeof item.error === 'string' ? item.error : item.error.message || item.error.code || 'failed';
  return {
    kind: 'tool',
    name: item.name || null,
    source: args.source || null,
    url: args.url || null,
    query: args.query || null,
    status: error ? 'failed' : item.status || 'completed',
    error,
  };
}

/** How many of the trail's steps were web searches (a tool call is priced on its own ledger line). */
export const searchCount = (trail) => trail.filter((s) => s.kind !== 'tool').length;
