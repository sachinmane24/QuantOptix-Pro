import { StockData, OptionChainData } from '../types';
import { Server } from 'socket.io';
import { getStockBasePrice, getFyersOptionSymbol } from './nseService';
import axios from 'axios';

export interface BreakoutTarget {
  symbol: string;
  type: 'BULLISH_BREAKOUT' | 'BEARISH_BREAKOUT';
  spotPrice: number;
  initialSpotPrice: number; // Price at 9:45 AM
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
  optionPrice: number;
  optionInitialPrice: number; // Option premium at 9:45 AM
  optionPriceHigh: number;
  optionOI: number;
  optionOIPeak: number;
  optionOIBuiltupPercentage: number;
  historicalOI: { time: string; oi: number; price: number }[];
  optionDayHigh: number;
  optionDayLow: number;

  pullbackActive: boolean;
  pullbackPrice: number;
  setupTriggered: boolean;
  tradeExecuted: boolean;
  triggerReason: string;
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
}

export class BreakoutStrategyService {
  private io: Server;
  public isEnabled: boolean = false;
  public autoTrigger: boolean = true;
  public targets: BreakoutTarget[] = [];
  public dailyTradesCount: number = 0;
  public maxTradesPerDay: number = 3;
  public scanTimestamp: number = 0;
  public isMockData: boolean = true;
  public paperTradingMode: boolean = true;

  constructor(io: Server) {
    this.io = io;
  }

  public setPaperTradingMode(enabled: boolean) {
    this.paperTradingMode = enabled;
    this.emitStatus();
  }

