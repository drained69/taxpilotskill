import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaxReportFromAgentOS, selectTool, TOOL_MATCHERS, isReadOnlyTool, selectBinanceHistoryTools, BINANCE_HISTORY_TOOLS } from '../src/agent-os.js';

test('selectTool matches history and balance tools by name/description', () => {
  const tools = [
    { name: 'get_account_balance', description: 'Read balances' },
    { name: 'get_transaction_history', description: 'Read transaction history' },
  ];
  assert.equal(selectTool(tools, TOOL_MATCHERS.transactions).name, 'get_transaction_history');
  assert.equal(selectTool(tools, TOOL_MATCHERS.balances).name, 'get_account_balance');
});

test('tool policy rejects write tools and permits read-only history', () => {
  assert.equal(isReadOnlyTool({ name: 'get_transaction_history' }), true);
  assert.equal(isReadOnlyTool({ name: 'get_account_balance' }), true);
  assert.equal(isReadOnlyTool({ name: 'create_order', description: 'Read market order status' }), false);
  assert.equal(isReadOnlyTool({ name: 'send_withdrawal' }), false);
});

test('pipeline: discover -> call -> normalize -> report (offline, mocked transport)', async () => {
  const history = [
    { tradeId: 1, side: 'BUY', baseAsset: 'BTC', executedQty: '1', quoteAsset: 'USDT', cummulativeQuoteQty: '100', time: 1_672_531_200_000, subAccountId: 'agentic-001' }, // 2023-01-01
    { tradeId: 2, side: 'SELL', baseAsset: 'BTC', executedQty: '1', quoteAsset: 'USDT', cummulativeQuoteQty: '600', time: 1_717_200_000_000, subAccountId: 'agentic-001' }, // 2024-06-01
  ];

  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    const reply = (result) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) });
    if (msg.method === 'initialize') return reply({ serverInfo: { name: 'agent-os' } });
    if (msg.method === 'notifications/initialized') return { status: 202, ok: true, headers: { get: () => null }, text: async () => '' };
    if (msg.method === 'tools/list') return reply({ tools: [{ name: 'get_transaction_history', inputSchema: { properties: { accountId: {}, startTime: {}, endTime: {} } } }, { name: 'get_balances' }] });
    if (msg.method === 'tools/call' && msg.params.name === 'get_transaction_history') return reply({ content: [{ type: 'text', text: JSON.stringify({ transactions: history }) }] });
    if (msg.method === 'tools/call' && msg.params.name === 'get_balances') return reply({ content: [{ type: 'text', text: JSON.stringify({ balances: [{ asset: 'BTC', free: '0' }] }) }] });
    throw new Error(`unexpected ${msg.method}`);
  };

  const { report, provenance } = await buildTaxReportFromAgentOS({ token: 'tok', fetchImpl, taxYear: 2024, accountId: 'agentic-001' });

  assert.equal(provenance.historyTool, 'get_transaction_history');
  assert.equal(provenance.recordCount, 2);
  assert.equal(provenance.normalized, 2);
  assert.equal(report.disposals.length, 1);
  assert.equal(report.totals.basis, 100);
  assert.equal(report.totals.gains, 500);
  assert.ok(Array.isArray(provenance.balances));
  assert.equal(provenance.complete, true);
});

test('pipeline: unpriced disposals are flagged, never invented', async () => {
  const history = [{ id: 's1', type: 'staking-reward', asset: 'BNB', amount: '0.08', time: 1_744_711_200_000 }];
  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    const reply = (result) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) });
    if (msg.method === 'initialize') return reply({});
    if (msg.method === 'notifications/initialized') return { status: 202, ok: true, headers: { get: () => null }, text: async () => '' };
    if (msg.method === 'tools/list') return reply({ tools: [{ name: 'transaction_history' }] });
    if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: JSON.stringify(history) }] });
    throw new Error('unexpected');
  };
  // No price provider passed and no global-fetch dependency in the assertion path:
  const { provenance } = await buildTaxReportFromAgentOS({
    token: 'tok', fetchImpl, taxYear: 2025,
    priceProvider: { priceOn: async () => null },
  });
  assert.equal(provenance.unpriced.length, 1);
  assert.match(provenance.warnings.join(' '), /could not be valued/);
});

