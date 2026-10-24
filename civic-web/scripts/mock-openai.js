// Development-only stand-in for api.openai.com. Emulates just enough of the Responses API
// (streaming) and the Images API for the CIVIC page to be exercised end to end without a key.
//
//   npm run mock-openai            # listens on :3999
//   OPENAI_BASE_URL=http://localhost:3999/v1 npm start
//
// Keys starting with "sk-bad" are rejected with 401 so the invalid-key path can be tested.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOCK_PORT || 3999);
const SPEED = Number(process.env.MOCK_SPEED || 1); // >1 = slower, <1 = faster
const app = express();
app.use(express.json({ limit: '256mb' }));

// When MOCK_RECORD is set, every request body is appended there so a verifier can inspect what
// the server actually sent (scripts/verify-ceiling.mjs).
const recordRequest = (req, body) => {
  if (process.env.MOCK_RECORD) fs.appendFileSync(process.env.MOCK_RECORD, JSON.stringify({ ts: Date.now(), path: req.path, auth: req.get('authorization') || '', body }) + '\n');
};
app.use((req, res, next) => {
  // A multipart body (the image edit) is recorded by its own route, once parsed.
  if (req.method === 'POST' && !req.is('multipart/form-data')) recordRequest(req, req.body);
  next();
});
// Every request to the DeepSeek stand-in (below) is recorded with its method, its key and the names of its
// headers, before any check of the key: the guard proves that nothing reaches DeepSeek without DeepSeek's key,
// and that none of OpenAI's settings (organisation, project, custom headers) travels with it.
app.use('/deepseek', (req, res, next) => {
  if (process.env.MOCK_RECORD) fs.appendFileSync(process.env.MOCK_RECORD, JSON.stringify({ ts: Date.now(), deepseek: true, method: req.method, path: req.originalUrl.split('?')[0], auth: req.get('authorization') || '', headers: Object.keys(req.headers) }) + '\n');
  next();
});
// The same record for every request to the Fireworks stand-in (below), for the same proofs.
app.use('/fireworks', (req, res, next) => {
  if (process.env.MOCK_RECORD) fs.appendFileSync(process.env.MOCK_RECORD, JSON.stringify({ ts: Date.now(), fireworks: true, method: req.method, path: req.originalUrl.split('?')[0], auth: req.get('authorization') || '', headers: Object.keys(req.headers) }) + '\n');
  next();
});
// And for the Gemini stand-in (below), whose key travels in x-goog-api-key: the key itself is recorded too, so the guard
// proves that only the operator's Gemini key reaches Google, and nothing of OpenAI's or DeepSeek's.
app.use('/gemini', (req, res, next) => {
  if (process.env.MOCK_RECORD) fs.appendFileSync(process.env.MOCK_RECORD, JSON.stringify({ ts: Date.now(), gemini: true, method: req.method, path: req.originalUrl.split('?')[0], key: req.get('x-goog-api-key') || '', auth: req.get('authorization') || '', headers: Object.keys(req.headers) }) + '\n');
  next();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
// The calls the stand-in makes to CIVIC's gateway when a request names it (see the Responses route).
const TOOL_CALLS = (() => { try { return JSON.parse(process.env.MOCK_TOOL_CALLS || '[]'); } catch { return []; } })();
const recordMcp = (entry) => { if (process.env.MOCK_RECORD) fs.appendFileSync(process.env.MOCK_RECORD, JSON.stringify({ ts: Date.now(), path: '/mcp-client', ...entry }) + '\n'); };

app.use((req, res, next) => {
  if (req.path.startsWith('/gemini/')) return next();   // Google's key comes in its own header; its routes check it
  const auth = req.get('authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '');
  if (!key) return res.status(401).json({ error: { message: 'Missing API key', type: 'invalid_request_error', code: 'missing_key' } });
  if (key.startsWith('sk-bad')) return res.status(401).json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
  next();
});

const KNOWN_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-image-2.5-flare', 'gpt-image-1-mini']);
const modelError = (res, model) => res.status(404).json({ error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } });

// ---- Responses API -----------------------------------------------------------------------

function sse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  return (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function inputText(body) {
  const input = body.input;
  if (typeof input === 'string') return input;
  return (input || []).flatMap((m) => (m.content || []).map((c) => c.text || '')).join('\n');
}
/** The last message: the prompt, when a source travels ahead of it. */
function lastText(body) {
  const input = body.input;
  if (typeof input === 'string') return input;
  const last = (input || [])[(input || []).length - 1];
  return ((last && last.content) || []).map((c) => c.text || '').join('\n');
}

// Reading a model's description, which is what the self-check uses to prove a key may use a model.
// It costs no tokens, so the mock answers it the same way the real API does.
app.get('/v1/models/:id', (req, res) => {
  const id = req.params.id;
  if (!KNOWN_MODELS.has(id)) return modelError(res, id);
  res.json({ id, object: 'model', created: 1700000000, owned_by: 'mock' });
});

app.post('/v1/responses', async (req, res) => {
  const body = req.body || {};
  if (!KNOWN_MODELS.has(body.model)) return modelError(res, body.model);
  const ordinal = ++requestOrdinal;
  const text = inputText(body);
  // Which of the requests this is. The guard tells the stand-in how a determination begins
  // (MOCK_EVAL_MARK, derived at run time from whatever evaluation prompt is installed, never
  // written down here); by hand, a message that opens "Prompt =" is taken to be one.
  const prompt = lastText(body);
  const isEvaluation = process.env.MOCK_EVAL_MARK ? prompt.includes(process.env.MOCK_EVAL_MARK) : /^\s*Prompt\s*=/.test(prompt);
  const isArtDirection = /art director/i.test(String(body.instructions || ''));
  const kind = isEvaluation ? 'determination' : isArtDirection ? 'art' : 'extraction';
  // The limiter decides first, as the real one does; a refusal carries its figures and its headers.
  const entry = admitOrRefuse(res, body.model, kind, LIMIT.has(ordinal));
  if (!entry) return;
  res.on('close', () => { entry.endedAt = Date.now(); stats.inFlight = Math.max(0, stats.inFlight - 1); });

  // Exercise the case where a PARAMETER is unsupported: the server must surface this as an error,
  // never silently swap in a different, weaker model.
  // A determination whose claim carries this text is refused as a bad request (the guard's way to make one test fail
  // while the others pass, so the hold of the one that failed can be seen released). Only the claim's own message is
  // read: the source travels ahead of it in every determination and must not fail them all.
  if (process.env.MOCK_EVAL_FAIL_TEXT && isEvaluation && prompt.includes(process.env.MOCK_EVAL_FAIL_TEXT)) {
    return res.status(400).json({ error: { message: process.env.MOCK_EVAL_FAIL_MESSAGE || 'The stand-in refuses this claim on purpose.', type: 'invalid_request_error', param: 'input', code: 'invalid_value' } });
  }
  if (process.env.MOCK_BAD_EFFORT && body.reasoning?.effort === process.env.MOCK_BAD_EFFORT) {
    return res.status(400).json({ error: { message: `Unsupported value: 'reasoning.effort' does not support '${body.reasoning.effort}' with this model.`, type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_value' } });
  }

  // Exercise the server's fallback when an account cannot get reasoning summaries.
  if (process.env.MOCK_NO_SUMMARY && body.reasoning?.summary) {
    return res.status(400).json({ error: { message: 'Your organization must be verified to generate reasoning summaries.', type: 'invalid_request_error', code: 'unsupported_parameter' } });
  }

  // Non-streaming calls (the art-direction stage).
  if (body.stream === false) {
    await sleep(isArtDirection ? 900 : 400);
    const out = isArtDirection ? MOCK_BRIEF : 'ok';
    return res.json({
      id: 'resp_' + Math.random().toString(36).slice(2), status: 'completed', model: body.model, output_text: out,
      usage: { input_tokens: Math.round(text.length / 4), input_tokens_details: { cached_tokens: 0 }, output_tokens: Math.round(out.length / 4), output_tokens_details: { reasoning_tokens: 0 } },
    });
  }

  // MOCK_HEADERS_DELAY_MS holds the reply's headers back (a slow start) while their figures stay those of the
  // decision above, as the real limiter's do: the gate's reservations are proved against it.
  if (HEADERS_DELAY > 0) await sleep(HEADERS_DELAY);
  const send = sse(res);
  entry.headersAt = Date.now();
  const id = 'resp_' + Math.random().toString(36).slice(2);
  send({ type: 'response.created', response: { id, status: 'in_progress' } });

  let output;
  if (isEvaluation) {
    const claim = prompt.split('\n')[0].replace(/^\s*Prompt\s*=\s*/, '').trim();

    if (body.reasoning?.summary) {
      // With MOCK_INSPECTOR, the thinking names the inspector, as a real one may.
      const named = process.env.MOCK_INSPECTOR ? [`Working as ${inspectorName()} through the record.`] : [];
      for (const part of [...named, ...MOCK_REASONING]) {
        await sleep(300 + Math.random() * 700);
        for (const chunk of part.match(/[\s\S]{1,30}/g) || []) {
          send({ type: 'response.reasoning_summary_text.delta', delta: chunk, summary_index: 0 });
          await sleep(12);
        }
        send({ type: 'response.reasoning_summary_part.done', summary_index: 0 });
      }
    } else {
      await sleep(800 + Math.random() * 2500);
    }

    if (body.tools?.some((t) => t.type === 'web_search')) {
      const queries = pickQueries(claim);
      // MOCK_SEARCH_ACTIONS: the web search's own actions, in order (search, open_page, find_in_page); two searches unless set.
      const actions = String(process.env.MOCK_SEARCH_ACTIONS || 'search,search').split(',').map((a) => a.trim()).filter(Boolean);
      for (let k = 0; k < actions.length; k++) {
        const action = actions[k] === 'open_page' ? { type: 'open_page', url: MOCK_SOURCES[1].url }
          : actions[k] === 'find_in_page' ? { type: 'find_in_page', url: MOCK_SOURCES[1].url, pattern: '330' }
            : { type: 'search', query: queries[k % queries.length] };
        send({ type: 'response.web_search_call.in_progress', item_id: `ws_${k}` });
        send({ type: 'response.web_search_call.searching', item_id: `ws_${k}` });
        await sleep(400 + Math.random() * 900);
        send({ type: 'response.web_search_call.completed', item_id: `ws_${k}` });
        send({ type: 'response.output_item.done', output_index: k, item: { id: `ws_${k}`, type: 'web_search_call', status: 'completed', action } });
      }
    }
    // CIVIC's own tools: with an `mcp` entry in the request, the stand-in does what OpenAI's servers do,
    // as a client of the gateway at the entry's address with the entry's headers (playMcp, below).
    const mcp = body.tools?.find((t) => t.type === 'mcp');
    if (mcp && TOOL_CALLS.length) await playMcp(mcp, send, TOOL_CALLS);
    // The response's own later call, after the search: its whole context is charged to the bucket
    // now, as OpenAI charges it. When the bucket lacks it, OpenAI does not turn anything back at
    // the door (the door is long passed); it ends the response with its figures in an error event.
    // MOCK_CONTINUATION is that charge for every determination (0: none); MOCK_STREAM_RATE_LIMIT_REQUESTS
    // drains the bucket before those requests reach this point, so they end this way and fit again
    // 700 ms on, and MOCK_STREAM_REQUESTED is the figure such a planted refusal cites and charges.
    const planted = STREAM_LIMIT.has(ordinal);
    if (CONTINUATION > 0 || planted) {
      const need = planted && STREAM_REQUESTED > 0 ? STREAM_REQUESTED : CONTINUATION > 0 ? CONTINUATION : RESERVE;
      settle(TOKENS);
      if (planted) TOKENS.level = Math.max(0, need - 700 * TOKENS.limit / WINDOW);
      if (TOKENS.level < need) {
        stats.refusedInStream++;
        const used = TOKENS.limit - Math.floor(TOKENS.level);
        const wait = (need - TOKENS.level) * WINDOW / TOKENS.limit;
        send({ type: 'response.failed', sequence_number: 99, response: { id, object: 'response', status: 'failed', model: body.model, error: { code: 'rate_limit_exceeded', message: `Rate limit reached for ${body.model} in organization org-mock0000000000000000000 on tokens per min (TPM): Limit ${TOKENS.limit}, Used ${used}, Requested ${need}. Please try again in ${fmtWait(wait)}. Visit https://platform.openai.com/account/rate-limits to learn more.` } } });
        res.end();
        return;
      }
      TOKENS.level -= need;
    }
    const hold = Number(process.env.MOCK_EVAL_HOLD_MS || 0);
    if (hold) await sleep(hold);
    output = mockEntry(claim);
  } else {
    // Extraction at a high reasoning effort is a long silence followed by a burst of text. The real
    // API behaves that way and the page has to stay alive through it, so the stand-in can too:
    // MOCK_EXTRACT_THINK_MS sets how long the model thinks before writing its first claim.
    const think = Number(process.env.MOCK_EXTRACT_THINK_MS || 500);
    if (body.reasoning?.summary && think > 1500) {
      const parts = ['Reading the document through once to see what kind of claims it carries.',
        'Separating the empirical propositions from the rhetoric around them.',
        'Carrying forward the speaker, the date and the units so each claim stands on its own.'];
      const per = Math.floor(think / parts.length);
      for (const part of parts) {
        for (const chunk of part.match(/[\s\S]{1,30}/g) || []) {
          send({ type: 'response.reasoning_summary_text.delta', delta: chunk, summary_index: 0 });
          await sleep(12);
        }
        send({ type: 'response.reasoning_summary_part.done', summary_index: 0 });
        await sleep(Math.max(0, per - part.length * 12));
      }
    } else {
      await sleep(think);
    }
    // When the prompt is sent around the source as one message, the stand-in reads the source
    // from the last paragraph, so no line of a prompt is ever echoed back as a claim.
    output = mockClaims(documentOf(body, text));
  }

  const chunks = output.match(/[\s\S]{1,28}/g) || [];
  for (const [k, delta] of chunks.entries()) {
    if (res.writableEnded || res.destroyed) return;
    if (k === 3 && DROP.has(ordinal)) { res.socket.destroy(); return; }   // see MOCK_DROP_REQUESTS
    if (k === 3 && END_EARLY.has(ordinal)) { res.end(); return; }          // see MOCK_END_EARLY_REQUESTS
    if (k === 3 && ERROR_EVENT.has(ordinal)) { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: 'The server is overloaded.', code: 'server_error' } })}\n\n`); res.end(); return; }
    send({ type: 'response.output_text.delta', delta });
    await sleep(isEvaluation ? 18 : 25);
  }
  if (isEvaluation && body.tools?.some((t) => t.type === 'web_search')) {
    for (const src of MOCK_SOURCES) {
      send({ type: 'response.output_text.annotation.added', item_id: 'msg_1', output_index: 0, content_index: 0, annotation_index: 0, annotation: { type: 'url_citation', url: src.url, title: src.title, start_index: 0, end_index: 0 } });
    }
  }
  send({ type: 'response.output_text.done', text: output });
  send({
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      model: body.model,
      output_text: output,
      usage: {
        input_tokens: Math.round(text.length / 4),
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: Math.round(output.length / 4) + (isEvaluation ? 6000 : 0),
        output_tokens_details: { reasoning_tokens: isEvaluation ? 6000 : 0 },
        total_tokens: 0,
      },
    },
  });
  res.end();
});

// ---- Images API --------------------------------------------------------------------------

const imageB64 = fs.existsSync(path.join(here, 'mock-image.b64')) ? fs.readFileSync(path.join(here, 'mock-image.b64'), 'utf8').trim() : null;

// The edit endpoint, as the server uses it: the CIVIC photograph goes with every request as the
// style reference, so the body is multipart. Recorded here (the image as its name, type and byte
// count, never its bytes) for the guard. MOCK_IMAGE_REJECT_KNOBS=1 refuses the newer knobs the way
// an older image model does, so the server's minimal retry can be watched.
const form = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });
const badRequest = (res, message, param, code = null) => res.status(400).json({ error: { message, type: 'invalid_request_error', param, code } });
app.post('/v1/images/edits', form.any(), async (req, res) => {
  const fields = req.body || {};
  const part = (req.files || []).find((f) => f.fieldname === 'image' || f.fieldname === 'image[]');
  recordRequest(req, { ...fields, image: part ? { name: part.originalname, type: part.mimetype, bytes: part.size } : null });
  if (!part) return badRequest(res, "Missing required parameter: 'image'.", 'image');
  if (!fields.prompt) return badRequest(res, "Missing required parameter: 'prompt'.", 'prompt');
  if (!KNOWN_MODELS.has(fields.model)) return modelError(res, fields.model);
  if (process.env.MOCK_IMAGE_REJECT_KNOBS === '1' && 'output_compression' in fields) return badRequest(res, "Unknown parameter: 'output_compression'.", 'output_compression', 'unknown_parameter');
  await sleep(2500 + Math.random() * 2500);
  // Shaped like the real reply: no model field; usage figures are the stand-in's, image tokens for the reference.
  res.json({ created: Math.floor(Date.now() / 1000), output_format: 'jpeg', quality: fields.quality || 'auto', size: fields.size || '1024x1024', usage: { input_tokens: 1100, input_tokens_details: { image_tokens: 1000, text_tokens: 100 }, output_tokens: 4160, total_tokens: 5260 }, data: [{ b64_json: imageB64 }] });
});

app.get('/v1/mock/stats', (req, res) => res.json({ ...stats, tokens: { limit: TOKENS.limit, level: Math.floor(levelOf(TOKENS)) }, requests: REQUESTS ? { limit: REQUESTS.limit, level: Math.floor(levelOf(REQUESTS)) } : null, windowMs: WINDOW, costs: COSTS }));

// ---- A provider's servers as a client of FactEngine's tool server ----------------------------
// What OpenAI's servers (and Fireworks') do with an `mcp` entry: as a client of the gateway at the entry's address,
// list the tools, make the calls given (JSON: [{ name, arguments }]) and stream each as that provider does. OpenAI's
// style: the entry's headers sent, mcp_list_tools and mcp_call items with the call's name and arguments on the item.
// Fireworks' style: no header of the entry's sent (its servers forward none: ten calls to /mcp without the pass in the
// first live listing, 5 October), mcp_call items carrying the call inside an `mcp` object, a tool_output item after
// each. What the gateway answered is recorded (MOCK_RECORD) for the guard, with the address it was asked at.
async function playMcp(mcp, send, calls, { style = 'openai' } = {}) {
  const forwarded = style === 'fireworks' ? {} : (mcp.headers || {});
  const rpc = async (method, params, rpcId) => {
    const r = await fetch(mcp.server_url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...forwarded }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }) });
    const raw = await r.text();
    let json = null; try { json = JSON.parse(raw); } catch {}
    return { status: r.status, json };
  };
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mock-openai', version: '1' } }, 1);
  const list = await rpc('tools/list', {}, 2);
  const tools = list.json?.result?.tools || [];
  if (style === 'openai') {
    send({ type: 'response.output_item.added', output_index: 10, item: { id: 'mcpl_1', type: 'mcp_list_tools', server_label: mcp.server_label, tools: [] } });
    send({ type: 'response.mcp_list_tools.in_progress', item_id: 'mcpl_1', output_index: 10 });
    send({ type: 'response.mcp_list_tools.completed', item_id: 'mcpl_1', output_index: 10 });
    send({ type: 'response.output_item.done', output_index: 10, item: { id: 'mcpl_1', type: 'mcp_list_tools', server_label: mcp.server_label, tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } });
  }
  recordMcp({ step: 'list', style, url: mcp.server_url, headers: Object.keys(forwarded), initialize: init.status, status: list.status, names: tools.map((t) => t.name), tools });
  for (const [k, c] of calls.entries()) {
    const itemId = `mcp_${k}`, index = 20 + k, args = JSON.stringify(c.arguments || {});
    if (style === 'openai') {
      send({ type: 'response.output_item.added', output_index: index, item: { id: itemId, type: 'mcp_call', name: c.name, arguments: '', server_label: mcp.server_label, status: 'in_progress' } });
      send({ type: 'response.mcp_call.in_progress', item_id: itemId, output_index: index });
      send({ type: 'response.mcp_call_arguments.delta', item_id: itemId, output_index: index, delta: args });
      send({ type: 'response.mcp_call_arguments.done', item_id: itemId, output_index: index, arguments: args });
    } else {
      send({ type: 'response.output_item.added', output_index: index, item: { id: itemId, type: 'mcp_call', status: 'in_progress', mcp: { name: c.name, arguments: args, server_label: mcp.server_label } } });
    }
    const r = await rpc('tools/call', { name: c.name, arguments: c.arguments || {} }, 3 + k);
    const result = r.json?.result;
    const failed = !result || Boolean(result.isError);
    const outText = (result?.content || []).map((x) => x.text || '').join('');
    if (style === 'openai') {
      send({ type: failed ? 'response.mcp_call.failed' : 'response.mcp_call.completed', item_id: itemId, output_index: index });
      send({ type: 'response.output_item.done', output_index: index, item: { id: itemId, type: 'mcp_call', name: c.name, arguments: args, server_label: mcp.server_label, status: failed ? 'failed' : 'completed', output: failed ? null : outText, error: failed ? { type: 'mcp_tool_execution_error', message: outText || `the gateway answered ${r.status}` } : null } });
    } else {
      send({ type: 'response.output_item.done', output_index: index, item: { id: itemId, type: 'mcp_call', name: null, arguments: null, status: failed ? 'incomplete' : 'completed', mcp: { name: c.name, arguments: args, server_label: mcp.server_label }, ...(failed ? { error: outText || `the gateway answered ${r.status}` } : {}) } });
      send({ type: 'response.output_item.done', output_index: index + 50, item: { type: 'tool_output', tool_call_id: itemId, output: outText } });
    }
    recordMcp({ step: 'call', style, url: mcp.server_url, headers: Object.keys(forwarded), call: c, status: r.status, failed, output: outText.slice(0, 6000) });
  }
}

// ---- DeepSeek ----------------------------------------------------------------------------
// The listing on DeepSeek (server/deepseek.js) talks to this when CIVIC_DEEPSEEK_BASE_URL points here
// (http://localhost:<port>/deepseek). It speaks DeepSeek's dialect of the Responses API as its pages describe it:
// a chain of thought streamed as reasoning_text (carrying a marker the guard looks for wherever it must not be),
// no reasoning summary, built-in tools (web search among them) ignored, usage in OpenAI's shape, no x-ratelimit
// headers, and its own refusals: 429 with no wait figure, 503 overloaded, 402 balance used up; keep-alive comments
// while queued, a stream closed with no event at all (what DeepSeek does to a request not started inside ten minutes),
// and an `error` event in the middle of a stream. Each knob lists the request ordinals it applies to (1-based).
//
// The operator's trial (server/evaluate.js) determines here too, with FactEngine's own tools offered as functions. The
// stand-in plays three rounds, as a model that searches, reads a page and then writes would: round 1 calls search_web;
// round 2, with that call's answer in its input, calls read_page (MOCK_DS_READ_URL, or the first page the search
// found); round 3 writes the entry. A round whose input carries a call without the reasoning that came with it, or
// without the call's answer, is refused with a 400, as DeepSeek refuses it.
const DS_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
const DS_EFFORTS = new Set(['none', 'low', 'high', 'max', 'minimal', 'medium', 'xhigh']);
const dsSet = (name) => new Set(String(process.env[name] || '').split(',').map(Number).filter(Boolean));
const DS_429 = dsSet('MOCK_DS_429'), DS_503 = dsSet('MOCK_DS_503'), DS_402 = dsSet('MOCK_DS_402'), DS_CLOSE = dsSet('MOCK_DS_CLOSE'), DS_ERROR_EVENT = dsSet('MOCK_DS_ERROR_EVENT');
const DS_KEEPALIVE_MS = Number(process.env.MOCK_DS_KEEPALIVE_MS || 0);
const DS_COT = 'DSCOT-7f3a';   // the chain of thought's marker: never on a page, a replay, a ledger line or a failure record
const dsStats = { requests: 0, streams: 0, inFlight: 0, maxInFlight: 0, rounds: 0, refusedRounds: 0, lastTools: null, lastToolTypes: null, lastInput: null, rankRequests: 0, lastRankBody: null };
let dsOrdinal = 0;

app.get('/deepseek/models', (req, res) => res.json({ object: 'list', data: DS_MODELS.map((id) => ({ id, object: 'model', owned_by: 'deepseek' })) }));
app.get('/deepseek/user/balance', (req, res) => res.json({
  is_available: process.env.MOCK_DS_BALANCE_EMPTY !== '1',
  balance_infos: [{ currency: 'USD', total_balance: process.env.MOCK_DS_BALANCE_EMPTY === '1' ? '0.00' : '12.34', granted_balance: '0.00', topped_up_balance: process.env.MOCK_DS_BALANCE_EMPTY === '1' ? '0.00' : '12.34' }],
}));
app.get('/deepseek/mock/stats', (req, res) => res.json(dsStats));

app.post('/deepseek/responses', async (req, res) => {
  const body = req.body || {};
  const ordinal = ++dsOrdinal;
  dsStats.requests = ordinal;
  if (!DS_MODELS.includes(body.model)) return res.status(400).json({ error: { message: 'Model Not Exist', type: 'invalid_request_error' } });
  if (body.reasoning?.effort !== undefined && !DS_EFFORTS.has(body.reasoning.effort)) return res.status(400).json({ error: { message: `Invalid reasoning effort: ${body.reasoning.effort}`, type: 'invalid_request_error' } });
  if (DS_402.has(ordinal)) return res.status(402).json({ error: { message: 'Insufficient Balance', type: 'unknown_error' } });
  if (DS_429.has(ordinal)) return res.status(429).json({ error: { message: 'Rate Limit Reached', type: 'rate_limit_reached' } });
  if (DS_503.has(ordinal)) return res.status(503).json({ error: { message: 'Server Overloaded', type: 'server_overloaded' } });
  // A determination (the operator's trial): the prompt is the last of the input's own messages; later rounds end with
  // the calls' answers. What the guard asks of each round's input is kept in the stats, never a text.
  const items = Array.isArray(body.input) ? body.input : [];
  const users = items.filter((m) => m && m.role === 'user');
  const promptText = users.length ? (users[users.length - 1].content || []).map((c) => c.text || '').join('\n') : '';
  const isEvaluation = process.env.MOCK_EVAL_MARK ? promptText.includes(process.env.MOCK_EVAL_MARK) : /^\s*Prompt\s*=/.test(promptText);
  // The second pass (server/rank.js): known by MOCK_RANK_MARK, a word of the guard's stand-in ranking prompt.
  const isRanking = Boolean(process.env.MOCK_RANK_MARK) && promptText.includes(process.env.MOCK_RANK_MARK);
  if (isRanking) { dsStats.rankRequests++; dsStats.lastRankBody = body; }
  if (isEvaluation) {
    const calls = items.filter((x) => x?.type === 'function_call');
    const answers = items.filter((x) => x?.type === 'function_call_output');
    const reasonings = items.filter((x) => x?.type === 'reasoning');
    dsStats.rounds++;
    dsStats.lastTools = (body.tools || []).filter((t) => t.type === 'function').map((t) => t.name);
    dsStats.lastToolTypes = (body.tools || []).map((t) => t.type);
    dsStats.lastInput = { items: items.length, users: users.length, calls: calls.length, answers: answers.length, reasonings: reasonings.length, keys: Object.keys(body).sort() };
    if (calls.length && (reasonings.length < calls.length || calls.some((c) => !answers.some((a) => a.call_id === c.call_id)))) {
      dsStats.refusedRounds++;
      return res.status(400).json({ error: { message: 'The reasoning_content and the tool results of earlier turns must be passed back in the input.', type: 'invalid_request_error' } });
    }
  }
  dsStats.streams++;
  dsStats.inFlight++;
  dsStats.maxInFlight = Math.max(dsStats.maxInFlight, dsStats.inFlight);
  res.on('close', () => { dsStats.inFlight = Math.max(0, dsStats.inFlight - 1); });
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  if (DS_KEEPALIVE_MS > 0) {
    const until = Date.now() + DS_KEEPALIVE_MS * SPEED;
    while (Date.now() < until && !res.destroyed) { res.write(': keep-alive\n\n'); await sleep(100); }
  }
  if (DS_CLOSE.has(ordinal)) { res.end(); return; }
  let seq = 0;
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: seq++ })}\n\n`);
  const id = 'resp_ds_' + Math.random().toString(36).slice(2);
  send({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', model: body.model } });
  if (isEvaluation) { await dsRound({ res, body, send, id, promptText, items, ordinal }); return; }
  if (isRanking) { await dsRank({ res, send, id, body, promptText, items, ordinal }); return; }
  send({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', status: 'in_progress', content: [] } });
  const thought = [`${DS_COT} reading the instructions and the document. `, 'Listing every empirical claim in order. ', `${DS_COT} done.`];
  for (const delta of thought) { send({ type: 'response.reasoning_text.delta', item_id: 'rs_1', output_index: 0, content_index: 0, delta }); await sleep(20); }
  send({ type: 'response.reasoning_text.done', item_id: 'rs_1', output_index: 0, content_index: 0, text: thought.join('') });
  send({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', status: 'completed', content: [{ type: 'reasoning_text', text: thought.join('') }], summary: [] } });
  if (DS_ERROR_EVENT.has(ordinal)) {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: 'Server Overloaded', code: 'server_overloaded' } })}\n\n`);
    res.end();
    return;
  }
  // DeepSeek ignores built-in tools, web search among them: nothing is searched, whatever the request says.
  const text = inputText(body);
  const output = mockClaims(documentOf(body, text));
  send({ type: 'response.output_item.added', output_index: 2, item: { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [] } });
  for (const delta of output.match(/[\s\S]{1,28}/g) || []) {
    if (res.writableEnded || res.destroyed) return;
    send({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 2, content_index: 0, delta });
    await sleep(10);
  }
  send({ type: 'response.output_text.done', item_id: 'msg_1', output_index: 2, content_index: 0, text: output });
  send({ type: 'response.output_item.done', output_index: 2, item: { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: output, annotations: [] }] } });
  send({
    type: 'response.completed',
    response: {
      id, object: 'response', status: 'completed', model: body.model, store: false, error: null, incomplete_details: null,
      usage: { input_tokens: Math.round(text.length / 4), input_tokens_details: { cached_tokens: 0 }, output_tokens: Math.round(output.length / 4) + 50, output_tokens_details: { reasoning_tokens: 50 }, total_tokens: 0 },
    },
  });
  res.end();
});

/**
 * The second pass on DeepSeek (server/rank.js): a summary, the headline and its kind, and the claims in an order of the
 * stand-in's own (the last listed first), with claim 2 set aside as not empirical. Each case the guard needs is asked
 * for by a mark in the document itself, so one stand-in serves them all:
 *   [rank:question] [rank:notemp-headline] [rank:none] [rank:invented]   the headline asked, set aside, missing, or not the page's own
 *   [rank:dup]       claim 1 says what the headline says          [rank:missing]  the last claim left out of both lists
 *   [rank:allnot]    every claim not empirical                    [rank:garbage]  an answer without its headings
 *   [rank:decor]     the headings in Markdown's decorations, and "1. 12" lines
 * MOCK_RANK_HOLD_MS holds the answer after the chain of thought, so the guard and the browser check can see the ranking under way.
 */
async function dsRank({ res, send, id, body, promptText, items }) {
  const users = items.filter((m) => m && m.role === 'user');
  const source = users.length > 1 ? (users[0].content || []).map((c) => c.text || '').join('\n') : '';
  const has = (mark) => source.includes(`[rank:${mark}]`);
  const given = (promptText.match(/^Title given: (.*)$/m) || [])[1] || '';
  const numbers = [...promptText.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  const thought = `${DS_COT} weighing what the document rests on. `;
  send({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_r', status: 'in_progress', content: [] } });
  send({ type: 'response.reasoning_text.delta', item_id: 'rs_r', output_index: 0, content_index: 0, delta: thought });
  send({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_r', status: 'completed', content: [{ type: 'reasoning_text', text: thought }], summary: [] } });
  const hold = Number(process.env.MOCK_RANK_HOLD_MS || 0);
  if (hold > 0) await sleep(hold);
  const title = given && given !== '(none given)' ? given.split(' | ')[0].trim() : '';
  let headline = title || 'NONE';
  let kind = title ? 'EMPIRICAL' : 'NONE';
  if (has('question')) kind = 'QUESTION';
  if (has('notemp-headline')) kind = 'NOT EMPIRICAL';
  if (has('none')) { headline = 'NONE'; kind = 'NONE'; }
  if (has('invented')) { headline = 'A headline the stand-in made up, found nowhere'; kind = 'EMPIRICAL'; }
  const notEmpirical = has('allnot') ? numbers : numbers.filter((n) => n === 2);
  let ranked = numbers.filter((n) => !notEmpirical.includes(n)).reverse();
  if (has('missing') && ranked.length) ranked = ranked.filter((n) => n !== Math.max(...numbers));
  const decor = has('decor');
  const h = (word) => (decor ? `**${word}**` : word);
  const output = has('garbage') ? 'The stand-in could not rank these claims today.\n' : [
    decor ? '## SUMMARY' : 'SUMMARY',
    'RANKSUM-4d2a The stand-in reads the document and says what it reports.',
    'A second line of the summary, written apart.',
    '',
    `${h('HEADLINE')}: ${headline}`,
    `${h('HEADLINE TYPE')}: ${kind}`,
    `${h('HEADLINE CLAIM')}: ${has('dup') ? '1' : 'NONE'}`,
    '',
    h('RANKED'),
    ...ranked.map((n, i) => (decor ? `${i + 1}. ${n}` : String(n))),
    '',
    h('NOT EMPIRICAL'),
    ...(notEmpirical.length ? notEmpirical.map(String) : ['NONE']),
    '',
  ].join('\n');
  send({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_r', status: 'in_progress', role: 'assistant', content: [] } });
  for (const delta of output.match(/[\s\S]{1,9}/g) || []) {
    if (res.writableEnded || res.destroyed) return;
    send({ type: 'response.output_text.delta', item_id: 'msg_r', output_index: 1, content_index: 0, delta });
    await sleep(5);
  }
  send({ type: 'response.output_text.done', item_id: 'msg_r', output_index: 1, content_index: 0, text: output });
  send({ type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_r', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: output, annotations: [] }] } });
  const read = items.map((m) => (m.content || []).map((c) => c.text || '').join('')).join('').length;
  send({
    type: 'response.completed',
    response: {
      id, object: 'response', status: 'completed', model: body.model, error: null, incomplete_details: null,
      usage: { input_tokens: Math.round(read / 4), input_tokens_details: { cached_tokens: 0 }, output_tokens: Math.round(output.length / 4) + 40, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 0 },
    },
  });
  res.end();
}

/** One round of a determination on DeepSeek (see above): a call to FactEngine's tools, or the entry. */
async function dsRound({ res, body, send, id, promptText, items, ordinal }) {
  const answers = items.filter((x) => x?.type === 'function_call_output');
  const tools = new Set((body.tools || []).filter((t) => t.type === 'function').map((t) => t.name));
  const claim = promptText.split('\n')[0].replace(/^\s*Prompt\s*=\s*/, '').trim();
  const thought = `${DS_COT} weighing what the claim needs (round ${answers.length + 1}).`;
  const reasoningItem = { type: 'reasoning', id: `rs_${ordinal}`, status: 'completed', content: [{ type: 'reasoning_text', text: thought }], summary: [] };
  // The usage of a round: its input, most of it read again at the cache's price after the first.
  const inputTokens = Math.round(JSON.stringify(items).length / 4);
  const usage = (out) => ({ input_tokens: inputTokens, input_tokens_details: { cached_tokens: answers.length ? Math.round(inputTokens * 0.8) : 0 }, output_tokens: out + 50, output_tokens_details: { reasoning_tokens: 50 }, total_tokens: 0 });
  // Which call this round makes, if any: a search first, then a page, then the entry.
  let call = null;
  if (answers.length === 0 && tools.has('search_web')) call = { name: 'search_web', args: { query: `evidence for ${claim.slice(0, 60)}` } };
  else if (answers.length <= 1 && tools.has('read_page')) {
    let url = process.env.MOCK_DS_READ_URL || '';
    if (!url) { try { url = JSON.parse(answers[0]?.output || '{}').items?.[0]?.url || ''; } catch { /* no page found */ } }
    if (url) call = { name: 'read_page', args: { url } };
  }
  send({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: reasoningItem.id, status: 'in_progress', content: [] } });
  send({ type: 'response.reasoning_text.delta', item_id: reasoningItem.id, output_index: 0, content_index: 0, delta: thought });
  send({ type: 'response.output_item.done', output_index: 0, item: reasoningItem });
  if (DS_ERROR_EVENT.has(ordinal)) {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: 'Server Overloaded', code: 'server_overloaded' } })}\n\n`);
    res.end();
    return;
  }
  if (call) {
    const item = { type: 'function_call', id: `fc_${ordinal}`, call_id: `call_${ordinal}`, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' };
    send({ type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '', status: 'in_progress' } });
    send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 1, delta: item.arguments });
    send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 1, arguments: item.arguments });
    send({ type: 'response.output_item.done', output_index: 1, item });
    send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', model: body.model, store: false, error: null, incomplete_details: null, output: [reasoningItem, item], usage: usage(40) } });
    res.end();
    return;
  }
  const hold = Number(process.env.MOCK_EVAL_HOLD_MS || 0);
  if (hold) await sleep(hold);
  const output = mockEntry(claim);
  send({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: `msg_${ordinal}`, status: 'in_progress', role: 'assistant', content: [] } });
  for (const delta of output.match(/[\s\S]{1,28}/g) || []) {
    if (res.writableEnded || res.destroyed) return;
    send({ type: 'response.output_text.delta', item_id: `msg_${ordinal}`, output_index: 1, content_index: 0, delta });
    await sleep(8);
  }
  const message = { type: 'message', id: `msg_${ordinal}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: output, annotations: [] }] };
  send({ type: 'response.output_text.done', item_id: message.id, output_index: 1, content_index: 0, text: output });
  send({ type: 'response.output_item.done', output_index: 1, item: message });
  send({ type: 'response.completed', response: { id, object: 'response', status: 'completed', model: body.model, store: false, error: null, incomplete_details: null, output: [reasoningItem, message], usage: usage(Math.round(output.length / 4)) } });
  res.end();
}

// ---- Gemini ------------------------------------------------------------------------------
// The operator's trial on Gemini (server/gemini.js) talks to this when CIVIC_GEMINI_BASE_URL points here
// (http://localhost:<port>/gemini). It speaks Google's Interactions API as its pages of 16 October describe it: the key
// in x-goog-api-key; server-sent events named by `event_type` (step.start, step.delta, step.stop, interaction.completed
// with its usage, then [DONE]); a thought with its summary and its signature; two Google searches, one page read through
// URL context; the answer, its first words inside step.start, with url_citation annotations; and Google's refusals: 429
// with a RetryInfo of a second (MOCK_GM_RETRY_DELAY names another, as Google writes it: "20s"), 429 naming no wait at
// all (MOCK_GM_429_BARE), 503, 402 (the prepaid balance used up), 401 (a key it refuses: one that begins gm-bad), an
// error event mid-stream, a stream closed with no event. A 429's words are a quota's, as Google's are, with a limit above
// 0, a marker (GMWAIT-7f3a) and the key it was asked with, which must never reach a card, /check or the log. Two more
// answer a 429 as Google did on 19 October, as the stream's own error event with the wait in a Retry-After header:
// MOCK_GM_429_SSE at a limit above 0 (GMSSE-3e1b, a second), MOCK_GM_429_ZERO at "limit: 0 … on Free Tier" (GMZERO-8d4c,
// Google's 58,163 s to its daily reset). Each knob lists request ordinals (1-based). The guard's keys are its own
// made-up words, never in the shape of a real Google key.
const GM_MODELS = ['gemini-4-argon'];
const GM_LEVELS = new Set(['low', 'medium', 'high']);
const GM_429 = dsSet('MOCK_GM_429'), GM_429_BARE = dsSet('MOCK_GM_429_BARE'), GM_429_SSE = dsSet('MOCK_GM_429_SSE'), GM_429_ZERO = dsSet('MOCK_GM_429_ZERO'), GM_503 = dsSet('MOCK_GM_503'), GM_402 = dsSet('MOCK_GM_402'), GM_CLOSE = dsSet('MOCK_GM_CLOSE'), GM_ERROR_EVENT = dsSet('MOCK_GM_ERROR_EVENT');
const GM_RETRY_DELAY = process.env.MOCK_GM_RETRY_DELAY || '1s';
const gmQuotaWords = (req, model) => `You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_minute, limit: 25, model: ${model}. GMWAIT-7f3a (asked with ${req.get('x-goog-api-key') || 'no key'}).`;
// A refusal in the stream's own form: an error event, as Google sent one on 19 October to a request that asked for a stream.
const gmStreamRefusal = (res, retryAfter, message) => {
  res.status(429);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Retry-After', String(retryAfter));
  res.end(`event: error\ndata: ${JSON.stringify({ error: { message, code: 'rate_limit_exceeded' }, event_type: 'error' })}\n\n`);
};
const GM_THOUGHT = 'GMSUM-5b2e';   // the thought summary's marker: shown on the operator's card, as the readers' model's
const GM_SIG = 'GMSIG-0c7d';       // the thought signature's marker: never on a page, a replay, a ledger line or a record
const gmStats = { requests: 0, streams: 0, levels: [], lastBody: null };
let gmOrdinal = 0;
const gmRefused = (res, status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
const gmKeyRefused = (req) => { const k = req.get('x-goog-api-key') || ''; return !k || k.startsWith('gm-bad'); };

app.get('/gemini/mock/stats', (req, res) => res.json(gmStats));
app.get('/gemini/v1beta/models/:id', (req, res) => {
  if (gmKeyRefused(req)) return gmRefused(res, 401, 'authentication', 'API key not valid. Please pass a valid API key.');
  if (!GM_MODELS.includes(req.params.id)) return gmRefused(res, 404, 'model_not_found', `models/${req.params.id} is not found for API version v1beta.`);
  res.json({ name: `models/${req.params.id}`, displayName: 'Gemini 4 Argon', inputTokenLimit: 1048576, outputTokenLimit: 1048576, thinking: true });
});
app.post('/gemini/v1beta/interactions', async (req, res) => {
  const body = req.body || {};
  const ordinal = ++gmOrdinal;
  gmStats.requests = ordinal;
  gmStats.lastBody = body;
  if (gmKeyRefused(req)) return gmRefused(res, 401, 'authentication', 'API key not valid. Please pass a valid API key.');
  if (!GM_MODELS.includes(body.model)) return gmRefused(res, 404, 'model_not_found', `The model ${body.model} was not found.`);
  const level = body.generation_config?.thinking_level;
  if (level !== undefined && !GM_LEVELS.has(level)) return gmRefused(res, 400, 'invalid_request', `Invalid value at 'generation_config.thinking_level': ${level}`);
  gmStats.levels.push(level ?? null);
  if (GM_402.has(ordinal)) return gmRefused(res, 402, 'payment_required', 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.');
  if (GM_429.has(ordinal)) return gmRefused(res, 429, 'rate_limit_exceeded', `${gmQuotaWords(req, body.model)} Please retry in ${GM_RETRY_DELAY}.`, [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: GM_RETRY_DELAY }]);
  if (GM_429_BARE.has(ordinal)) return gmRefused(res, 429, 'rate_limit_exceeded', gmQuotaWords(req, body.model));
  if (GM_429_SSE.has(ordinal)) return gmStreamRefusal(res, 1, `Rate limit exceeded for model ${body.model} (limit: 25 input tokens per minute on Tier 1). GMSSE-3e1b`);
  if (GM_429_ZERO.has(ordinal)) return gmStreamRefusal(res, 58163, `Rate limit exceeded for model ${body.model} (limit: 0 input tokens per minute on Free Tier). Please upgrade your tier at https://ai.dev/rate-limit. GMZERO-8d4c (asked with ${req.get('x-goog-api-key') || 'no key'})`);
  if (GM_503.has(ordinal)) return gmRefused(res, 503, 'service_unavailable', 'The model is overloaded. Please try again later.');
  gmStats.streams++;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  if (GM_CLOSE.has(ordinal)) { res.end(); return; }
  const send = (ev) => res.write(`event: ${ev.event_type}\ndata: ${JSON.stringify(ev)}\n\n`);
  const id = 'v1_gm_' + Math.random().toString(36).slice(2);
  send({ event_type: 'interaction.created', interaction: { id, status: 'in_progress', object: 'interaction', model: body.model } });
  const steps = Array.isArray(body.input) ? body.input : [];
  const users = steps.filter((s) => s?.type === 'user_input');
  const promptText = ((users[users.length - 1] || {}).content || []).map((c) => c.text || '').join('\n');
  const claim = promptText.split('\n')[0].replace(/^\s*Prompt\s*=\s*/, '').trim();
  let index = 0;
  send({ event_type: 'step.start', index, step: { type: 'thought', summary: [] } });
  send({ event_type: 'step.delta', index, delta: { type: 'thought_summary', content: { type: 'text', text: `${GM_THOUGHT} Weighing what the claim needs, and where to look.` } } });
  send({ event_type: 'step.delta', index, delta: { type: 'thought_signature', signature: `${GM_SIG}-${ordinal}` } });
  send({ event_type: 'step.stop', index: index++ });
  if (GM_ERROR_EVENT.has(ordinal)) { send({ event_type: 'error', error: { code: 'service_unavailable', message: 'The model is overloaded.' } }); res.end(); return; }
  const tools = new Set((body.tools || []).map((t) => t?.type));
  const searched = tools.has('google_search');
  if (searched) {
    // Two searches, the second arriving as a delta of the call's step.
    send({ event_type: 'step.start', index, step: { type: 'google_search_call', id: `gs_${ordinal}`, arguments: { queries: [`evidence for ${claim.slice(0, 50)}`] } } });
    send({ event_type: 'step.delta', index, delta: { type: 'google_search_call', arguments: { queries: [`${claim.slice(0, 40)} official figure`] } } });
    send({ event_type: 'step.stop', index: index++ });
    send({ event_type: 'step.start', index, step: { type: 'google_search_result', call_id: `gs_${ordinal}`, result: [{ search_suggestions: '<div class="gs">suggestions</div>' }] } });
    send({ event_type: 'step.stop', index: index++ });
  }
  const readUrl = process.env.MOCK_GM_READ_URL || 'https://example.org/tower';
  const read = tools.has('url_context');
  if (read) {
    send({ event_type: 'step.start', index, step: { type: 'url_context_call', id: `uc_${ordinal}`, arguments: { urls: [readUrl] } } });
    send({ event_type: 'step.stop', index: index++ });
    send({ event_type: 'step.start', index, step: { type: 'url_context_result', call_id: `uc_${ordinal}`, result: [{ url: readUrl, status: 'success' }] } });
    send({ event_type: 'step.stop', index: index++ });
  }
  const hold = Number(process.env.MOCK_EVAL_HOLD_MS || 0);
  if (hold) await sleep(hold);
  const output = mockEntry(claim);
  const pieces = output.match(/[\s\S]{1,28}/g) || [''];
  send({ event_type: 'step.start', index, step: { type: 'model_output', content: [{ type: 'text', text: pieces[0] }] } });
  for (const piece of pieces.slice(1)) {
    if (res.writableEnded || res.destroyed) return;
    send({ event_type: 'step.delta', index, delta: { type: 'text', text: piece } });
    await sleep(8);
  }
  send({ event_type: 'step.delta', index, delta: { type: 'text_annotation_delta', annotations: [
    { type: 'url_citation', url: readUrl, title: 'The tower, measured', start_index: 0, end_index: 20 },
    { type: 'url_citation', url: 'https://example.org/second-source', title: 'A second source', start_index: 21, end_index: 40 },
    { type: 'url_citation', url: readUrl, title: 'The tower, measured', start_index: 41, end_index: 60 },
  ] } });
  send({ event_type: 'step.stop', index: index++ });
  const usage = {
    total_input_tokens: Math.round(JSON.stringify(steps).length / 4), total_cached_tokens: 0, total_output_tokens: Math.round(output.length / 4),
    total_thought_tokens: level === 'high' ? 900 : 400, total_tool_use_tokens: read ? 1200 : 0, total_tokens: 0,
    ...(searched ? { grounding_tool_count: [{ type: 'google_search', count: 2 }] } : {}),
  };
  send({ event_type: 'interaction.completed', interaction: { id, status: 'completed', object: 'interaction', model: body.model, usage } });
  res.write('event: done\ndata: [DONE]\n\n');
  res.end();
});

