/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { StockData, MarketRegime, Trend, OptionChainData } from '../types';
import { io, Socket } from 'socket.io-client';

export const FNO_STOCKS = [
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'INFY', 'TCS', 'AXISBANK', 'KOTAKBANK',
  'TATAMOTORS', 'LT', 'BEL', 'HAL', 'TRENT', 'ADANIENT', 'ADANIPORTS', 'COFORGE',
  'CHOLAFIN', 'BAJFINANCE', 'BHARTIARTL', 'SUNPHARMA', 'HINDUNILVR',
  'ITC', 'TITAN', 'ASIANPAINT', 'ULTRACEMCO'
];

export const SECTORS = [
  'Banking', 'IT', 'Auto', 'Pharma', 'PSU', 'Energy', 'Realty', 'Metals', 'Capital Goods'
];

const mockHistoricalData: Record<string, any[]> = {};

// Simulate live data
export function getLiveStockData(): StockData[] {
  return FNO_STOCKS.map(symbol => {
    const lastPrice = 500 + Math.random() * 5000;
    const pChange = (Math.random() * 6) - 3;
    const oiChange = (Math.random() * 20) - 10;
    const relVolume = 0.5 + Math.random() * 3;
    
    let trend = Trend.SIDEWAYS;
    if (pChange > 1.5 && oiChange > 5) trend = Trend.BULLISH;
    else if (pChange < -1.5 && oiChange > 5) trend = Trend.BEARISH;

    let regime = MarketRegime.SIDEWAYS;
    if (relVolume > 2) regime = MarketRegime.BREAKOUT;
    else if (Math.abs(pChange) > 2) regime = MarketRegime.TRENDING;

    return {
      symbol,
      name: symbol,
      lastPrice,
      pChange,
      volume: Math.floor(Math.random() * 1000000),
      relVolume,
      futuresOI: Math.floor(Math.random() * 5000000),
      oiChange,
      vwap: lastPrice * (1 + (Math.random() * 0.02 - 0.01)),
      ema20: lastPrice * (1 - (Math.random() * 0.05)),
      ema50: lastPrice * (1 - (Math.random() * 0.1)),
      sector: SECTORS[Math.floor(Math.random() * SECTORS.length)],
      relativeStrength: (Math.random() * 4) - 2,
      marketRegime: regime,
      trend,
      rsi: 30 + Math.random() * 40
    };
  });
}

export function getOptionChain(symbol: string, currentPrice: number): OptionChainData[] {
  const roundPrice = Math.round(currentPrice / 50) * 50;
  const strikes = Array.from({ length: 11 }, (_, i) => roundPrice - 250 + i * 50);
  
  const chain: OptionChainData[] = [];
  strikes.forEach(strike => {
    // Call
    chain.push({
      strike,
      type: 'CE',
      lastPrice: Math.max(1, (currentPrice - strike) * 1.1 + Math.random() * 20),
      change: (Math.random() * 40) - 20,
      oi: Math.floor(Math.random() * 100000),
      oiChange: (Math.random() * 50) - 10,
      iv: 15 + Math.random() * 30,
      delta: Math.max(0.1, Math.min(0.9, 0.5 + (currentPrice - strike) / 500)),
      theta: -(Math.random() * 5),
      gamma: Math.random() * 0.01,
      vega: Math.random() * 2,
    });
    // Put
    chain.push({
      strike,
      type: 'PUT',
      lastPrice: Math.max(1, (strike - currentPrice) * 1.1 + Math.random() * 20),
      change: (Math.random() * 40) - 20,
      oi: Math.floor(Math.random() * 100000),
      oiChange: (Math.random() * 50) - 10,
      iv: 15 + Math.random() * 30,
      delta: Math.max(-0.9, Math.min(-0.1, -0.5 + (currentPrice - strike) / 500)),
      theta: -(Math.random() * 5),
      gamma: Math.random() * 0.01,
      vega: Math.random() * 2,
    });
  });
  return chain;
}

let dynamicMarketOverview: any = null;

