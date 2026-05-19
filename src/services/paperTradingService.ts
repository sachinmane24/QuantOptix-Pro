import { TradeSignal } from "./scannerService";
import { Server } from "socket.io";

export interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  ltp: number;
  pnl: number;
  type: "LONG" | "SHORT";
  timestamp: number;
}

export interface PaperTradeRecord {
  id: string;
  symbol: string;
  type: "BUY" | "SELL";
  price: number;
  qty: number;
  timestamp: number;
  signalType: string;
}

export class PaperTradingService {
  private positions: Map<string, Position> = new Map();
  private tradeHistory: PaperTradeRecord[] = [];
  private io: Server;
  private autoTradeEnabled: boolean = false;
  private virtualBalance: number = 1000000; // 10 Lakh starting capital
  private dailyTradesCount: number = 0;
  private maxTradesPerDay: number = 10;
  private maxDailyLoss: number = 20000; // Stop bot if lost > 20k in a day
  private dailyPnL: number = 0;
  private lastResetDate: string = new Date().toDateString();
  public onTradeNotify?: (message: string) => void;

  constructor(io: Server) {
    this.io = io;
  }

  private checkDailyReset() {
    const today = new Date().toDateString();
    if (this.lastResetDate !== today) {
      this.dailyTradesCount = 0;
      this.dailyPnL = 0;
      this.lastResetDate = today;
      console.log(`[Trading] Daily stats reset for ${today}`);
    }
  }