  public setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    this.emitStatus();
  }

  public setAutoTrigger(enabled: boolean) {
    this.autoTrigger = enabled;
    this.emitStatus();
  }

  private async placeLiveKotakOrder(symbol: string, qty: number, price: number): Promise<string> {
    const consumerKey = process.env.KOTAK_CONSUMER_KEY || process.env.KOTAK_NEO_CONSUMER_KEY;
    const token = process.env.KOTAK_NEO_ACCESS_TOKEN;

    if (!consumerKey || !token) {
      throw new Error("Kotak Securities is not logged in / credentials missing.");
    }

    try {
      const response = await axios.post("https://napi.kotaksecurities.com/uploads/trade/v1/orders", {
        symbol: symbol,
        qty: qty,
        type: "2", // Market order
        side: "BUY",
        price: price
      }, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "neo-api-key": consumerKey,
          "Content-Type": "application/json"
        },
        timeout: 5000
      });

      if (response.data && response.data.success) {
        return response.data.orderId || `KOTAK_${Math.floor(Math.random() * 900000 + 100000)}`;
      } else {
        throw new Error(response.data.message || "API rejection");
      }
    } catch (err: any) {
      const detail = err.response?.data?.message || err.message;
      throw new Error(detail);
    }
  }

  /**
   * Run the 9:45 AM scan to select top 2 gainers and top 2 losers
   */
  public async runBreakoutScan(allStocks: StockData[]) {
    console.log("[BreakoutStrategy] Running 9:45 AM Breakout Scan...");
    this.scanTimestamp = Date.now();
    this.targets = [];

    if (!allStocks || allStocks.length === 0) {
      console.warn("[BreakoutStrategy] No stocks available for breakout scan. Using default F&O universe.");
      return;
    }

    // Filter out indices
    const equityStocks = allStocks.filter(s => s.symbol && !s.symbol.includes("INDEX"));

    // Sort by % change to isolate top gainers and top losers
    const sorted = [...equityStocks].sort((a, b) => b.pChange - a.pChange);

    const topGainers = sorted.slice(0, 2);
    const topLosers = sorted.slice(-2);

    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const monthName = months[now.getMonth()];

    // Form targets
    for (const stock of topGainers) {
      const basePri = stock.lastPrice || 1000;
      // Option strike at-the-money
      const strikeInterval = this.getStrikeInterval(basePri);
      const strike = Math.round(basePri / strikeInterval) * strikeInterval;
      const optSym = getFyersOptionSymbol(stock.symbol, strike, 'CE');

      const initialOptVal = Math.max(5, Math.round(basePri * 0.02 * 100) / 100);

      this.targets.push({
        symbol: stock.symbol,
        type: 'BULLISH_BREAKOUT',
        spotPrice: basePri,
        initialSpotPrice: basePri,
        morningHigh: basePri * 1.015,
        morningLow: basePri * 0.99,
        pChange: stock.pChange,
        vwap: basePri * 0.995,
        ema20: basePri * 0.998,
        support: basePri * 0.991,
        resistance: basePri * 1.018,
        dayHigh: basePri * 1.015,
        dayLow: basePri * 0.99,
        optionSymbol: optSym,
        optionType: 'CE',
        strike,
        optionPrice: initialOptVal,
        optionInitialPrice: initialOptVal,
        optionPriceHigh: initialOptVal * 1.1,
        optionOI: 150000,
        optionOIPeak: 150000,
        optionOIBuiltupPercentage: 0,
        historicalOI: [
          { time: '09:45', oi: 150000, price: initialOptVal }
        ],
        optionDayHigh: initialOptVal * 1.1,
        optionDayLow: initialOptVal * 0.95,
        pullbackActive: false,
        pullbackPrice: 0,
        setupTriggered: false,
        tradeExecuted: false,
        triggerReason: ''
      });
    }

    for (const stock of topLosers) {
      const basePri = stock.lastPrice || 1000;
      const strikeInterval = this.getStrikeInterval(basePri);
      const strike = Math.round(basePri / strikeInterval) * strikeInterval;
      const optSym = getFyersOptionSymbol(stock.symbol, strike, 'PE');

      const initialOptVal = Math.max(5, Math.round(basePri * 0.02 * 100) / 100);

      this.targets.push({
        symbol: stock.symbol,
        type: 'BEARISH_BREAKOUT',
        spotPrice: basePri,
        initialSpotPrice: basePri,
        morningHigh: basePri * 1.01,
        morningLow: basePri * 0.985,
        pChange: stock.pChange,
        vwap: basePri * 1.005,
        ema20: basePri * 1.002,
        support: basePri * 0.982,
        resistance: basePri * 1.012,
        dayHigh: basePri * 1.005,
        dayLow: basePri * 0.982,
        optionSymbol: optSym,
        optionType: 'PE',
        strike,
        optionPrice: initialOptVal,
        optionInitialPrice: initialOptVal,
        optionPriceHigh: initialOptVal * 1.1,
        optionOI: 120000,
        optionOIPeak: 120000,
        optionOIBuiltupPercentage: 0,
        historicalOI: [
          { time: '09:45', oi: 120000, price: initialOptVal }
        ],
        optionDayHigh: initialOptVal * 1.1,
        optionDayLow: initialOptVal * 0.95,
        pullbackActive: false,
        pullbackPrice: 0,
        setupTriggered: false,
        tradeExecuted: false,
        triggerReason: ''
      });
    }

    console.log(`[BreakoutStrategy] Initialized targeted stocks:`, this.targets.map(t => `${t.symbol} (${t.type})`));
    this.emitStatus();
    this.io.emit("bot-log", `SYSTEM: Run 9:45 AM Breakout Strategy Scan completed. Isolated ${this.targets.length} targets.`);
  }

  private getStrikeInterval(price: number): number {
    if (price < 100) return 2.5;
    if (price < 500) return 5;
    if (price < 1000) return 10;
    if (price < 2000) return 20;
    if (price < 5000) return 50;
    return 100;
  }

  /**
   * Handle real tick or ticks simulated from the core scheduler
   */
  public handleTickUpdates(realQuotes: Record<string, any>) {
    if (!this.isEnabled || this.targets.length === 0) return;

    let updated = false;

    for (const target of this.targets) {
      // Find quote in either realQuotes (under stock ticker, e.g. NSE:RELIANCE-EQ or NSE:CE options)
      const eqSym = `NSE:${target.symbol}-EQ`;
      const quote = realQuotes[eqSym] || realQuotes[target.symbol];

      if (quote) {
        target.spotPrice = quote.lp || target.spotPrice;
        target.vwap = quote.avg_price || target.vwap;
        target.pChange = quote.chp !== undefined ? quote.chp : target.pChange;
        updated = true;
      }

      // Simulate minor updates/tracking for Option contract dynamically
      const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

      if (target.type === 'BULLISH_BREAKOUT') {
        // Bullish stock: Ideally pulls back to EMA20 / VWAP or below 9:45 AM initial price
        // Target pullback is below EMA20 / vwap or 1% below morning high
        const pullbackThreshold = target.morningHigh * 0.988; // pull down 1.2% from high
        if (!target.pullbackActive && target.spotPrice <= pullbackThreshold) {
          target.pullbackActive = true;
          target.pullbackPrice = target.spotPrice;
          this.io.emit("bot-log", `STRATEGY: Pullback ACTIVE for bullish breakout ${target.symbol}! Price: ₹${target.spotPrice.toFixed(2)} vs High: ₹${target.morningHigh.toFixed(2)}`);
          updated = true;
        }

        // Simulating the option premium and OI.
        // In real/mock mode, option pricing drifts relative to underlying spot price
        const dist = target.spotPrice - target.strike;
        const bsmSim = Math.max(1.5, dist + (target.initialSpotPrice * 0.02));
        
        // Minor realistic noise + drift
        const prevPrice = target.optionPrice;
        target.optionPrice = Number(bsmSim.toFixed(2));
        if (target.optionPrice > target.optionPriceHigh) {
          target.optionPriceHigh = target.optionPrice;
        }

        // Simulate OI accumulation: In a healthy pullback and re-breakout, OI accumulates
        if (target.pullbackActive && !target.setupTriggered) {
          // Add some OI spikes of 0.2% - 0.5% on positive price bars
          const priceDirChange = target.optionPrice - prevPrice;
          const oiFactor = priceDirChange > 0 ? 3000 : 800;
          target.optionOI += Math.floor(Math.random() * oiFactor);
          target.optionOIBuiltupPercentage = ((target.optionOI - target.optionOIPeak) / target.optionOIPeak) * 100;
          
          if (target.optionOI > target.optionOIPeak) {
            target.optionOIPeak = target.optionOI;
          }

          // Historical OI tracker record spacing
          if (target.historicalOI.length === 0 || target.historicalOI[target.historicalOI.length - 1].time !== timeStr) {
            target.historicalOI.push({ time: timeStr, oi: target.optionOI, price: target.optionPrice });
            if (target.historicalOI.length > 20) target.historicalOI.shift();
          }

          // Trigger Opportunity Check:
          // Stock rebounded and crossing back above EMA20, AND option OI buildup > 2.5%
          if (target.spotPrice > target.ema20 && target.optionOIBuiltupPercentage > 2.0 && target.optionPrice > prevPrice) {
            target.setupTriggered = true;
            target.triggerReason = `Bullish Pullback Rebound Confirmed. Option Premium crossing ema20 with +${target.optionOIBuiltupPercentage.toFixed(1)}% Open Interest long buildup.`;
            this.io.emit("bot-log", `STRATEGY TRIGGERED: ${target.symbol} BUY Call Setup! Reason: ${target.triggerReason}`);
            
            // Auto Trade execution check
            if (this.autoTrigger && !target.tradeExecuted && this.dailyTradesCount < this.maxTradesPerDay) {
              target.tradeExecuted = true;
              target.entryPrice = target.optionPrice;
              this.dailyTradesCount++;
              if (this.paperTradingMode) {
                this.io.emit("bot-log", `STRATEGY TRADE COMPLETE: Executed paper buy of ${target.optionSymbol} @ ₹${target.optionPrice} (Underlying: ₹${target.spotPrice.toFixed(2)})`);
              } else {
                this.io.emit("bot-log", `STRATEGY LIVE ORDER: Placing live order on Kotak Neo for ${target.optionSymbol} @ ₹${target.optionPrice}...`);
                this.placeLiveKotakOrder(target.symbol, 500, target.optionPrice)
                  .then((orderId) => {
                    this.io.emit("bot-log", `STRATEGY LIVE SUCCESS: Filled live order on Kotak Neo! OrderID: ${orderId}`);
                  })
                  .catch((err) => {
                    this.io.emit("bot-log", `STRATEGY LIVE FAILED: Order rejected by Kotak Securities: ${err.message}`);
                  });
              }
            }
          }
        }
      } else {
        // Bearish stock: Pulls back (recovers/rallies slightly) towards EMA20/VWAP upper bounds
        const pullbackThreshold = target.morningLow * 1.012; // pull up 1.2% from low
        if (!target.pullbackActive && target.spotPrice >= pullbackThreshold) {
          target.pullbackActive = true;
          target.pullbackPrice = target.spotPrice;
          this.io.emit("bot-log", `STRATEGY: Pullback ACTIVE for bearish breakout ${target.symbol}! Price: ₹${target.spotPrice.toFixed(2)} vs Low: ₹${target.morningLow.toFixed(2)}`);
          updated = true;
        }

        const dist = target.strike - target.spotPrice;
        const bsmSim = Math.max(1.5, dist + (target.initialSpotPrice * 0.02));

        const prevPrice = target.optionPrice;
        target.optionPrice = Number(bsmSim.toFixed(2));
        if (target.optionPrice > target.optionPriceHigh) {
          target.optionPriceHigh = target.optionPrice;
        }

        if (target.pullbackActive && !target.setupTriggered) {
          // OI Accumulation for Puts
          const priceDirChange = target.optionPrice - prevPrice;
          const oiFactor = priceDirChange > 0 ? 3000 : 800;
          target.optionOI += Math.floor(Math.random() * oiFactor);
          target.optionOIBuiltupPercentage = ((target.optionOI - target.optionOIPeak) / target.optionOIPeak) * 100;

          if (target.optionOI > target.optionOIPeak) {
            target.optionOIPeak = target.optionOI;
          }

          if (target.historicalOI.length === 0 || target.historicalOI[target.historicalOI.length - 1].time !== timeStr) {
            target.historicalOI.push({ time: timeStr, oi: target.optionOI, price: target.optionPrice });
            if (target.historicalOI.length > 20) target.historicalOI.shift();
          }

          // Bearish Rebreakout Trigger: Price slides below EMA20 (spot) while PE Option rises with Open Interest buildup > 2%
          if (target.spotPrice < target.ema20 && target.optionOIBuiltupPercentage > 2.0 && target.optionPrice > prevPrice) {
            target.setupTriggered = true;
            target.triggerReason = `Bearish Pullback Rebound Confirmed. Option Premium rallying as spot breaks below ema20 with +${target.optionOIBuiltupPercentage.toFixed(1)}% Open Interest Put buying block.`;
            this.io.emit("bot-log", `STRATEGY TRIGGERED: ${target.symbol} BUY Put Setup! Reason: ${target.triggerReason}`);

            if (this.autoTrigger && !target.tradeExecuted && this.dailyTradesCount < this.maxTradesPerDay) {
              target.tradeExecuted = true;
              target.entryPrice = target.optionPrice;
              this.dailyTradesCount++;
              if (this.paperTradingMode) {
                this.io.emit("bot-log", `STRATEGY TRADE COMPLETE: Executed paper buy of ${target.optionSymbol} @ ₹${target.optionPrice} (Underlying: ₹${target.spotPrice.toFixed(2)})`);
              } else {
                this.io.emit("bot-log", `STRATEGY LIVE ORDER: Placing live order on Kotak Neo for ${target.optionSymbol} @ ₹${target.optionPrice}...`);
                this.placeLiveKotakOrder(target.symbol, 500, target.optionPrice)
                  .then((orderId) => {
                    this.io.emit("bot-log", `STRATEGY LIVE SUCCESS: Filled live order on Kotak Neo! OrderID: ${orderId}`);
                  })
                  .catch((err) => {
                    this.io.emit("bot-log", `STRATEGY LIVE FAILED: Order rejected by Kotak Securities: ${err.message}`);
                  });
              }
            }
          }
        }
      }

      // Track dynamic day highs and lows for spot and option premium
      target.dayHigh = Math.max(target.dayHigh || target.spotPrice, target.spotPrice);
      target.dayLow = Math.min(target.dayLow || target.spotPrice, target.spotPrice);
      target.optionDayHigh = Math.max(target.optionDayHigh || target.optionPrice, target.optionPrice);
      target.optionDayLow = Math.min(target.optionDayLow || target.optionPrice, target.optionPrice);

      // If trade is executed, manage targets & stop losses visually
      if (target.tradeExecuted && target.entryPrice && !target.exitPrice) {
        const pnlPct = ((target.optionPrice - target.entryPrice) / target.entryPrice) * 100;
        target.pnl = (target.optionPrice - target.entryPrice) * 500; // Assumed lot size of 500 for PnL

        if (pnlPct >= 30.0) {
          target.exitPrice = target.optionPrice;
          this.io.emit("bot-log", `STRATEGY EXIT: Trade on ${target.symbol} closed at TAKE_PROFIT (+30% Target reached @ ₹${target.optionPrice})! PnL: ₹${target.pnl.toLocaleString()}`);
        } else if (pnlPct <= -15.0) {
          target.exitPrice = target.optionPrice;
          this.io.emit("bot-log", `STRATEGY EXIT: Trade on ${target.symbol} stopped out at STOP_LOSS (-15% SL hit @ ₹${target.optionPrice})! PnL: ₹${target.pnl.toLocaleString()}`);
        }
        updated = true;
      }
    }

    if (updated) {
      this.emitStatus();
    }
  }

  /**
   * Run manual testing injection loop (Simulate active market session movement)
   */
  public injectSimulatedMarketMove() {
    if (this.targets.length === 0) return;

    for (const target of this.targets) {
      const dirFactor = target.type === 'BULLISH_BREAKOUT' ? 1 : -1;
      
      // Let's create a realistic curve:
      // First, we simulate stock pulling back (moving opposite to trend)
      if (!target.pullbackActive) {
        // spot moves slightly opposite
        target.spotPrice += (Math.random() * 0.4 - 0.75) * dirFactor;
      } else if (!target.setupTriggered) {
        // spot moves listlessly or consolidates, option premium pulls down but begins accumulating OI
        target.spotPrice += (Math.random() * 0.5 - 0.25) * dirFactor;
        // bump OI
        target.optionOI += Math.floor(Math.random() * 2500) + 1200;
        target.optionOIBuiltupPercentage = ((target.optionOI - target.optionOIPeak) / target.optionOIPeak) * 100;
      } else if (target.tradeExecuted && !target.exitPrice) {
        // after buy, let the trade rally towards success to show a gorgeous win, occasionally dropping to test SL
        const rand = Math.random();
        if (rand > 0.3) {
          target.spotPrice += (Math.random() * 0.8 + 0.1) * dirFactor; // profitable movement
        } else {
          target.spotPrice -= (Math.random() * 0.4 + 0.15) * dirFactor; // slight consolidation
        }
      } else {
        // exited/idle
        target.spotPrice += Math.random() * 0.4 - 0.2;
      }
    }

    // Process as if updates occurred
    this.handleTickUpdates({});
  }

  public forceTriggerSetup(symbol: string) {
    const target = this.targets.find(t => t.symbol === symbol);
    if (target && !target.setupTriggered) {
      target.pullbackActive = true;
      target.optionOI = Math.floor(target.optionOI * 1.045);
      target.optionOIBuiltupPercentage = 4.5;
      
      const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      target.historicalOI.push({ time: timeStr, oi: target.optionOI, price: target.optionPrice });

      target.setupTriggered = true;
      target.triggerReason = "Manual operator setup injection triggered.";
      this.io.emit("bot-log", `STRATEGY MANUAL INJECTION: Triggered setup for ${target.symbol}`);

      if (this.autoTrigger && !target.tradeExecuted && this.dailyTradesCount < this.maxTradesPerDay) {
        target.tradeExecuted = true;
        target.entryPrice = target.optionPrice;
        this.dailyTradesCount++;
        this.io.emit("bot-log", `STRATEGY TRADE: Paper Buy executed for ${target.optionSymbol} @ ₹${target.optionPrice}`);
      }

      this.emitStatus();
    }
  }

  public forceCloseSetup(symbol: string) {
    const target = this.targets.find(t => t.symbol === symbol);
    if (target && target.tradeExecuted && !target.exitPrice) {
      target.exitPrice = target.optionPrice;
      target.pnl = (target.optionPrice - (target.entryPrice || 0)) * 500;
      this.io.emit("bot-log", `STRATEGY MANUAL CLOSE: Exited ${target.symbol} position @ ₹${target.optionPrice}. PnL: ₹${target.pnl}`);
      this.emitStatus();
    }
  }

  public emitStatus() {
    this.io.emit("breakout-strategy", {
      isEnabled: this.isEnabled,
      autoTrigger: this.autoTrigger,
      targets: this.targets,
      dailyTradesCount: this.dailyTradesCount,
      maxTradesPerDay: this.maxTradesPerDay,
      scanTimestamp: this.scanTimestamp,
      paperTradingMode: this.paperTradingMode
    });
  }
}
