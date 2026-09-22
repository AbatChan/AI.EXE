const fs = require('fs');
const js = fs.readFileSync('ui/ai-exe.js', 'utf8');
const html = fs.readFileSync('ui/ai-exe.html', 'utf8');
const css = fs.readFileSync('ui/ai-exe.css', 'utf8');

if (!js.includes("`${websocketBase}/api/broker/live-stream") || !js.includes('new WebSocket(socketUrl, backendAccess.socketProtocols(socketUrl))')) throw new Error('market WebSocket missing or sent without the backend token');
if (js.includes('refreshing every 10 seconds')) throw new Error('old polling copy remains');
if (!js.includes("{ id: 'trading', label: 'Portfolio' }")) throw new Error('Portfolio tab missing');
if (!js.includes("{ id: 'business', label: 'Business records' }")) throw new Error('Business records tab missing');
if (js.includes("{ id: 'mining', label: 'Mining' }")) throw new Error('Mining is still visible');
if (!js.includes('Advanced paper controls')) throw new Error('advanced controls are not collapsed');
if (!js.includes("/api/prices/search?q=")) throw new Error('company and symbol search missing');
if (!js.includes('Search company or symbol')) throw new Error('asset combobox missing');
if (!js.includes('CandlestickSeries')) throw new Error('interactive candlestick chart missing');
if (!js.includes('LineSeries')) throw new Error('compact live price trace missing');
if (!js.includes('observeFinanceChartHost(host)')) throw new Error('chart does not observe its visible size');
if (!js.includes('visibleWidth <= 0 || host.clientHeight <= 0')) throw new Error('hidden chart is still created without dimensions');
if (!js.includes('financeChartVisibleWidth(host)')) throw new Error('chart does not measure its unclipped workspace width');
if (!js.includes('requestAnimationFrame(() => {')) throw new Error('chart does not repaint after hidden preload');
if (!js.includes('financeChartNeedsVisibleRebuild')) throw new Error('hidden preload chart is not rebuilt on first reveal');
if (!js.includes("financeDashboard && !financeDashboard.classList.contains('hidden')")) throw new Error('visible finance view does not finish an in-flight warm-up');
if (!js.includes('financeChartNeedsVisibleRebuild = true;')) throw new Error('background handoff does not arm chart recovery');
if (!js.includes('financeLiveCache.delete(financeLiveSymbol);')) throw new Error('background handoff replays a stale chart snapshot');
if (!js.includes('let shellCreated = false;')) throw new Error('recreated market shell does not defer chart layout');
if (!js.includes('const rebuildVisibleChart = financeChartNeedsVisibleRebuild')) throw new Error('first recovered payload does not repaint the visible chart');
if (js.includes('width: host.clientWidth || 760')) throw new Error('hidden chart still uses a clipping fallback width');
if (!js.includes('Scroll to zoom · drag to pan')) throw new Error('chart interaction help missing');
if (!js.includes('FINANCE_LIVE_SYMBOL_KEY')) throw new Error('selected market is not persisted');
if (!js.includes("financeLiveSymbol = String(localStorage.getItem(FINANCE_LIVE_SYMBOL_KEY) || (positions.length ? positions[0].symbol : FINANCE_DEFAULT_ASSETS[0].symbol))")) throw new Error('market default does not fall back to the first quick pick');
if (js.includes("requestedSymbol = 'AAPL'") || js.includes("let financeLiveSymbol = 'AAPL'")) throw new Error('a hardcoded symbol still overrides the first quick pick');
if (!js.includes('brokerPortfolioEquity')) throw new Error('live paper portfolio mark missing');
if (!js.includes('brokerPortfolioReturn')) throw new Error('live total return sync missing');
if (!js.includes('brokerMeasuredDaily')) throw new Error('daily performance sync missing');
if (!js.includes('brokerLedgerNote')) throw new Error('ledger summary sync missing');
if (!js.includes('Post-start fills')) throw new Error('forward test does not disclose simulated fills');
if (!js.includes('forward.strategy_costs_cents')) throw new Error('forward test does not disclose modeled costs');
if (!js.includes('difference ${pct(Number(test.total_return_bps || 0) - Number(benchmark.total_return_bps || 0))}')) throw new Error('historical benchmark difference missing');
if (!js.includes('portfolio.starting_cash_cents')) throw new Error('live return lacks its starting balance');
if (!js.includes('finance-business-pane')) throw new Error('Business Records has no dedicated layout scope');
if (!js.includes('finance-business-kpis')) throw new Error('Business Records KPIs have no balanced grid');
if (!css.includes('.finance-business-pane .finance-control-grid')) throw new Error('Business Records forms are not full width');
if (!css.includes('.broker-advanced-panel .finance-control-grid { grid-template-columns: minmax(0, 1fr);')) throw new Error('Trading controls are not full width');
if (!css.includes('.strategy-card-grid { grid-template-columns: repeat(2, minmax(0, 1fr));')) throw new Error('Strategy summary cards are not balanced');
if (!css.includes('.broker-portfolio-grid { grid-template-columns: repeat(2, minmax(0, 1fr));')) throw new Error('Portfolio summary cards are not balanced');
if (!js.includes('financeAutoCollapsedExplorer')) throw new Error('finance Explorer ownership state missing');
if (!js.includes("expanded ? '×' : 'Expand'")) throw new Error('expanded chart has no compact close action');
if (!js.includes("formatFinanceDate(report.to_date, '', true)")) throw new Error('research date range omits its end year');
if (!js.includes('formatFinanceDateTime')) throw new Error('finance timestamps are not human-formatted');
if (!js.includes('financeOrdinal')) throw new Error('friendly ordinal dates are missing');
if (!js.includes('syncExplorerForMiddleView();')) throw new Error('Explorer does not follow the active workspace');
if (!js.includes("if (middleViewMode === 'finance')")) throw new Error('Trading does not auto-collapse Explorer');
if (!js.includes("{ symbol: 'BTC-USD', name: 'Bitcoin'")) throw new Error('default crypto picks missing');
if (!html.includes('lightweight-charts.standalone.production.js')) throw new Error('chart library is not loaded');
const tabSwitch = js.slice(js.indexOf('function setFinanceTab'), js.indexOf('// A staged order'));
if (tabSwitch.includes('stopBrokerLiveUpdates()')) throw new Error('switching tabs still stops the market stream');
if (!js.includes("financeActiveTab = 'autopilot';\n  middleViewMode = 'finance'")) throw new Error('Trading nav does not open on the Autopilot tab');
if (!html.includes('<h1>Trading</h1>')) throw new Error('Trading is not the workspace title');
// Loading states are skeletons of the real layout, never bare text placeholders.
if (js.includes('class="finance-loading"')) throw new Error('finance still uses text loading placeholders');
if (!js.includes('function marketStreamSkeleton')) throw new Error('market stream skeleton missing');
if (!js.includes('marketStreamSkeleton(financeLiveSymbol)')) throw new Error('market stream open state has no skeleton');
if (!js.includes("marketStreamSkeleton(financeLiveSymbol, 'Reconnecting market stream…')")) throw new Error('market reconnect has no skeleton');
if (!js.includes('financeDashboardSkeleton()')) throw new Error('finance dashboard load has no skeleton');
if (!js.includes('brokerPanelSkeleton()')) throw new Error('paper portfolio load has no skeleton');
if (!js.includes('strategyLabSkeleton(symbol)')) throw new Error('strategy test run has no skeleton');
if (!js.includes('<div class="broker-watchlist" aria-label="Quick picks">')) throw new Error('skeleton drops the static watchlist frame');
if (!css.includes('.skel-chart')) throw new Error('chart skeleton style missing');
if (!css.includes('animation: workspaceSkeletonSweep')) throw new Error('skeleton shimmer is not shared with the workspace tree');
// A skeleton that looks like the real shell blocks the real shell from ever being built.
if (!js.includes("if (!host.querySelector('#brokerInteractiveChart')) {")) throw new Error('live shell detection can be spoofed by its own skeleton');
const marketSkeletonBody = js.slice(js.indexOf('function marketStreamSkeleton'), js.indexOf('async function renderFinanceDashboard'));
for (const marker of ['brokerInteractiveChart', 'brokerLivePrice', 'brokerLiveEquity', 'brokerLiveStatus']) {
  if (marketSkeletonBody.includes(marker)) throw new Error(`market skeleton must not reuse the live id ${marker}`);
}