// ---- Fireworks ---------------------------------------------------------------------------
// The listing on Fireworks (server/fireworks.js) talks to this when CIVIC_FIREWORKS_BASE_URL points here
// (http://localhost:<port>/fireworks). It speaks Fireworks' dialect of the Responses API as its pages and its own
// examples show it: the model's chain of thought inside the answer's text, ahead of `</think>` with no opening tag
// (MOCK_FW_TAGGED lists the requests that open it with `<think>`; MOCK_FW_APART those that send it apart, as reasoning
// events, instead), carrying a marker and numbered lines of its own that must never become claims; the input listed
// among the output as a user's item, with numbered lines of its own too; the request echoed in response.created; usage
// as prompt_tokens and completion_tokens; no web search, and an `mcp` tool called by the stand-in itself during the
// response, as Fireworks calls one (MOCK_FW_TOOL_CALLS); and its refusals: 429 with no wait, 503, 402 (out of
// credits), an error event mid-stream, a stream closed with no event. Each knob lists request ordinals (1-based).
const FW_MODELS = ['accounts/fireworks/models/deepseek-v4p1-flash', 'accounts/fireworks/models/kimi-k3'];
const FW_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const FW_429 = dsSet('MOCK_FW_429'), FW_503 = dsSet('MOCK_FW_503'), FW_402 = dsSet('MOCK_FW_402'), FW_CLOSE = dsSet('MOCK_FW_CLOSE'), FW_ERROR_EVENT = dsSet('MOCK_FW_ERROR_EVENT');
const FW_TAGGED = dsSet('MOCK_FW_TAGGED'), FW_APART = dsSet('MOCK_FW_APART');
const FW_TOOL_CALLS = (() => { try { return JSON.parse(process.env.MOCK_FW_TOOL_CALLS || '[]'); } catch { return []; } })();
const FW_COT = 'FWCOT-2c9d';    // the chain of thought's marker: never in a claim, on a page, a replay, a ledger line or a failure record
const FW_USER = 'FWUSER-8b1e';  // the input's echo among the output: never a claim either
const fwStats = { requests: 0, streams: 0 };
let fwOrdinal = 0;

