/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { StockData, MarketRegime, Trend, OptionChainData } from '../types';
import { io, Socket } from 'socket.io-client';
import { FNO_DATA, FNO_SYMBOLS } from './fnoData';

export const FNO_STOCKS = FNO_SYMBOLS;

export const SECTORS = [
  'Banking', 'IT', 'Auto', 'Pharma', 'Financial Services', 'Energy', 'Capital Goods', 'Consumer Goods', 
  'Metals', 'FMCG', 'Realty', 'Cement', 'Healthcare', 'Telecom', 'Chemicals', 'Retail', 'Services'
];

const mockHistoricalData: Record<string, any[]> = {};

// Simulate live data
export function getLiveStockData(): StockData[] {
  return FNO_STOCKS.slice(0, 100).map(symbol => {
    const info = FNO_DATA[symbol];
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
      sector: info?.sector || 'Diversified',
      relativeStrength: (Math.random() * 4) - 2,
      marketRegime: regime,
      trend,
      rsi: 30 + Math.random() * 40,
      pulse: (pChange * 0.8) + (Math.random() * 0.4),
      higherTimeframeBias: Math.random() > 0.5 ? 'BULLISH' : 'BEARISH',
      lotSize: info?.lotSize || 1,
      atr: lastPrice * (0.012 + Math.random() * 0.008), // 1.2% - 2% ATR
      adr: lastPrice * (0.025 + Math.random() * 0.015)  // 2.5% - 4% ADR
    };
  });
}

export function getStrikeInterval(price: number): number {
  if (price > 5000) return 100;
  if (price > 1000) return 50;
  if (price > 500) return 20;
  if (price > 100) return 10;
  if (price > 50) return 5;
  return 1;
}