// A symbol switch must not tear down the terminal, and a dead feed must back off.
if (!js.includes('function markMarketPanelLoading')) throw new Error('in-place market loading state missing');
if (!js.includes("else if (host.querySelector('#brokerInteractiveChart')) markMarketPanelLoading(host, financeLiveSymbol);")) throw new Error('symbol switch still rebuilds the whole market panel');
if (!js.includes("host.classList.remove('broker-live-loading');")) throw new Error('loading state is never cleared');
if (!js.includes('retryMs = Math.min(retryMs * 2, 30000);')) throw new Error('failed market stream does not back off');
if (!js.includes('brokerRetryNote')) throw new Error('retry countdown is not shown with the failure');
if (!css.includes('.broker-live-loading')) throw new Error('in-place loading style missing');

// An order price may never come from the cache.
if (!js.includes('/api/prices/quote?fresh=1&symbols=')) throw new Error('order staging can still take a cached price');
if (js.includes('cached, feed unreachable')) throw new Error('a cached price is still offered as an order price');

// The age of the price you are approving must be visible, and an old one deliberate.
if (!js.includes('function financePriceAge')) throw new Error('staged price age helper missing');
if (!js.includes('broker-price-age')) throw new Error('confirmation card does not show the price age');
if (!js.includes('if (age.stale && !armed)')) throw new Error('an old staged price fills on a single click');
if (!js.includes('refreshFinancePriceAges(document);')) throw new Error('price age goes stale on screen');
if (!css.includes('.broker-price-age.stale')) throw new Error('old price is not visually flagged');

console.log('trading stream static test: ok');