app.get('/fireworks/models', (req, res) => res.json({ object: 'list', data: FW_MODELS.map((id) => ({ id, object: 'model', owned_by: 'fireworks' })) }));
app.get('/fireworks/mock/stats', (req, res) => res.json(fwStats));

app.post('/fireworks/responses', async (req, res) => {
  const body = req.body || {};
  const ordinal = ++fwOrdinal;
  fwStats.requests = ordinal;
  if (!FW_MODELS.includes(body.model)) return res.status(404).json({ error: { message: `Model not found, inaccessible, and/or not deployed: ${body.model}`, code: 'NOT_FOUND' } });
  if (body.reasoning?.effort !== undefined && !FW_EFFORTS.has(body.reasoning.effort)) return res.status(400).json({ error: { message: `Invalid reasoning effort: ${body.reasoning.effort}` } });
  if (FW_402.has(ordinal)) return res.status(402).json({ error: { message: 'Your account is out of credits. Add credits at app.fireworks.ai to continue.', code: 'PAYMENT_REQUIRED' } });
  if (FW_429.has(ordinal)) return res.status(429).json({ error: { message: 'Too many requests', code: 'RATE_LIMITED' } });
  if (FW_503.has(ordinal)) return res.status(503).json({ error: { message: 'Service unavailable', code: 'UNAVAILABLE' } });
  fwStats.streams++;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  if (FW_CLOSE.has(ordinal)) { res.end(); return; }
  let seq = 0;
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: seq++ })}\n\n`);
  const id = body.store === false ? null : 'resp_fw_' + Math.random().toString(36).slice(2);
  const echo = { id, object: 'response', status: 'in_progress', model: body.model, reasoning: body.reasoning ?? null, store: body.store ?? true, tools: body.tools || [] };
  send({ type: 'response.created', response: echo });
  send({ type: 'response.in_progress', response: echo });
  // The input among the output, as Fireworks lists it: a user's item, with numbered lines of its own.
  send({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_in', type: 'message', role: 'user', status: 'completed', content: [] } });
  send({ type: 'response.output_text.delta', item_id: 'msg_in', output_index: 0, content_index: 0, delta: `${FW_USER} the input, listed\n1. ${FW_USER} an echo of the input\n2. ${FW_USER} never a claim\n` });
  send({ type: 'response.output_item.done', output_index: 0, item: { id: 'msg_in', type: 'message', role: 'user', status: 'completed', content: [] } });
  const thought = `${FW_COT} reading the document whole.\n1. ${FW_COT} first, every claim in the order it comes\n2. ${FW_COT} then who said it and when\n`;
  if (FW_APART.has(ordinal)) {
    send({ type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'rs_fw', status: 'in_progress' } });
    for (const delta of thought.match(/[\s\S]{1,13}/g) || []) send({ type: 'response.reasoning_text.delta', item_id: 'rs_fw', output_index: 1, content_index: 0, delta });
    send({ type: 'response.output_item.done', output_index: 1, item: { type: 'reasoning', id: 'rs_fw', status: 'completed', content: [{ type: 'reasoning_text', text: thought }] } });
  }
  if (FW_ERROR_EVENT.has(ordinal)) {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: 'Service unavailable', code: 'UNAVAILABLE' } })}\n\n`);
    res.end();
    return;
  }
  const mcp = (body.tools || []).find((t) => t.type === 'mcp');
  if (mcp && FW_TOOL_CALLS.length) await playMcp(mcp, send, FW_TOOL_CALLS, { style: 'fireworks' });
  const text = inputText(body);
  const claims = mockClaims(documentOf(body, text));
  const output = FW_APART.has(ordinal) ? claims : FW_TAGGED.has(ordinal) ? `<think>${thought}</think>\n\n${claims}` : `${thought}</think>\n\n${claims}`;
  send({ type: 'response.output_item.added', output_index: 2, item: { type: 'message', id: 'msg_fw', status: 'in_progress', role: 'assistant', content: [] } });
  // Pieces of thirteen characters, so the marker is split between two pieces as often as not.
  for (const delta of output.match(/[\s\S]{1,13}/g) || []) {
    if (res.writableEnded || res.destroyed) return;
    send({ type: 'response.output_text.delta', item_id: 'msg_fw', output_index: 2, content_index: 0, delta });
    await sleep(4);
  }
  send({ type: 'response.output_text.done', item_id: 'msg_fw', output_index: 2, content_index: 0, text: output });
  send({ type: 'response.output_item.done', output_index: 2, item: { type: 'message', id: 'msg_fw', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: output }] } });
  const prompt = Math.round(text.length / 4), completion = Math.round(output.length / 4) + 50;
  send({
    type: 'response.completed',
    response: { ...echo, status: 'completed', usage: { input_tokens: null, output_tokens: null, prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: 7 } } },
  });
  res.end();
});

