// The gateway: CIVIC's tools at one address, in the open standard (MCP over Streamable HTTP), for the
// model to reach through OpenAI's remote-tool door. Stateless: every request is its own short-lived
// server over the registry, so nothing is kept between calls and the address can move to its own
// service later without a change here.
//
// The only door is the pass (CIVIC_TOOLS_PASS), carried by OpenAI as `Authorization: Bearer …`. It is
// CIVIC's own credential, not a vendor's: every vendor key stays in this process, in the adapters'
// settings, and the pass appears in no record, no message and no page. Without a pass set, nothing
// answers here at all.
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const same = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function mountGateway(app, { path = '/mcp', registry, pass, name = 'civic', version = '0' }) {
  app.all(path, async (req, res) => {
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!pass || !same(given, pass)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const server = new Server({ name, version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.table }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const signal = extra?.signal ? AbortSignal.any([ac.signal, extra.signal]) : ac.signal;
      return registry.call(request.params.name, request.params.arguments || {}, { signal });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      console.error('[tools] gateway request failed:', err?.message || err);
    }
  });
}
