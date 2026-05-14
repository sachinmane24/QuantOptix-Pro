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

  constructor(io: Server) {
    this.io = io;
  }

  public setAutoTrade(enabled: boolean) {
    this.autoTradeEnabled = enabled;
    console.log(`[Trading] Auto-trade status changed to: ${enabled}`);
  }

  public getStatus() {
    return {
      autoTradeEnabled: this.autoTradeEnabled,
      positions: Array.from(this.positions.values()),
      history: this.tradeHistory.slice(-20),
      balance: this.virtualBalance
    };
  }

  /**
   * Process incoming scanner signals
   */
  public handleSignal(signal: TradeSignal) {
    if (!this.autoTradeEnabled) return;

    // Check if we already have a position in this symbol
    if (this.positions.has(signal.symbol)) {
      // Logic for trailing stop loss or scaling could go here
      return;
    }

    // Risk Management: Use 10% of capital per trade
    const capitalPerTrade = this.virtualBalance * 0.1;
    const qty = Math.floor(capitalPerTrade / signal.price);

    if (qty <= 0) return;

    if (signal.type === "RSI_BREAKOUT_UP" || signal.type === "BULLISH_DIVERGENCE") {
      this.executeTrade(signal, "BUY", qty);
    } else if (signal.type === "RSI_BREAKOUT_DOWN" || signal.type === "BEARISH_DIVERGENCE") {
      this.executeTrade(signal, "SELL", qty);
    }
  }

  private executeTrade(signal: TradeSignal, type: "BUY" | "SELL", qty: number) {
    const tradeId = Math.random().toString(36).substr(2, 9);
    
    console.log(`[Trading] EXECUTING ${type} for ${signal.symbol} @ ${signal.price}`);

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

    console.log(`[Trading] CLOSING ${symbol} @ ${price} (Reason: ${reason})`);
    
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
  }

  private broadcastUpdate() {
    this.io.emit("paper-portfolio-update", {
      positions: Array.from(this.positions.values()),
      balance: this.virtualBalance,
      totalPnL: Array.from(this.positions.values()).reduce((sum, p) => sum + p.pnl, 0)
    });
  }
}