export async function fetchLiveMarketData(): Promise<StockData[] | null> {
  try {
    const stockSymbols = FNO_STOCKS.map(s => `NSE:${s}-EQ`).join(',');
    const indexSymbols = 'NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX,NSE:INDIAVIX-INDEX';
    const queryParams = new URLSearchParams({ symbols: `${stockSymbols},${indexSymbols}` });
    const response = await fetch(`/api/market/quotes?${queryParams.toString()}`);
    const contentType = response.headers.get("content-type");
    
    if (!response.ok) {
      const text = await response.text();
      console.error(`Fyers API Error (${response.status}):`, text.substring(0, 200));
      return null;
    }

    if (!contentType || !contentType.includes("application/json")) {
      const text = await response.text();
      // If we see the platform's starter page, just log a warning and return null (don't error out)
      if (text.includes("Starting Server...")) {
        console.warn("Backend server is still starting. Retrying in background...");
        return null;
      }
      console.error("Fyers API returned non-JSON response:", text.substring(0, 200));
      return null;
    }

    const data = await response.json();

    if (data.mock) {
      console.warn("Fyers token not set, using mock data.");
      return null;
    }

    if (data.d && Array.isArray(data.d)) {
      // Extract indices for market overview
      const nifty = data.d.find((item: any) => item.n === 'NSE:NIFTY50-INDEX');
      const bankNifty = data.d.find((item: any) => item.n === 'NSE:NIFTYBANK-INDEX');
      const vix = data.d.find((item: any) => item.n === 'NSE:INDIAVIX-INDEX');

      if (nifty || bankNifty) {
        dynamicMarketOverview = {
          nifty: nifty ? { price: nifty.v.lp, change: nifty.v.ch, pChange: nifty.v.chp } : { price: 22450.30, change: 120.5, pChange: 0.54 },
          bankNifty: bankNifty ? { price: bankNifty.v.lp, change: bankNifty.v.ch, pChange: bankNifty.v.chp } : { price: 47800.15, change: -45.2, pChange: -0.09 },
          indiaVix: vix ? { price: vix.v.lp, change: vix.v.ch, pChange: vix.v.chp } : { price: 12.4, change: 0.2, pChange: 1.5 },
          topGainer: 'Scanning...',
          topLoser: 'Scanning...',
          advances: 0,
          declines: 0
        };
      }

      // Filter and map stocks
      return data.d
        .filter((item: any) => item.n.includes('-EQ'))
        .map((item: any) => {
          const symbol = item.n.split(':')[1].split('-')[0];
          const v = item.v;
          const lastPrice = v.lp;
          const pChange = v.chp;
          
          return {
            symbol,
            name: symbol,
            lastPrice,
            pChange,
            volume: v.vol,
            relVolume: 1.0,
            futuresOI: v.oi || 0, 
            oiChange: v.oic || 0,
            vwap: v.avg_price || lastPrice,
            ema20: lastPrice * (1 - (Math.random() * 0.02)),
            ema50: lastPrice * (1 - (Math.random() * 0.04)),
            sector: SECTORS[Math.floor(Math.random() * SECTORS.length)], 
            relativeStrength: (pChange - (nifty?.v?.chp || 0)),
            marketRegime: Math.abs(pChange) > 2 ? MarketRegime.BREAKOUT : MarketRegime.SIDEWAYS,
            trend: pChange > 0 ? Trend.BULLISH : Trend.BEARISH,
            rsi: 40 + (pChange * 2)
          };
        });
    }
    return null;
  } catch (error) {
    console.error("Error fetching Fyers data:", error);
    return null;
  }
}

export function getMarketOverview() {
  return dynamicMarketOverview || {
    nifty: { price: 22450.30, change: 120.5, pChange: 0.54 },
    bankNifty: { price: 47800.15, change: -45.2, pChange: -0.09 },
    indiaVix: { price: 12.4, change: 0.2, pChange: 1.5 },
    topGainer: 'TRENT',
    topLoser: 'TATAMOTORS',
    advances: 104,
    declines: 78
  };
}

export let socket: Socket | null = null;

export function initializeMarketWebSocket(
  onStocksUpdate: (stocks: StockData[]) => void, 
  onMarketUpdate: (market: any) => void,
  onTradeSignal?: (signal: any) => void,
  onPaperPortfolioUpdate?: (update: any) => void,
  onAutoTradeStatus?: (enabled: boolean) => void
) {
  if (socket) return;
  
  socket = io();

  if (onTradeSignal) {
    socket.on('trade-signal', (signal: any) => {
      onTradeSignal(signal);
    });
  }

  if (onPaperPortfolioUpdate) {
    socket.on('paper-portfolio-update', (update: any) => {
      onPaperPortfolioUpdate(update);
    });
  }

  if (onAutoTradeStatus) {
    socket.on('auto-trade-status', (enabled: boolean) => {
      onAutoTradeStatus(enabled);
    });
  }
  
  socket.on('market-update', (message: any) => {
    if (!message || !message.d) return;
    
    // Fyers Websocket can send full data or partial.
    // Map it to our types
    const data = message.d;
    
    // Update active overview if index data present
    const nifty = data['NSE:NIFTY50-INDEX'];
    const bankNifty = data['NSE:NIFTYBANK-INDEX'];
    const vix = data['NSE:INDIAVIX-INDEX'];

    if (nifty || bankNifty || vix) {
      const current = dynamicMarketOverview || getMarketOverview();
      dynamicMarketOverview = {
        ...current,
        nifty: nifty ? { price: nifty.lp, change: nifty.ch, pChange: nifty.chp } : current.nifty,
        bankNifty: bankNifty ? { price: bankNifty.lp, change: bankNifty.ch, pChange: bankNifty.chp } : current.bankNifty,
        indiaVix: vix ? { price: vix.lp, change: vix.ch, pChange: vix.chp } : current.indiaVix,
      };
      onMarketUpdate(dynamicMarketOverview);
    }

    // Process stocks
    const stockUpdates: StockData[] = [];
    Object.keys(data).forEach(key => {
      if (key.includes('-EQ')) {
        const symbol = key.split(':')[1].split('-')[0];
        const v = data[key];
        
        stockUpdates.push({
          symbol,
          name: symbol,
          lastPrice: v.lp,
          pChange: v.chp,
          volume: v.v || 0,
          relVolume: 1.0,
          futuresOI: v.oi || 0,
          oiChange: v.oic || 0,
          vwap: v.avg_price || v.lp,
          ema20: v.lp * 0.99, // Indicators usually calculated on client or separate service
          ema50: v.lp * 0.97,
          sector: 'Market',
          relativeStrength: 0,
          marketRegime: Math.abs(v.chp) > 2 ? MarketRegime.BREAKOUT : MarketRegime.SIDEWAYS,
          trend: v.chp > 0 ? Trend.BULLISH : Trend.BEARISH,
          rsi: 50
        });
      }
    });

    if (stockUpdates.length > 0) {
      onStocksUpdate(stockUpdates);
    }
  });

  socket.on('connect', () => console.log('[NSE WS] Connected'));
  socket.on('disconnect', () => console.log('[NSE WS] Disconnected'));
}