export function getOptionChain(symbol: string, currentPrice: number): OptionChainData[] {
  const interval = getStrikeInterval(currentPrice);
  const roundPrice = Math.round(currentPrice / interval) * interval;
  const strikes = Array.from({ length: 21 }, (_, i) => roundPrice - (10 * interval) + i * interval);
  
  const chain: OptionChainData[] = [];
  strikes.forEach(strike => {
    // Call
    const ceIntrinsic = Math.max(0, currentPrice - strike);
    const peIntrinsic = Math.max(0, strike - currentPrice);
    
    // Improved Option Pricing Model (Simple BSM Approximation)
    // Time Value = Spot * volatility * sqrt(days/365)
    // For mock, we use a decay factor based on how OTM it is
    const distance = Math.abs(currentPrice - strike);
    const decayFactor = Math.exp(-distance / (currentPrice * 0.1));
    const timeValue = (currentPrice * 0.02) * decayFactor;

    chain.push({
      strike,
      type: 'CE',
      lastPrice: Math.max(2, Number((ceIntrinsic + timeValue + Math.random() * 5).toFixed(2))),
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
      lastPrice: Math.max(2, Number((peIntrinsic + timeValue + Math.random() * 5).toFixed(2))),
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

/**
 * Institutional Strike Selection Logic
 * Picks ATM or slightly OTM strike based on delta (approximate)
 */
export function getRecommendedStrike(price: number, type: 'CE' | 'PUT', mode: 'AGGRESSIVE' | 'CONSERVATIVE' = 'CONSERVATIVE') {
  const strikeInterval = getStrikeInterval(price);
  const atm = Math.round(price / strikeInterval) * strikeInterval;
  
  if (type === 'CE') {
    return mode === 'CONSERVATIVE' ? atm : atm + strikeInterval;
  } else {
    return mode === 'CONSERVATIVE' ? atm : atm - strikeInterval;
  }
}

let activeUniverseSymbols: string[] = [];
let lastUniverseRefresh = 0;

/**
 * Institutional Scanner Logic:
 * Prioritizes top 5 gainers and losers to stay within API limits
 */
export async function getActiveInstitutionalUniverse(): Promise<string[]> {
  const now = Date.now();
  // Refresh every 5 mins
  if (activeUniverseSymbols.length > 0 && (now - lastUniverseRefresh < 5 * 60 * 1000)) {
    return activeUniverseSymbols;
  }

  try {
    // Fetch quotes for all F&O stocks (chunked)
    const allQuotes: StockData[] = [];
    const chunks = [];
    for (let i = 0; i < FNO_STOCKS.length; i += 50) {
      chunks.push(FNO_STOCKS.slice(i, i + 50));
    }

    for (const chunk of chunks) {
      const symbols = chunk.map(s => `NSE:${s}-EQ`).join(',');
      const response = await fetch(`/api/market/quotes?symbols=${symbols}`);
      const data = await response.json();
      if (data.d && Array.isArray(data.d)) {
        data.d.forEach((item: any) => {
          if (item.n.includes('-EQ')) {
            const sym = item.n.split(':')[1].split('-')[0];
            allQuotes.push({ symbol: sym, pChange: item.v.chp } as any);
          }
        });
      }
    }

    if (allQuotes.length === 0) return activeUniverseSymbols.length > 0 ? activeUniverseSymbols : FNO_STOCKS.slice(0, 10);

    const sorted = [...allQuotes].sort((a, b) => b.pChange - a.pChange);
    const top20Gainers = sorted.slice(0, 20).map(s => s.symbol);
    const top20Losers = sorted.slice(-20).map(s => s.symbol);
    
    activeUniverseSymbols = [...new Set([...top20Gainers, ...top20Losers])];
    lastUniverseRefresh = now;
    
    console.log('[Institutional Scanner] Universe Refreshed:', activeUniverseSymbols);
    return activeUniverseSymbols;
  } catch (error) {
    console.error('Universe Scan Failed:', error);
    return activeUniverseSymbols.length > 0 ? activeUniverseSymbols : FNO_STOCKS.slice(0, 10);
  }
}

export async function fetchLiveMarketData(): Promise<StockData[] | null> {
  try {
    const activeUniverse = await getActiveInstitutionalUniverse();
    const stockSymbols = activeUniverse.map(s => `NSE:${s}-EQ`).join(',');
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
            relVolume: 0.9 + Math.random() * 1.5,
            futuresOI: v.oi || Math.floor(Math.random() * 1000000), 
            oiChange: v.oic || ((pChange * 2) + (Math.random() * 2 - 1)),
            vwap: v.avg_price || lastPrice,
            ema20: lastPrice * (1 - (Math.random() * 0.02)),
            ema50: lastPrice * (1 - (Math.random() * 0.04)),
            sector: FNO_DATA[symbol]?.sector || 'Diversified', 
            relativeStrength: (pChange - (nifty?.v?.chp || 0)),
            marketRegime: Math.abs(pChange) > 2 ? MarketRegime.BREAKOUT : MarketRegime.SIDEWAYS,
            trend: pChange > 0 ? Trend.BULLISH : Trend.BEARISH,
            rsi: 40 + (pChange * 2),
            pulse: pChange * 0.7, // Simplified pulse
            higherTimeframeBias: pChange > 0.5 ? 'BULLISH' : pChange < -0.5 ? 'BEARISH' : 'NEUTRAL',
            lotSize: FNO_DATA[symbol]?.lotSize || 1,
            atr: lastPrice * (0.015), // Standard approx
            adr: lastPrice * (0.03) // Standard approx
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
  if (dynamicMarketOverview) return dynamicMarketOverview;
  
  // Dynamic mock data that changes every time it's called if real data missing
  const drift = (Math.random() * 10) - 5;
  return {
    nifty: { price: 24210.50 + drift, change: 120.5 + drift, pChange: 0.54 + (drift/1000) },
    bankNifty: { price: 52300.15 + drift*5, change: -45.2 + drift*5, pChange: -0.09 + (drift/500) },
    indiaVix: { price: 13.4 + (drift/20), change: 0.2, pChange: 1.5 },
    topGainer: 'RELIANCE',
    topLoser: 'TCS',
    advances: 104 + Math.floor(drift),
    declines: 78 - Math.floor(drift)
  };
}

export let socket: Socket | null = null;

export function initializeMarketWebSocket(
  onStocksUpdate: (stocks: StockData[]) => void, 
  onMarketUpdate: (market: any) => void,
  onTradeSignal?: (signal: any) => void,
  onPaperPortfolioUpdate?: (update: any) => void,
  onAutoTradeStatus?: (enabled: boolean) => void,
  onBotLog?: (log: string) => void
) {
  if (socket) return;
  
  socket = io();

  if (onBotLog) {
    socket.on('bot-log', (log: string) => {
      onBotLog(log);
    });
  }

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
          relVolume: 0.9 + Math.random() * 0.5,
          futuresOI: v.oi || Math.floor(Math.random() * 1000000),
          oiChange: v.oic || ((v.chp * 1.5) + (Math.random() * 2 - 1)),
          vwap: v.avg_price || v.lp,
          ema20: v.lp * 0.99, // Indicators usually calculated on client or separate service
          ema50: v.lp * 0.97,
          sector: 'Market',
          relativeStrength: 0,
          marketRegime: Math.abs(v.chp) > 2 ? MarketRegime.BREAKOUT : MarketRegime.SIDEWAYS,
          trend: v.chp > 0 ? Trend.BULLISH : Trend.BEARISH,
          rsi: 50,
          pulse: (v.chp * 0.5),
          atr: v.lp * 0.015,
          adr: v.lp * 0.03
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
