import axios from "axios";
import { RSI } from "technicalindicators";
import { Server } from "socket.io";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeSignal {
  symbol: string;
  type: "RSI_BREAKOUT_UP" | "RSI_BREAKOUT_DOWN" | "BULLISH_DIVERGENCE" | "BEARISH_DIVERGENCE";
  price: number;
  rsi: number;
  timestamp: number;
  confidence: number;
}

interface SymbolState {
  symbol: string;
  candles: Candle[];
  rsiValues: number[];
}

export class ScannerService {
  private symbols: string[] = [
    "NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX",
    "NSE:RELIANCE-EQ", "NSE:HDFCBANK-EQ", "NSE:ICICIBANK-EQ", "NSE:SBIN-EQ", "NSE:INFY-EQ",
    "NSE:TCS-EQ", "NSE:AXISBANK-EQ", "NSE:TATAMOTORS-EQ", "NSE:LT-EQ", "NSE:BEL-EQ",
    "NSE:HAL-EQ", "NSE:TRENT-EQ", "NSE:ADANIENT-EQ", "NSE:COFORGE-EQ", "NSE:TECHM-EQ",
    "NSE:WIPRO-EQ", "NSE:HCLTECH-EQ", "NSE:BHARTIARTL-EQ", "NSE:ITC-EQ", "NSE:ASIANPAINT-EQ"
  ];
  private states: Map<string, SymbolState> = new Map();
  private io: Server;
  public isRunning: boolean = false;
  public onSignal?: (signal: TradeSignal) => void;

  constructor(io: Server) {
    this.io = io;
  }

  public async start() {
    if (this.isRunning) return;
    console.log("[Scanner] Starting Real-time Scanner...");
    this.isRunning = true;
    
    const token = process.env.FYERS_ACCESS_TOKEN;
    if (!token) {
      console.log("[Scanner] Missing token. Waiting for login...");
      this.isRunning = false;
      return;
    }

    // 1. Load initial history
    await this.initializeHistory();

    console.log("[Scanner] Scanner initialized and running.");
  }

  public stop() {
    console.log("[Scanner] Stopping Scanner Service...");
    this.isRunning = false;
    this.states.clear();
  }

  private async initializeHistory() {
    const token = process.env.FYERS_ACCESS_TOKEN;
    const clientId = process.env.FYERS_CLIENT_ID;
    
    if (!token || !clientId) return;

    for (const symbol of this.symbols) {
      try {
        const history = await this.fetchHistory(symbol, token, clientId);
        if (history && history.length > 0) {
          const rsiValues = RSI.calculate({ 
            values: history.map(c => c.close), 
            period: 14 
          });
          
          this.states.set(symbol, {
            symbol,
            candles: history,
            rsiValues
          });
          console.log(`[Scanner] Loaded ${history.length} candles for ${symbol}`);
        }
      } catch (error: any) {
        console.error(`[Scanner] Error initializing history for ${symbol}:`, error.message);
      }
    }
  }

  private async fetchHistory(symbol: string, token: string, clientId: string): Promise<Candle[]> {
    const now = Math.floor(Date.now() / 1000);
    const threeHoursAgo = now - (3 * 60 * 60); // 3 hours of 1-min data is enough (180 bars)
    
    const fromStr = new Date(threeHoursAgo * 1000).toISOString().split('T')[0];
    const toStr = new Date().toISOString().split('T')[0];

    const authHeader = token.includes(":") ? token : `${clientId}:${token}`;

    try {
      const response = await axios.get(`https://api-t1.fyers.in/data/history`, {
        params: {
          symbol,
          resolution: "1",
          date_format: "1",
          range_from: fromStr,
          range_to: toStr,
          cont_flag: "1"
        },
        headers: { 'Authorization': authHeader }
      });

      if (response.data.s === "ok" && response.data.candles) {
        return response.data.candles.map((c: any) => ({
          time: c[0],
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
          volume: c[5]
        }));
      }
    } catch (error: any) {
       // Silent error to avoid spam
    }
    return [];
  }

  /**
   * Called whenever a new tick arrives from WebSocket
   */
  public handleTick(symbol: string, ltp: number, high: number, low: number, volume: number) {
    if (!this.isRunning) return;
    const state = this.states.get(symbol);
    if (!state) return;

    const lastCandle = state.candles[state.candles.length - 1];
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Check if new minute started
    if (currentTime - lastCandle.time >= 60) {
      // Finalize current candle and move to next
      const newCandle: Candle = {
        time: Math.floor(currentTime / 60) * 60,
        open: ltp,
        high: ltp,
        low: ltp,
        close: ltp,
        volume: volume
      };
      
      state.candles.push(newCandle);
      if (state.candles.length > 200) state.candles.shift();

      // Recalculate RSI
      const rsiValues = RSI.calculate({ 
        values: state.candles.map(c => c.close), 
        period: 14 
      });
      state.rsiValues = rsiValues;

      // Evaluate signals on candle close
      this.evaluateSignals(state);
    } else {
      // Update current live candle
      lastCandle.close = ltp;
      if (ltp > lastCandle.high) lastCandle.high = ltp;
      if (ltp < lastCandle.low) lastCandle.low = ltp;
      lastCandle.volume = volume;
    }
  }

  private evaluateSignals(state: SymbolState) {
    const { rsiValues, candles, symbol } = state;
    if (rsiValues.length < 5) return;

    const currentRsi = rsiValues[rsiValues.length - 1];
    const prevRsi = rsiValues[rsiValues.length - 2];
    const currentPrice = candles[candles.length - 1].close;

    // 1. RSI BREAKOUT
    if (currentRsi > 70 && prevRsi <= 70) {
      this.notifySignal({
        symbol,
        type: "RSI_BREAKOUT_UP",
        price: currentPrice,
        rsi: currentRsi,
        timestamp: Date.now(),
        confidence: 0.8
      });
    } else if (currentRsi < 30 && prevRsi >= 30) {
      this.notifySignal({
        symbol,
        type: "RSI_BREAKOUT_DOWN",
        price: currentPrice,
        rsi: currentRsi,
        timestamp: Date.now(),
        confidence: 0.8
      });
    }

    // 2. RSI DIVERGENCE (Simple version)
    // Bullish Divergence: Price Lower Low, RSI Higher Low
    if (candles.length > 5) {
      const p1 = candles[candles.length - 3].close;
      const p2 = candles[candles.length - 1].close;
      const r1 = rsiValues[rsiValues.length - 3];
      const r2 = rsiValues[rsiValues.length - 1];

      if (p2 < p1 && r2 > r1 && r2 < 40) {
        this.notifySignal({
          symbol,
          type: "BULLISH_DIVERGENCE",
          price: currentPrice,
          rsi: currentRsi,
          timestamp: Date.now(),
          confidence: 0.7
        });
      }

      // Bearish Divergence: Price Higher High, RSI Lower High
      if (p2 > p1 && r2 < r1 && r2 > 60) {
        this.notifySignal({
          symbol,
          type: "BEARISH_DIVERGENCE",
          price: currentPrice,
          rsi: currentRsi,
          timestamp: Date.now(),
          confidence: 0.7
        });
      }
    }
  }

  private notifySignal(signal: TradeSignal) {
    console.log(`[Scanner] SIGNAL DETECTED: ${signal.symbol} - ${signal.type}`);
    this.io.emit("trade-signal", signal);
    if (this.onSignal) {
      this.onSignal(signal);
    }
  }
}
