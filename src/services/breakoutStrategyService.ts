import { StockData } from '../types';
import { Server } from 'socket.io';

/**
 * Stock-options intraday breakout strategy (Dhan-only).
 *
 * Design notes / fixes vs. the previous version:
 *  - Single broker: all live execution flows through an injected Dhan order
 *    executor (see setOrderExecutor). No Kotak, no Fyers symbol generation.
 *  - Real data: live OI / IV / Greeks / per-strike securityId come from the
 *    injected option-chain resolver (Dhan Option Chain API). The entry trigger
 *    only treats OI build-up as confirmation when that data is REAL.
 *  - Simulation is fully isolated to injectSimulatedMarketMove() and is clearly
 *    labelled. It never produces fake "OI confirmation" for a live trigger.
 *  - Stops are anchored to the UNDERLYING (loss of VWAP), with a premium hard
 *    stop as a backstop, plus a hard intraday TIME stop.
 *  - Position size is derived from capital x risk%, rounded to lot multiples.
 *  - Paper trading is the default until explicitly switched to live.
 */

export type OrderExecutor = (req: {
  symbol: string;
  securityId?: string;
  side: 'BUY' | 'SELL';
  qty: number;
  orderType?: 'MARKET' | 'LIMIT';
  price?: number;
  productType?: 'INTRADAY' | 'MARGIN' | 'CNC';
  underlying?: string;
}) => Promise<{ success: boolean; orderId?: string; message: string; details?: any }>;

export type OptionResolver = (
  underlyingSymbol: string,
  optionType: 'CE' | 'PE',
  strikeOffset?: number,
  preferExpiry?: string
) => Promise<{
  underlying: string; expiry: string; strike: number; spot: number;
  optionType: 'CE' | 'PE'; securityId: string; ltp: number;
  oi: number; previousOi: number; iv: number;
  greeks: { delta: number; theta: number; gamma: number; vega: number };
  bid: number; ask: number; volume: number;
} | null>;

export interface BreakoutTarget {
  symbol: string;
  type: 'BULLISH_BREAKOUT' | 'BEARISH_BREAKOUT';
  spotPrice: number;
  initialSpotPrice: number;
  morningHigh: number;
  morningLow: number;
  pChange: number;
  vwap: number;
  ema20: number;
  support: number;
  resistance: number;
  dayHigh: number;
  dayLow: number;

  optionSymbol: string;
  optionType: 'CE' | 'PE';
  strike: number;
  expiry: string;
  securityId: string;
  lotSize: number;
  optionPrice: number;
  optionInitialPrice: number;
  optionPriceHigh: number;
  optionOI: number;
  optionOIPeak: number;
  optionOIEntry: number;            // OI snapshot when pullback became active
  optionOIBuiltupPercentage: number;
  iv: number;
  delta: number;
  theta: number;
  bidAskSpreadPct: number;
  historicalOI: { time: string; oi: number; price: number }[];
  optionDayHigh: number;
  optionDayLow: number;

  liveData: boolean;                // true when fed by Dhan option chain
  pullbackActive: boolean;
  pullbackPrice: number;
  underlyingStop: number;           // spot level that invalidates the trade
  setupTriggered: boolean;
  tradeExecuted: boolean;
  triggerReason: string;
  entryPrice?: number;
  entryTime?: number;
  qty?: number;
  exitPrice?: number;
  exitReason?: string;
  pnl?: number;
  brokerOrderId?: string;
}

export class BreakoutStrategyService {
  private io: Server;
  public isEnabled = false;
  public autoTrigger = true;
  public targets: BreakoutTarget[] = [];
  public dailyTradesCount = 0;
  public maxTradesPerDay = 3;
  public scanTimestamp = 0;
  public isMockData = true;
  public paperTradingMode = true;   // PAPER until explicitly switched live

  // Risk / sizing config
  public capital = 200000;          // deployable capital (₹)
  public riskPerTradePct = 1.5;     // % of capital risked per trade
  public targetRR = 2.0;            // reward:risk on premium
  public premiumStopPct = 25;       // hard premium stop (backstop)
  public ivMaxAbsolute = 70;        // skip entries when IV too rich (basic guard)
  public timeStopIST = '15:00';     // force-exit any open trade by this time
  public noNewEntryAfterIST = '14:30';