app.use((req, res) => res.status(404).json({ error: { message: `mock: no route ${req.method} ${req.path}` } }));

app.listen(PORT, () => console.log(`mock OpenAI on http://localhost:${PORT}/v1  (speed x${SPEED})`));

// ---- Canned content ----------------------------------------------------------------------

const MOCK_BRIEF = `SUBJECT: a public reading-room table at the end of the day, a stack of bound newspaper volumes half open on it
SETTING: a municipal library annexe in early autumn, late afternoon, tall windows facing a street of plane trees
FOREGROUND: a brass reading lamp and a pencil lying across an index card, slightly out of focus
LIGHT: low side light through the windows, warm, long shadows across the table grain
PALETTE: oak brown, paper cream, brass, deep green, cool window blue
LENS: 35mm, eye level, half a step back from the table edge`;

const MOCK_REASONING = [
  'Restating the proposition in measurable terms and identifying which part is the empirical load.',
  'Looking for a primary artifact rather than repetition: an original record, a measurement, or a published table.',
  'Checking whether the candidate source actually addresses the exact proposition, then stopping once it is settled.',
];

const MOCK_SOURCES = [
  { url: 'https://example.gov/records/primary-source', title: 'Official record (mock source)' },
  { url: 'https://example.org/dataset/table-3', title: 'Published data table 3 (mock source)' },
];