test('selectBinanceHistoryTools returns matched registry entries with tool objects', () => {
  const discovered = [
    { name: 'spot_myTrades', inputSchema: { properties: { symbol: {} } } },
    { name: 'wallet_depositHistory', inputSchema: { properties: {} } },
    { name: 'some_other_tool' },
  ];
  const matched = selectBinanceHistoryTools(discovered);
  assert.equal(matched.length, 2);
  assert.equal(matched[0].name, 'spot_myTrades');
  assert.equal(matched[0].category, 'spot_trades');
  assert.equal(matched[0].tool.name, 'spot_myTrades');
  assert.equal(matched[1].name, 'wallet_depositHistory');
  assert.equal(matched[1].typeHint, 'deposit');
});

test('selectBinanceHistoryTools returns empty when no Binance tools present', () => {
  const discovered = [{ name: 'get_transaction_history' }, { name: 'get_balances' }];
  assert.equal(selectBinanceHistoryTools(discovered).length, 0);
});

test('pipeline: Binance multi-source pull merges spot trades and deposits', async () => {
  const spotTrade = { id: 'trade-1', isBuyer: true, symbol: 'BTCUSDT', qty: '0.5', cummulativeQuoteQty: '25000', time: 1_672_531_200_000 };
  const deposit  = { txId: 'dep-1', coin: 'ETH', amount: '2', insertTime: 1_672_617_600_000 };

  function makeFetch({ spotRecords, depositRecords }) {
    return async (url, init) => {
      const msg = JSON.parse(init.body);
      const reply = (result) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) });
      if (msg.method === 'initialize') return reply({ serverInfo: { name: 'binance-agent-os' } });
      if (msg.method === 'notifications/initialized') return { status: 202, ok: true, headers: { get: () => null }, text: async () => '' };
      if (msg.method === 'tools/list') return reply({
        tools: [
          { name: 'spot_myTrades', inputSchema: { properties: { startTime: {}, endTime: {} } } },
          { name: 'wallet_depositHistory', inputSchema: { properties: { startTime: {}, endTime: {} } } },
        ],
      });
      if (msg.method === 'tools/call' && msg.params.name === 'spot_myTrades')
        return reply({ content: [{ type: 'text', text: JSON.stringify(spotRecords) }] });
      if (msg.method === 'tools/call' && msg.params.name === 'wallet_depositHistory')
        return reply({ content: [{ type: 'text', text: JSON.stringify(depositRecords) }] });
      throw new Error(`unexpected ${msg.method} / ${msg.params?.name}`);
    };
  }

  const fetchImpl = makeFetch({ spotRecords: [spotTrade], depositRecords: [deposit] });
  const { provenance } = await buildTaxReportFromAgentOS({
    token: 'tok', fetchImpl, taxYear: 2023,
    priceProvider: { priceOn: async () => null },
  });

  assert.deepEqual(provenance.historyTools, ['spot_myTrades', 'wallet_depositHistory']);
  assert.equal(provenance.historyTool, 'spot_myTrades');
  assert.equal(provenance.sourceBreakdown.spot_trades, 1);
  assert.equal(provenance.sourceBreakdown.deposits, 1);
  assert.equal(provenance.recordCount, 2);
  assert.equal(provenance.normalized, 2);
});

test('pipeline: Binance multi-source survives one tool failure and still returns records', async () => {
  const deposit = { txId: 'dep-2', coin: 'BTC', amount: '0.1', insertTime: 1_672_531_200_000 };

  const fetchImpl = async (url, init) => {
    const msg = JSON.parse(init.body);
    const reply = (result) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) });
    if (msg.method === 'initialize') return reply({});
    if (msg.method === 'notifications/initialized') return { status: 202, ok: true, headers: { get: () => null }, text: async () => '' };
    if (msg.method === 'tools/list') return reply({
      tools: [
        { name: 'spot_myTrades', inputSchema: { properties: {} } },
        { name: 'wallet_depositHistory', inputSchema: { properties: {} } },
      ],
    });
    if (msg.method === 'tools/call' && msg.params.name === 'spot_myTrades')
      return { status: 500, ok: false, headers: { get: () => null }, text: async () => 'error' };
    if (msg.method === 'tools/call' && msg.params.name === 'wallet_depositHistory')
      return reply({ content: [{ type: 'text', text: JSON.stringify([deposit]) }] });
    throw new Error(`unexpected ${msg.method}`);
  };

  const { provenance } = await buildTaxReportFromAgentOS({
    token: 'tok', fetchImpl, taxYear: 2023,
    priceProvider: { priceOn: async () => null },
  });

  assert.equal(provenance.recordCount, 1);
  assert.ok(provenance.warnings.some((w) => /Source pull failed/i.test(w)));
});
