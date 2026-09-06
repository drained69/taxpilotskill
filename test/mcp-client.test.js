import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, McpError, parseMcpBody, extractText, isAllowedMcpUrl } from '../src/mcp-client.js';

// Minimal fake Response.
function response(body, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => map.get(k.toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('parseMcpBody decodes an SSE stream and plain JSON', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n';
  const msgs = parseMcpBody('text/event-stream', sse);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].result.ok, true);
  assert.deepEqual(parseMcpBody('application/json', '{"id":2,"result":1}'), [{ id: 2, result: 1 }]);
});

test('McpClient runs the full lifecycle and propagates the session id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    calls.push({ method: msg.method, session: init.headers['mcp-session-id'], auth: init.headers.authorization });
    if (msg.method === 'initialize') {
      return response({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'agent-os', version: '1' } } }, { headers: { 'mcp-session-id': 'sess-42', 'content-type': 'application/json' } });
    }
    if (msg.method === 'notifications/initialized') return response('', { status: 202 });
    if (msg.method === 'tools/list') {
      return response({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'get_transaction_history' }] } });
    }
    if (msg.method === 'tools/call') {
      const payload = JSON.stringify({ transactions: [{ id: 't1' }] });
      return response({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: payload }] } });
    }
    throw new Error(`unexpected ${msg.method}`);
  };

  const client = new McpClient({ token: 'tok', fetchImpl });
  const info = await client.initialize();
  assert.equal(info.name, 'agent-os');
  assert.equal(client.sessionId, 'sess-42');

  const tools = await client.listTools();
  assert.equal(tools[0].name, 'get_transaction_history');

  const result = await client.callTool('get_transaction_history', { limit: 10 });
  assert.deepEqual(result, { transactions: [{ id: 't1' }] });

  // initialize -> initialized -> tools/list -> tools/call, session echoed after init.
  assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(calls[2].session, 'sess-42');
  assert.equal(calls[0].auth, 'Bearer tok');
});

test('McpClient surfaces a 401 as an UNAUTHORIZED McpError with www-authenticate', async () => {
  const fetchImpl = async () => response({ error: 'no' }, { status: 401, headers: { 'www-authenticate': 'Bearer realm="Agent OS"' } });
  const client = new McpClient({ fetchImpl });
  await assert.rejects(() => client.initialize(), (err) => {
    assert.ok(err instanceof McpError);
    assert.equal(err.code, 'UNAUTHORIZED');
    assert.match(err.wwwAuthenticate, /Bearer/);
    return true;
  });
});

test('McpClient raises a JSON-RPC tool error', async () => {
  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return response({ id: msg.id, result: {} });
    if (msg.method === 'notifications/initialized') return response('', { status: 202 });
    return response({ id: msg.id, error: { code: -32001, message: 'insufficient scope' } });
  };
  const client = new McpClient({ fetchImpl });
  await assert.rejects(() => client.callTool('x'), /insufficient scope/);
});

test('extractText concatenates text blocks', () => {
  assert.equal(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb');
});

test('MCP URL validation only permits Binance HTTPS hosts by default', () => {
  assert.equal(isAllowedMcpUrl('https://agent.binance.com/mcp/agentic'), true);
  assert.equal(isAllowedMcpUrl('https://evil.example/mcp'), false);
  assert.equal(isAllowedMcpUrl('http://agent.binance.com/mcp'), false);
  assert.equal(isAllowedMcpUrl('http://localhost:3000/mcp', { allowNonBinance: true }), true);
});