function pickQueries(claim) {
  const words = claim.replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 4).slice(0, 4);
  const first = words.join(' ') || claim.slice(0, 40);
  // With MOCK_INSPECTOR, the first search names the inspector, as a real one may.
  return [process.env.MOCK_INSPECTOR ? `${inspectorName()} ${first}` : first, `${words.slice(0, 2).join(' ')} primary source`];
}
// The inspector as written in its thinking: the name without its description or its title ("Edwin Cardale").
const inspectorName = () => String(process.env.MOCK_INSPECTOR || '').replace(/\s*\(.*\)\s*$/, '').replace(/^(?:Sir|Dame|Dr\.?|Professor)\s+/, '');

// MOCK_DROP_REQUESTS=2,5: those requests, counted from the first this process receives, lose their
// connection a few chunks in, the way a real stream dies when a socket is cut.
const DROP = new Set(String(process.env.MOCK_DROP_REQUESTS || '').split(',').map(Number).filter(Boolean));
// MOCK_END_EARLY_REQUESTS: the reply ends politely a few chunks in, with no last event (completed, incomplete, failed):
// a cut, however polite, which the server must take up again rather than deliver. MOCK_ERROR_EVENT_REQUESTS: the reply
// ends a few chunks in with an `error` event of an overloaded server, which the SDK throws with no status.
const END_EARLY = new Set(String(process.env.MOCK_END_EARLY_REQUESTS || '').split(',').map(Number).filter(Boolean));
const ERROR_EVENT = new Set(String(process.env.MOCK_ERROR_EVENT_REQUESTS || '').split(',').map(Number).filter(Boolean));
// MOCK_RATE_LIMIT_REQUESTS=2: before those requests the bucket is drained, as another user of the
// key would drain it, so they are refused with the real limiter's figures and fit again 700 ms on.
const LIMIT = new Set(String(process.env.MOCK_RATE_LIMIT_REQUESTS || '').split(',').map(Number).filter(Boolean));

