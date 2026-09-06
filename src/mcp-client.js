// Streamable HTTP MCP client for the Binance Agent OS endpoint.
//
// Implements the Model Context Protocol lifecycle over the Streamable HTTP
// transport (spec revision 2025-06-18):
//   1. POST `initialize`            -> capture the server-assigned Mcp-Session-Id
//   2. POST `notifications/initialized`
//   3. POST `tools/list` / `tools/call`
//
// A single POST may return either `application/json` (one JSON-RPC message) or
// `text/event-stream` (a short SSE stream carrying the response plus optional
// progress notifications). Both are parsed here so callers only ever see the
// decoded JSON-RPC result.
//
// The transport (`fetchImpl`) is injectable so the whole lifecycle is unit
// testable offline without touching the network.

export const DEFAULT_MCP_URL = 'https://agent.binance.com/mcp/agentic';
export const PROTOCOL_VERSION = '2025-06-18';

export function isAllowedMcpUrl(value, { allowNonBinance = false } = {}) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && !(allowNonBinance && parsed.protocol === 'http:')) return false;
    if (allowNonBinance) return true;
    return parsed.hostname === 'agent.binance.com' || parsed.hostname.endsWith('.binance.com');
  } catch {
    return false;
  }
}

export class McpError extends Error {
  constructor(message, { code, httpStatus, wwwAuthenticate, data } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.wwwAuthenticate = wwwAuthenticate;
    this.data = data;
  }
}

/**
 * Parse a Streamable HTTP response body into JSON-RPC messages.
 * Handles both a single JSON object and an SSE (`text/event-stream`) body.
 * @returns {object[]} decoded JSON-RPC messages in arrival order
 */
export function parseMcpBody(contentType, text) {
  const type = (contentType || '').toLowerCase();
  const body = (text || '').trim();
  if (!body) return [];

  if (type.includes('text/event-stream')) {
    const messages = [];
    // SSE events are separated by a blank line. A `data:` field may span
    // multiple lines; they are concatenated with newlines per the SSE spec.
    for (const rawEvent of body.split(/\r?\n\r?\n/)) {
      const dataLines = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n').trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        messages.push(JSON.parse(payload));
      } catch {
        // Ignore keep-alive comments or non-JSON data frames.
      }
    }
    return messages;
  }

  // Default: a single JSON document (possibly a batch array).
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export class McpClient {
  /**
   * @param {object} opts
   * @param {string} [opts.url]        MCP endpoint URL
   * @param {string} [opts.token]      OAuth bearer token (read-only scope)
   * @param {Function} [opts.fetchImpl] fetch implementation (defaults to global fetch)
   * @param {object} [opts.clientInfo] { name, version }
   * @param {number} [opts.timeoutMs]  per-request timeout
   */
  constructor({ url = DEFAULT_MCP_URL, token = '', fetchImpl, clientInfo, timeoutMs = 30_000 } = {}) {
    if (!isAllowedMcpUrl(url)) {
      throw new Error('MCP URL must use HTTPS and belong to an approved Binance host.');
    }
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.clientInfo = clientInfo || { name: 'TaxPilot', version: '1.0.0' };
    this.timeoutMs = timeoutMs;
    this.sessionId = '';
    this.serverInfo = null;
    this.initialized = false;
    this._id = 0;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('McpClient requires a fetch implementation (Node 18+ global fetch or an injected one).');
    }
  }

  _nextId() {
    this._id += 1;
    return this._id;
  }

  _headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    return headers;
  }

  /** Low-level POST of one JSON-RPC message. Returns { messages, response }. */
  async _post(message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new McpError(`Agent OS request timed out after ${this.timeoutMs}ms`, { code: 'TIMEOUT' });
      }
      throw new McpError(`Network error reaching Agent OS: ${error.message}`, { code: 'NETWORK' });
    } finally {
      clearTimeout(timer);
    }

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (response.status === 401 || response.status === 403) {
      throw new McpError('Agent OS authorization required or insufficient scope.', {
        code: 'UNAUTHORIZED',
        httpStatus: response.status,
        wwwAuthenticate: response.headers.get('www-authenticate') || '',
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new McpError(`Agent OS returned HTTP ${response.status}.`, {
        code: 'HTTP_ERROR',
        httpStatus: response.status,
        data: text.slice(0, 500),
      });
    }

    // 202 Accepted (notifications) carries no body.
    const messages = response.status === 202 ? [] : parseMcpBody(response.headers.get('content-type'), text);
    return { messages, response };
  }

  /** Send a JSON-RPC request and return its `result`, throwing on JSON-RPC error. */
  async _request(method, params = {}) {
    const id = this._nextId();
    const { messages } = await this._post({ jsonrpc: '2.0', id, method, params });
    const reply = messages.find((m) => m.id === id) || messages.find((m) => 'result' in m || 'error' in m);
    if (!reply) throw new McpError(`Agent OS returned no response for ${method}.`, { code: 'EMPTY_RESPONSE' });
    if (reply.error) {
      throw new McpError(`Agent OS error on ${method}: ${reply.error.message}`, {
        code: reply.error.code,
        data: reply.error.data,
      });
    }
    return reply.result;
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response expected). */
  async _notify(method, params = {}) {
    await this._post({ jsonrpc: '2.0', method, params });
  }

  /** Run the initialize + initialized handshake. Idempotent. */
  async initialize() {
    if (this.initialized) return this.serverInfo;
    const result = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: this.clientInfo,
    });
    this.serverInfo = result?.serverInfo || null;
    await this._notify('notifications/initialized');
    this.initialized = true;
    return this.serverInfo;
  }

  /** List available tools, following pagination cursors. */
  async listTools() {
    if (!this.initialized) await this.initialize();
    const tools = [];
    let cursor;
    do {
      const result = await this._request('tools/list', cursor ? { cursor } : {});
      for (const tool of result?.tools || []) tools.push(tool);
      cursor = result?.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Call a tool by name. Returns the parsed structured content when the tool
   * provides `structuredContent`; otherwise the decoded text content blocks.
   */
  async callTool(name, args = {}) {
    if (!this.initialized) await this.initialize();
    const result = await this._request('tools/call', { name, arguments: args });
    if (result?.isError) {
      const detail = extractText(result) || 'tool reported an error';
      throw new McpError(`Agent OS tool "${name}" failed: ${detail}`, { code: 'TOOL_ERROR', data: result });
    }
    if (result && 'structuredContent' in result && result.structuredContent != null) {
      return result.structuredContent;
    }
    const text = extractText(result);
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    }
    return result?.content ?? null;
  }
}

/** Concatenate the text of all `text` content blocks in a tool result. */
export function extractText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