  private orderExecutor: OrderExecutor | null = null;
  private optionResolver: OptionResolver | null = null;
  private lastLegRefresh = new Map<string, number>();

  constructor(io: Server) {
    this.io = io;
  }

  // ---- wiring (called by server) ----
  public setOrderExecutor(fn: OrderExecutor) { this.orderExecutor = fn; }
  public setOptionResolver(fn: OptionResolver) { this.optionResolver = fn; }

  public setPaperTradingMode(enabled: boolean) { this.paperTradingMode = enabled; this.emitStatus(); }
  public setEnabled(enabled: boolean) { this.isEnabled = enabled; this.emitStatus(); }
  public setAutoTrigger(enabled: boolean) { this.autoTrigger = enabled; this.emitStatus(); }
  public setRiskConfig(cfg: Partial<{ capital: number; riskPerTradePct: number; targetRR: number; premiumStopPct: number; maxTradesPerDay: number; }>) {
    Object.assign(this, cfg); this.emitStatus();
  }

  // ---- IST time helpers ----
  private istHHMM(d: Date = new Date()): string {
    return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  private pastIST(hhmm: string): boolean { return this.istHHMM() >= hhmm; }

  private getStrikeInterval(price: number): number {
    if (price < 100) return 2.5;
    if (price < 500) return 5;
    if (price < 1000) return 10;
    if (price < 2000) return 20;
    if (price < 5000) return 50;
    return 100;
  }

  // ---- position sizing (lot-aware) ----
  private computeQty(entryPremium: number, lotSize: number): number {
    const riskAmount = this.capital * (this.riskPerTradePct / 100);
    const premiumRisk = Math.max(0.05 * entryPremium, entryPremium * (this.premiumStopPct / 100));
    const riskPerLot = premiumRisk * lotSize;
    const lots = Math.max(1, Math.floor(riskAmount / Math.max(1, riskPerLot)));
    return lots * lotSize;
  }

  /**
   * Build candidate list from top gainers / losers (stock options focus).
   * Pulls the live ATM option leg from Dhan where possible.
   */
  public async runBreakoutScan(allStocks: StockData[]) {
    console.log('[BreakoutStrategy] Running stock-options breakout scan...');
    this.scanTimestamp = Date.now();
    this.targets = [];

    if (!allStocks || allStocks.length === 0) {
      console.warn('[BreakoutStrategy] No stocks supplied to scan.');
      this.emitStatus();
      return;
    }

    const equity = allStocks.filter(s => s.symbol && !s.symbol.includes('INDEX'));
    const sorted = [...equity].sort((a, b) => (b.pChange || 0) - (a.pChange || 0));
    const topGainers = sorted.slice(0, 5);
    const topLosers = sorted.slice(-5).reverse();

    for (const stock of topGainers) await this.addTarget(stock, 'BULLISH_BREAKOUT');
    for (const stock of topLosers) await this.addTarget(stock, 'BEARISH_BREAKOUT');

    console.log('[BreakoutStrategy] Targets:', this.targets.map(t => `${t.symbol}/${t.optionType}${t.liveData ? '(live)' : '(sim)'}`).join(', '));
    this.emitStatus();
    this.io.emit('bot-log', `SYSTEM: Scan complete. ${this.targets.length} stock-option targets (${this.targets.filter(t => t.liveData).length} live).`);
  }

  private async addTarget(stock: StockData, type: 'BULLISH_BREAKOUT' | 'BEARISH_BREAKOUT') {
    const basePri = stock.lastPrice || 1000;
    const optionType: 'CE' | 'PE' = type === 'BULLISH_BREAKOUT' ? 'CE' : 'PE';
    const now = new Date();
    const timeStr = this.istHHMM(now);
    const isBull = type === 'BULLISH_BREAKOUT';

    // Try live Dhan option leg (ATM). Falls back to synthetic if unavailable.
    let leg = null as Awaited<ReturnType<OptionResolver>> | null;
    if (this.optionResolver) {
      try { leg = await this.optionResolver(stock.symbol, optionType, 0); }
      catch (e: any) { console.warn(`[BreakoutStrategy] leg resolve failed for ${stock.symbol}:`, e.message); }
    }

    const strikeInterval = this.getStrikeInterval(basePri);
    const synthStrike = Math.round(basePri / strikeInterval) * strikeInterval;
    const synthPremium = Math.max(5, Math.round(basePri * 0.02 * 100) / 100);

    const live = !!leg;
    if (live) this.isMockData = false;

    const optionPrice = live ? leg!.ltp || synthPremium : synthPremium;
    const strike = live ? leg!.strike : synthStrike;
    const oi = live ? leg!.oi : (isBull ? 150000 : 120000);
    const lotSize = stock.lotSize && stock.lotSize > 0 ? stock.lotSize : 0; // 0 => resolved at order time
    const spread = live && leg!.ask > 0 ? ((leg!.ask - leg!.bid) / leg!.ask) * 100 : 0;

    const vwap = isBull ? basePri * 0.995 : basePri * 1.005;
    const optionSymbol = live
      ? `${stock.symbol}-${leg!.expiry}-${strike}-${optionType}`
      : `${stock.symbol}${synthStrike}${optionType}`;

    this.targets.push({
      symbol: stock.symbol,
      type,
      spotPrice: basePri,
      initialSpotPrice: basePri,
      morningHigh: basePri * (isBull ? 1.015 : 1.01),
      morningLow: basePri * (isBull ? 0.99 : 0.985),
      pChange: stock.pChange || 0,
      vwap,
      ema20: basePri * (isBull ? 0.998 : 1.002),
      support: basePri * (isBull ? 0.991 : 0.982),
      resistance: basePri * (isBull ? 1.018 : 1.012),
      dayHigh: basePri * (isBull ? 1.015 : 1.005),
      dayLow: basePri * (isBull ? 0.99 : 0.982),

      optionSymbol,
      optionType,
      strike,
      expiry: live ? leg!.expiry : '',
      securityId: live ? leg!.securityId : '',
      lotSize,
      optionPrice,
      optionInitialPrice: optionPrice,
      optionPriceHigh: optionPrice,
      optionOI: oi,
      optionOIPeak: oi,
      optionOIEntry: oi,
      optionOIBuiltupPercentage: 0,
      iv: live ? leg!.iv : 0,
      delta: live ? leg!.greeks.delta : 0,
      theta: live ? leg!.greeks.theta : 0,
      bidAskSpreadPct: Number(spread.toFixed(2)),
      historicalOI: [{ time: timeStr, oi, price: optionPrice }],
      optionDayHigh: optionPrice,
      optionDayLow: optionPrice,

      liveData: live,
      pullbackActive: false,
      pullbackPrice: 0,
      underlyingStop: vwap,
      setupTriggered: false,
      tradeExecuted: false,
      triggerReason: ''
    });
  }

  /**
   * Periodically refresh a target's live option leg (OI/IV/premium/greeks).
   * Throttled per-underlying to respect Dhan's option-chain rate limit (1/3s).
   */
  private refreshLeg(target: BreakoutTarget) {
    if (!this.optionResolver || !target.liveData) return;
    const last = this.lastLegRefresh.get(target.symbol) || 0;
    if (Date.now() - last < 4000) return;
    this.lastLegRefresh.set(target.symbol, Date.now());

    this.optionResolver(target.symbol, target.optionType, 0, target.expiry).then(leg => {
      if (!leg) return;
      target.optionPrice = leg.ltp || target.optionPrice;
      target.optionOI = leg.oi;
      target.iv = leg.iv;
      target.delta = leg.greeks.delta;
      target.theta = leg.greeks.theta;
      target.securityId = leg.securityId;
      if (leg.ask > 0) target.bidAskSpreadPct = Number((((leg.ask - leg.bid) / leg.ask) * 100).toFixed(2));
      if (target.optionOI > target.optionOIPeak) target.optionOIPeak = target.optionOI;
      if (target.optionPrice > target.optionPriceHigh) target.optionPriceHigh = target.optionPrice;
    }).catch(() => { /* ignore transient */ });
  }

  /**
   * Core per-tick evaluation. realQuotes carries spot ticks keyed by symbol.
   */
  public handleTickUpdates(realQuotes: Record<string, any>) {
    if (!this.isEnabled || this.targets.length === 0) return;
    const timeStr = this.istHHMM();
    let updated = false;

    for (const target of this.targets) {
      // Refresh live option data (throttled)
      this.refreshLeg(target);

      // Update spot from incoming ticks
      const eqSym = `NSE:${target.symbol}-EQ`;
      const quote = realQuotes[eqSym] || realQuotes[target.symbol];
      if (quote && quote.lp) {
        target.spotPrice = quote.lp;
        if (quote.avg_price) target.vwap = quote.avg_price;
        if (quote.chp !== undefined) target.pChange = quote.chp;
        updated = true;
      }

      const isBull = target.type === 'BULLISH_BREAKOUT';

      // --- Pullback / VWAP test detection ---
      if (isBull) {
        const hasRallied = target.dayHigh > target.initialSpotPrice * 1.005;
        if (!target.pullbackActive && hasRallied && target.spotPrice <= target.vwap * 1.001) {
          target.pullbackActive = true;
          target.pullbackPrice = target.spotPrice;
          target.optionOIEntry = target.optionOI;
          this.io.emit('bot-log', `STRATEGY: VWAP pullback active for ${target.symbol} (CE) @ ₹${target.spotPrice.toFixed(2)}`);
          updated = true;
        }
      } else {
        const hasFallen = target.dayLow < target.initialSpotPrice * 0.995;
        if (!target.pullbackActive && hasFallen && target.spotPrice >= target.vwap * 0.999) {
          target.pullbackActive = true;
          target.pullbackPrice = target.spotPrice;
          target.optionOIEntry = target.optionOI;
          this.io.emit('bot-log', `STRATEGY: VWAP retest active for ${target.symbol} (PE) @ ₹${target.spotPrice.toFixed(2)}`);
          updated = true;
        }
      }

      // OI build-up % since pullback (real when live; in sim it stays ~0 and is NOT used as a gate)
      if (target.optionOIEntry > 0) {
        target.optionOIBuiltupPercentage = ((target.optionOI - target.optionOIEntry) / target.optionOIEntry) * 100;
      }
      if (target.historicalOI.length === 0 || target.historicalOI[target.historicalOI.length - 1].time !== timeStr) {
        target.historicalOI.push({ time: timeStr, oi: target.optionOI, price: target.optionPrice });
        if (target.historicalOI.length > 30) target.historicalOI.shift();
      }
      if (target.optionPrice > target.optionPriceHigh) target.optionPriceHigh = target.optionPrice;

      // --- Entry trigger ---
      if (target.pullbackActive && !target.setupTriggered) {
        const reclaim = isBull
          ? target.spotPrice > target.vwap * 1.003
          : target.spotPrice < target.vwap * 0.997;

        // OI confirmation only enforced when we have LIVE data.
        const oiConfirms = target.liveData ? target.optionOIBuiltupPercentage > 2.0 : true;
        // Basic IV richness guard (only when live)
        const ivOk = !target.liveData || target.iv === 0 || target.iv <= this.ivMaxAbsolute;
        // Liquidity guard (only when live)
        const liquid = !target.liveData || target.bidAskSpreadPct === 0 || target.bidAskSpreadPct <= 4;
        const noNewEntry = this.pastIST(this.noNewEntryAfterIST);

        if (reclaim && oiConfirms && ivOk && liquid && !noNewEntry) {
          target.setupTriggered = true;
          target.underlyingStop = isBull
            ? Math.min(target.vwap, target.pullbackPrice) * 0.999
            : Math.max(target.vwap, target.pullbackPrice) * 1.001;
          target.triggerReason =
            `${isBull ? 'Bullish VWAP reclaim' : 'Bearish VWAP rejection'} @ spot ₹${target.spotPrice.toFixed(2)} (VWAP ₹${target.vwap.toFixed(2)})`
            + (target.liveData ? `, +${target.optionOIBuiltupPercentage.toFixed(1)}% OI, IV ${target.iv.toFixed(1)}` : ' [SIM]');
          this.io.emit('bot-log', `STRATEGY TRIGGERED: ${target.symbol} BUY ${target.optionType}. ${target.triggerReason}`);
          updated = true;

          if (this.autoTrigger && this.dailyTradesCount < this.maxTradesPerDay) {
            this.executeEntry(target);
          }
        } else if (reclaim && noNewEntry) {
          this.io.emit('bot-log', `STRATEGY: ${target.symbol} reclaim seen but past no-entry cutoff (${this.noNewEntryAfterIST}). Skipped.`);
        }
      }

      // Track day extremes
      target.dayHigh = Math.max(target.dayHigh || target.spotPrice, target.spotPrice);
      target.dayLow = Math.min(target.dayLow || target.spotPrice, target.spotPrice);
      target.optionDayHigh = Math.max(target.optionDayHigh || target.optionPrice, target.optionPrice);
      target.optionDayLow = Math.min(target.optionDayLow || target.optionPrice, target.optionPrice);

      // --- Exit management ---
      if (target.tradeExecuted && target.entryPrice && !target.exitPrice) {
        const lot = target.lotSize || 1;
        const sizeQty = target.qty || lot;
        target.pnl = (target.optionPrice - target.entryPrice) * sizeQty;
        const pnlPct = ((target.optionPrice - target.entryPrice) / target.entryPrice) * 100;
        const targetPct = this.premiumStopPct * this.targetRR;

        // 1) Underlying invalidation (primary stop)
        const underlyingBroke = isBull
          ? target.spotPrice < target.underlyingStop
          : target.spotPrice > target.underlyingStop;

        if (underlyingBroke) {
          this.closeTrade(target, 'STOP_UNDERLYING', `Spot lost ${isBull ? 'VWAP/pullback' : 'VWAP/retest'} level (₹${target.underlyingStop.toFixed(2)})`);
        } else if (pnlPct <= -this.premiumStopPct) {
          this.closeTrade(target, 'STOP_PREMIUM', `Premium hard stop -${this.premiumStopPct}%`);
        } else if (pnlPct >= targetPct) {
          this.closeTrade(target, 'TARGET', `Target +${targetPct.toFixed(0)}% reached`);
        } else if (this.pastIST(this.timeStopIST)) {
          this.closeTrade(target, 'TIME_STOP', `Intraday time stop (${this.timeStopIST})`);
        }
        updated = true;
      }
    }

    if (updated) this.emitStatus();
  }

  private executeEntry(target: BreakoutTarget) {
    target.entryPrice = target.optionPrice;
    target.entryTime = Date.now();
    const lot = target.lotSize || 1;
    target.qty = this.computeQty(target.optionPrice, lot);
    target.tradeExecuted = true;
    this.dailyTradesCount++;

    if (this.paperTradingMode || !this.orderExecutor) {
      this.io.emit('bot-log', `📝 PAPER BUY ${target.qty} ${target.optionSymbol} @ ₹${target.optionPrice} (${target.symbol})`);
      return;
    }

    // LIVE: route through the single safe Dhan executor.
    this.io.emit('bot-log', `LIVE: placing Dhan order — BUY ${target.qty} ${target.optionSymbol}...`);
    this.orderExecutor({
      symbol: target.optionSymbol,
      securityId: target.securityId || undefined,
      side: 'BUY',
      qty: target.qty,
      orderType: 'MARKET',
      productType: 'INTRADAY',
      underlying: target.symbol
    }).then(result => {
      if (result.success) {
        target.brokerOrderId = result.orderId;
        this.io.emit('bot-log', `LIVE ✅ Dhan order accepted (${result.orderId}) for ${target.optionSymbol}`);
      } else {
        // Failure must NOT look like a fill — roll back the executed flag.
        target.tradeExecuted = false;
        target.entryPrice = undefined;
        this.dailyTradesCount = Math.max(0, this.dailyTradesCount - 1);
        this.io.emit('bot-log', `LIVE ❌ Dhan REJECTED order for ${target.optionSymbol}: ${result.message}`);
      }
      this.emitStatus();
    }).catch(err => {
      target.tradeExecuted = false;
      target.entryPrice = undefined;
      this.dailyTradesCount = Math.max(0, this.dailyTradesCount - 1);
      this.io.emit('bot-log', `LIVE ❌ Order error for ${target.optionSymbol}: ${err.message}`);
      this.emitStatus();
    });
  }

  private closeTrade(target: BreakoutTarget, reason: string, detail: string) {
    target.exitPrice = target.optionPrice;
    target.exitReason = reason;
    const sizeQty = target.qty || target.lotSize || 1;
    target.pnl = (target.optionPrice - (target.entryPrice || 0)) * sizeQty;
    const tag = reason === 'TARGET' ? '🎯' : reason === 'TIME_STOP' ? '⏱️' : '🛑';

    if (!this.paperTradingMode && this.orderExecutor && target.brokerOrderId) {
      this.orderExecutor({
        symbol: target.optionSymbol,
        securityId: target.securityId || undefined,
        side: 'SELL',
        qty: sizeQty,
        orderType: 'MARKET',
        productType: 'INTRADAY',
        underlying: target.symbol
      }).then(r => {
        this.io.emit('bot-log', `LIVE EXIT ${r.success ? '✅' : '❌'} ${target.optionSymbol}: ${r.message}`);
      }).catch(() => {});
    }

    this.io.emit('bot-log', `${tag} EXIT ${target.symbol} (${reason}) @ ₹${target.optionPrice} | ${detail} | PnL ₹${target.pnl.toLocaleString('en-IN')}`);
    this.emitStatus();
  }

  // ---------------------------------------------------------------------------
  // SIMULATION ONLY — for paper testing without a live feed. Clearly isolated.
  // This produces a synthetic price/OI walk so the UI can be exercised. It is
  // never used to confirm a live signal.
  // ---------------------------------------------------------------------------
  public injectSimulatedMarketMove() {
    if (this.targets.length === 0) return;
    for (const target of this.targets) {
      if (target.liveData) continue; // never fabricate over real data
      const dir = target.type === 'BULLISH_BREAKOUT' ? 1 : -1;
      if (!target.pullbackActive) {
        target.spotPrice += (Math.random() * 0.4 - 0.75) * dir;
      } else if (!target.setupTriggered) {
        target.spotPrice += (Math.random() * 0.5 - 0.25) * dir;
      } else if (target.tradeExecuted && !target.exitPrice) {
        target.spotPrice += (Math.random() > 0.35 ? 1 : -1) * (Math.random() * 0.6 + 0.1) * dir;
        // crude premium proxy follows spot move via assumed delta 0.5
        const move = (target.spotPrice - target.initialSpotPrice) * 0.5 * dir;
        target.optionPrice = Math.max(0.5, target.optionInitialPrice + move);
      } else {
        target.spotPrice += Math.random() * 0.4 - 0.2;
      }
    }
    this.handleTickUpdates({});
  }

  public forceTriggerSetup(symbol: string) {
    const target = this.targets.find(t => t.symbol === symbol);
    if (target && !target.setupTriggered) {
      target.pullbackActive = true;
      target.setupTriggered = true;
      target.underlyingStop = target.type === 'BULLISH_BREAKOUT' ? target.vwap * 0.999 : target.vwap * 1.001;
      target.triggerReason = 'Manual operator trigger.';
      this.io.emit('bot-log', `STRATEGY MANUAL: Triggered ${target.symbol}`);
      if (this.autoTrigger && !target.tradeExecuted && this.dailyTradesCount < this.maxTradesPerDay) {
        this.executeEntry(target);
      }
      this.emitStatus();
    }
  }

  public forceCloseSetup(symbol: string) {
    const target = this.targets.find(t => t.symbol === symbol);
    if (target && target.tradeExecuted && !target.exitPrice) {
      this.closeTrade(target, 'MANUAL', 'Operator manual close');
    }
  }

  public emitStatus() {
    this.io.emit('breakout-strategy', {
      isEnabled: this.isEnabled,
      autoTrigger: this.autoTrigger,
      paperTradingMode: this.paperTradingMode,
      targets: this.targets,
      dailyTradesCount: this.dailyTradesCount,
      maxTradesPerDay: this.maxTradesPerDay,
      scanTimestamp: this.scanTimestamp,
      isMockData: this.isMockData,
      config: {
        capital: this.capital,
        riskPerTradePct: this.riskPerTradePct,
        targetRR: this.targetRR,
        premiumStopPct: this.premiumStopPct,
        timeStopIST: this.timeStopIST,
        noNewEntryAfterIST: this.noNewEntryAfterIST
      }
    });
  }
}