// ---- The limiter, kept as OpenAI's own figures show OpenAI keeps it (see server/gate.js) --------
// A bucket of MOCK_TPM tokens refilled continuously over MOCK_WINDOW_MS (the stand-in's minute; the
// real one is 60 000 ms). Each request costs the stand-in's estimate for its kind: MOCK_RESERVE for
// a determination, MOCK_RESERVE_EXTRACT for an extraction, MOCK_RESERVE_ART for the art direction;
// MOCK_RESERVE_SERIES ("58013,83734,...") gives successive determinations successive costs, the way
// the real estimate varies. A request the bucket cannot hold is refused as OpenAI refuses it: the
// same message, the same figures, the wait that refills the difference. MOCK_RPM keeps a requests
// bucket the same way (0: none). Every reply carries the headers the real API carries. The earlier
// stand-in kept a sliding window, in which a request's tokens came back all at once a minute after
// it went; the gate proved against that was wrong against the real thing.
const WINDOW = Number(process.env.MOCK_WINDOW_MS || 60_000);
const RESERVE = Number(process.env.MOCK_RESERVE || 68147);
const SERIES = String(process.env.MOCK_RESERVE_SERIES || '').split(',').map(Number).filter(Boolean);
const COSTS = { determination: RESERVE, extraction: Number(process.env.MOCK_RESERVE_EXTRACT || RESERVE), art: Number(process.env.MOCK_RESERVE_ART || RESERVE) };
const bucketOf = (limit) => ({ limit, level: limit, at: Date.now() });
const TOKENS = bucketOf(Number(process.env.MOCK_TPM || 5_000_000));
const REQUESTS = Number(process.env.MOCK_RPM || 0) > 0 ? bucketOf(Number(process.env.MOCK_RPM)) : null;
const levelOf = (b, now = Date.now()) => Math.min(b.limit, b.level + (now - b.at) * b.limit / WINDOW);
const settle = (b, now = Date.now()) => { b.level = levelOf(b, now); b.at = now; };
const fmtWait = (ms) => (ms < 1000 ? `${Math.ceil(ms)}ms` : `${(ms / 1000).toFixed(3)}s`);
const CONTINUATION = Number(process.env.MOCK_CONTINUATION || 0);
const HEADERS_DELAY = Number(process.env.MOCK_HEADERS_DELAY_MS || 0);   // the reply's headers held back this long (scaled by MOCK_SPEED)
const STREAM_LIMIT = new Set(String(process.env.MOCK_STREAM_RATE_LIMIT_REQUESTS || '').split(',').map(Number).filter(Boolean));
const STREAM_REQUESTED = Number(process.env.MOCK_STREAM_REQUESTED || 0);
const stats = { admitted: 0, refused: 0, refusedInStream: 0, inFlight: 0, maxInFlight: 0, timeline: [] };
let determinations = 0;
function costOf(kind) {
  if (kind === 'determination' && SERIES.length) return SERIES[determinations++ % SERIES.length];
  return COSTS[kind] ?? RESERVE;
}
// The headers are written for the moment of the decision, as the real ones are: with a three-second
// minute the bucket refills 68 tokens a millisecond, and a header written a millisecond later
// would show a cost 68 tokens short.
function limitHeaders(res, now = Date.now()) {
  const tokens = levelOf(TOKENS, now);
  res.set('x-ratelimit-limit-tokens', String(TOKENS.limit));
  res.set('x-ratelimit-remaining-tokens', String(Math.floor(tokens)));
  res.set('x-ratelimit-reset-tokens', fmtWait((TOKENS.limit - tokens) * WINDOW / TOKENS.limit));
  if (REQUESTS) {
    const requests = levelOf(REQUESTS, now);
    res.set('x-ratelimit-limit-requests', String(REQUESTS.limit));
    res.set('x-ratelimit-remaining-requests', String(Math.floor(requests)));
    res.set('x-ratelimit-reset-requests', fmtWait((REQUESTS.limit - requests) * WINDOW / REQUESTS.limit));
  }
}
/** Admits the request, deducting its cost, or refuses it exactly as the real limiter would. */
function admitOrRefuse(res, model, kind, drained) {
  const now = Date.now();
  settle(TOKENS, now);
  if (REQUESTS) settle(REQUESTS, now);
  const cost = costOf(kind);
  if (drained) TOKENS.level = Math.max(0, cost - 700 * TOKENS.limit / WINDOW);   // holds this request again 700 ms from now
  if (REQUESTS && REQUESTS.level < 1) return refuse(res, model, 'requests per min (RPM)', REQUESTS, 1);
  if (TOKENS.level < cost) return refuse(res, model, 'tokens per min (TPM)', TOKENS, cost);
  TOKENS.level -= cost;
  if (REQUESTS) REQUESTS.level -= 1;
  stats.admitted++;
  stats.inFlight++;
  stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
  const entry = { at: now, kind, cost, level: Math.floor(TOKENS.level), headersAt: null, endedAt: null };
  stats.timeline.push(entry);
  limitHeaders(res, now);
  return entry;
}
function refuse(res, model, what, b, need) {
  stats.refused++;
  const used = b.limit - Math.floor(b.level);
  const wait = (need - b.level) * WINDOW / b.limit;
  limitHeaders(res, b.at);
  res.set('retry-after-ms', String(Math.ceil(wait)));
  res.set('retry-after', String(Math.max(1, Math.ceil(wait / 1000))));
  res.status(429).json({ error: { message: `Rate limit reached for ${model} in organization org-mock0000000000000000000 on ${what}: Limit ${b.limit}, Used ${used}, Requested ${need}. Please try again in ${fmtWait(wait)}. Visit https://platform.openai.com/account/rate-limits to learn more.`, type: what.startsWith('tokens') ? 'tokens' : 'requests', param: null, code: 'rate_limit_exceeded' } });
  return false;
}
let requestOrdinal = 0;