  public setAutoTrade(enabled: boolean) {
    this.autoTradeEnabled = enabled;
    console.log(`[Trading] Auto-trade status changed to: ${enabled}`);
    this.io.emit("bot-log", `Auto-trade ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  public getStatus() {
    this.checkDailyReset();
    return {
      autoTradeEnabled: this.autoTradeEnabled,
      positions: Array.from(this.positions.values()),
      history: this.tradeHistory.slice(-20),
      balance: this.virtualBalance,
      dailyTrades: this.dailyTradesCount,
      dailyPnL: this.dailyPnL
    };
  }

  /**
   * Process incoming scanner signals
   */
  public handleSignal(signal: TradeSignal) {
    if (!this.autoTradeEnabled) return;
    this.checkDailyReset();

    // 1. Risk Check: Max Daily Loss Hit
    if (this.dailyPnL <= -this.maxDailyLoss) {
      this.emitLog(`ORDER REJECTED: Daily Max Loss Limit (${this.maxDailyLoss}) reached. Daily PnL: ${this.dailyPnL.toFixed(2)}`, "REJECTED");
      return;
    }

    // 2. Risk Check: Max Trades per day
    if (this.dailyTradesCount >= this.maxTradesPerDay) {
      this.emitLog(`ORDER REJECTED: Max Daily Trades (${this.maxTradesPerDay}) reached.`, "REJECTED");
      return;
    }

    // 3. Check if we already have a position in this symbol
    if (this.positions.has(signal.symbol)) {
      return;
    }

    // 4. Position Sizing: Use 10% of capital per trade
    const capitalPerTrade = this.virtualBalance * 0.1;
    const qty = Math.floor(capitalPerTrade / signal.price);

    if (qty <= 0) {
      this.emitLog(`ORDER REJECTED: Insufficient balance for ${signal.symbol}`, "REJECTED");
      return;
    }

    if (signal.type === "RSI_BREAKOUT_UP" || signal.type === "BULLISH_DIVERGENCE") {
      this.executeTrade(signal, "BUY", qty);
    } else if (signal.type === "RSI_BREAKOUT_DOWN" || signal.type === "BEARISH_DIVERGENCE") {
      this.executeTrade(signal, "SELL", qty);
    }
  }

  private executeTrade(signal: TradeSignal, type: "BUY" | "SELL", qty: number) {
    const tradeId = Math.random().toString(36).substr(2, 9);
    
    this.dailyTradesCount++;
    this.emitLog(`ORDER EXECUTED: ${type} ${signal.symbol} @ ${signal.price} (Qty: ${qty}) [Signal: ${signal.type}]`, "EXECUTED");

    const trade: PaperTradeRecord = {
      id: tradeId,
      symbol: signal.symbol,
      type,
      price: signal.price,
      qty,
      timestamp: Date.now(),
      signalType: signal.type
    };

    this.tradeHistory.push(trade);

    // Update positions
    const posType = type === "BUY" ? "LONG" : "SHORT";
    this.positions.set(signal.symbol, {
      symbol: signal.symbol,
      qty,
      entryPrice: signal.price,
      ltp: signal.price,
      pnl: 0,
      type: posType,
      timestamp: Date.now()
    });

    // Notify Frontend
    this.io.emit("paper-trade-executed", trade);
    this.broadcastUpdate();

    // Trigger Telegram Notification via hook
    if (this.onTradeNotify) {
      const typeLabel = type === "BUY" ? "🟢 CALL/BUY" : "🔴 PUT/SELL";
      const message = `🚀 <b>NEW TRADE EXECUTED</b>\n\n` +
                      `<b>Symbol:</b> <code>${signal.symbol}</code>\n` +
                      `<b>Action:</b> ${typeLabel}\n` +
                      `<b>Price:</b> ₹${signal.price.toFixed(2)}\n` +
                      `<b>Quantity:</b> ${qty}\n` +
                      `<b>Signal:</b> ${signal.type}\n` +
                      `<i>Status: Execution successful on Quant Engine.</i>`;
      this.onTradeNotify(message);
    }
  }

  /**
   * Update live P&L on every tick
   */
  public updatePnL(symbol: string, ltp: number) {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    pos.ltp = ltp;
    if (pos.type === "LONG") {
      pos.pnl = (ltp - pos.entryPrice) * pos.qty;
    } else {
      pos.pnl = (pos.entryPrice - ltp) * pos.qty;
    }

    // Auto-Exit Logic (Simple Stop Loss / Take Profit)
    const pnlPct = (pos.pnl / (pos.entryPrice * pos.qty)) * 100;
    
    if (pnlPct >= 1.0) { // 1% Take Profit
      this.closePosition(symbol, ltp, "TAKE_PROFIT");
    } else if (pnlPct <= -0.5) { // 0.5% Stop Loss
      this.closePosition(symbol, ltp, "STOP_LOSS");
    }

    this.broadcastUpdate();
  }

  public closePosition(symbol: string, price: number, reason: string) {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    this.dailyPnL += pos.pnl;
    this.emitLog(`POSITION CLOSED: ${symbol} @ ${price} (Reason: ${reason}) | PnL: ${pos.pnl.toFixed(2)}`, "CLOSED");
    
    this.tradeHistory.push({
      id: Math.random().toString(36).substr(2, 9),
      symbol,
      type: pos.type === "LONG" ? "SELL" : "BUY",
      price,
      qty: pos.qty,
      timestamp: Date.now(),
      signalType: reason
    });

    this.virtualBalance += pos.pnl;
    this.positions.delete(symbol);
    
    this.io.emit("position-closed", { symbol, pnl: pos.pnl, reason });
    this.broadcastUpdate();

    // Trigger Telegram Notification via hook
    if (this.onTradeNotify) {
      const isProfit = pos.pnl >= 0;
      const message = `🏁 <b>TRADE CLOSED</b>\n\n` +
                      `<b>Symbol:</b> <code>${symbol}</code>\n` +
                      `<b>Status:</b> ${isProfit ? '💰 PROFIT' : '🛑 EXIT'}\n` +
                      `<b>Entry:</b> ₹${pos.entryPrice.toFixed(2)}\n` +
                      `<b>Exit:</b> ₹${price.toFixed(2)}\n` +
                      `<b>Net PnL:</b> <b>${isProfit ? '+' : ''}₹${pos.pnl.toLocaleString()}</b>\n` +
                      `<b>Reason:</b> ${reason}`;
      this.onTradeNotify(message);
    }
  }

  private emitLog(message: string, type: "EXECUTED" | "REJECTED" | "CLOSED" | "INFO") {
    console.log(`[Trading] ${type}: ${message}`);
    const timestamp = new Date().toLocaleTimeString();
    this.io.emit("bot-log", `[${timestamp}] ${message}`);
  }

  private broadcastUpdate() {
    this.io.emit("paper-portfolio-update", {
      positions: Array.from(this.positions.values()),
      balance: this.virtualBalance,
      totalPnL: Array.from(this.positions.values()).reduce((sum, p) => sum + p.pnl, 0)
    });
  }
}