// The document a listing was given: the message whole when the prompt went as instructions, its headline line (put
// ahead of it by FactEngine since 24 October) set aside, as a model reads it; else what follows the prompt's slot, its
// attribution lines set aside, up to the closing line a prompt may put after its slot (24 October).
function documentOf(body, text) {
  if (body.instructions) return text.replace(/^Headline: [^\n]*\n\n/, '');
  const closed = text.replace(/\n<\/[^>\n]+>\s*$/, '');
  const cut = closed.lastIndexOf('\n\n');
  return cut < 0 ? closed : closed.slice(cut + 2).replace(/^[^\n]*:[ \t]*\n/, '');
}

// Role lines (24 October), when the document carries a mark "[roles:mix]" or "[roles:supporting]", or MOCK_ROLES says
// so: `mix` cycles central, supporting, incidental, unranked and none; `supporting` gives every claim that role. The
// words are the operator's when MOCK_OUTPUT_NAMES sets them (role, roles), and each line is written in one of the shapes
// a model may use: indented, after a bullet, in bold.
const ROLE_CYCLE = ['central', 'supporting', 'incidental', 'unranked', null];
function roleLines(source, i) {
  const mode = (String(source).match(/\[roles:(mix|supporting)\]/) || [])[1] || process.env.MOCK_ROLES || '';
  const role = mode === 'supporting' ? 'supporting' : mode === 'mix' ? ROLE_CYCLE[i % ROLE_CYCLE.length] : null;
  if (!role) return [];
  const word = MOCK_NAMES.roles?.[role]?.[0] || role.replace(/^./, (c) => c.toUpperCase());
  const name = label('role', 'Role');
  return [[`   ${name}: ${word}`, `   - **${name}:** ${word}`, `**${name}**: ${word}`][i % 3]];
}

// Invented entries for development only, in the labelled shape the reader keys on: a claim
// line, then further labelled lines kept beside it. Nothing here is from the real prompt.
function mockClaims(source) {
  const sentences = source
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
  const picked = sentences.slice(0, 26);
  if (!picked.length) picked.push('The source contains no clearly empirical sentence.');
  return picked.map((s, i) => [
    `${i + 1}. Claim: ${s}`,
    ...roleLines(source, i),
    'Attribution: The supplied text; no date given.',
    ...(i % 3 === 0 ? ['Unspecified in source: the period the figure refers to.'] : []),
  ].join('\n')).join('\n');
}

const INSPECTORS = ['Orin Vale', 'Tessa Marlowe', 'Edwin Cardale', 'Lena Sorvik', 'Halvard Brecke', 'Mira Okafor-Hale', 'Jonas Wren', 'Ilse Varga', 'Tomas Ferrand', 'Ruth Abernathy-Cole'];   // invented: the stand-in names no real person
// MOCK_INSPECTOR: one inspector for every entry (the guard's reader checks look for its name where it must not be).
// MOCK_OUTPUT_NAMES: the headings the entry is written under, as the operator's list sets them (server/names.js).
const MOCK_NAMES = (() => { try { return JSON.parse(process.env.MOCK_OUTPUT_NAMES || '{}'); } catch { return {}; } })();
const label = (key, fallback) => (Array.isArray(MOCK_NAMES[key]) ? MOCK_NAMES[key][0] : MOCK_NAMES[key]) || fallback;
const said = (verdict) => (MOCK_NAMES.verdicts?.[verdict]?.[0] ? MOCK_NAMES.verdicts[verdict][0].replace(/^./, (c) => c.toUpperCase()) : null);

function mockEntry(claim) {
  const roll = Math.random();
  const verdict = roll < 0.45 ? 'True' : roll < 0.75 ? 'False' : 'Uncertain';
  const word = said(verdict === 'True' ? 'true' : verdict === 'False' ? 'false' : 'unverified') || verdict;
  const who = process.env.MOCK_INSPECTOR || INSPECTORS[Math.floor(Math.random() * INSPECTORS.length)];
  const conf = verdict === 'Uncertain' ? 35 + Math.floor(Math.random() * 25) : 78 + Math.floor(Math.random() * 20);
  // Invented filler for development only, in no format of the operator's: only the three labels FactEngine reads an
  // entry by are present, the inspector's, the verdict's and the confidence's, in FactEngine's own words unless set.
  return `**${label('name', 'Name')}**: ${who}

(Development mock. Invented placeholder text, never a determination.)

**Claim**: "${claim}"

**Notes**: The proposition was split into its measurable parts, and each part was looked up in a record.

1. **First point:** the figure was taken from the record and read twice.
2. **Second point:** the period might mean:
   - fourteen consecutive seven-day periods; or
   - fourteen separate weeks, excluding breaks.
3. **Third point:** one further instance would change the figure as stated.

**${label('conclusion', 'Conclusion')}**: ${word}. ${verdict === 'True' ? 'The record states the proposition as claimed.' : verdict === 'False' ? 'The record contradicts the proposition as stated.' : 'No record was found that settles the proposition either way.'}

**${label('confidence', 'Confidence')}**: ${conf}%. ${verdict === 'Uncertain' ? 'Confidence is limited by the absence of a record.' : 'Some uncertainty remains.'}`;
}
