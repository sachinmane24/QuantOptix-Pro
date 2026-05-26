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

export function getStockBasePrice(symbol: string): number {
  const cleanSym = symbol.toUpperCase().replace("NSE:", "").replace("-EQ", "").trim();
  
  // Indices
  if (cleanSym.includes('NIFTY50') || cleanSym === 'NIFTY') return 24200;
  if (cleanSym.includes('NIFTYBANK') || cleanSym === 'BANKNIFTY') return 52300;
  if (cleanSym.includes('INDIAVIX') || cleanSym === 'VIX') return 13.4;

  // Manual mappings for well-known stock tickers to provide extreme realism
  const prices: Record<string, number> = {
    'HYUNDAI': 1800,
    'RELIANCE': 2950,
    'TCS': 3850,
    'INFY': 1560,
    'HDFCBANK': 1650,
    'ICICIBANK': 1150,
    'SBIN': 820,
    'AXISBANK': 1120,
    'KOTAKBANK': 1780,
    'COFORGE': 5200,
    'PERSISTENT': 3600,
    'UNOMINDA': 1040,
    'ASTRAL': 2150,
    'JUBLFOOD': 465,
    'BEL': 270,
    'HAL': 3800,
    'KPITTECH': 1400,
    'ABB': 5400,
    'APOLLOHOSP': 6100,
    'CIPLA': 1420,
    'DIVISLAB': 3800,
    'GLENMARK': 980,
    'AUROPHARMA': 1250,
    'WIPRO': 480,
    'COALINDIA': 470,
    'ITC': 430,
    'BHARTIARTL': 1380,
    'TATASTEEL': 160,
    'MARUTI': 12200,
    'M&M': 2700,
    'L&T': 3550,
    'JSWSTEEL': 890,
    'ADANIENT': 3100,
    'ADANIPORTS': 1350,
    'ULTRACEMCO': 9800,
    'GRASIM': 2400,
    'SUNPHARMA': 1550,
    'VEDL': 450,
    'ONGC': 270,
    'NTPC': 360,
    'POWERGRID': 310,
    'HINDALCO': 630,
    'HEROMOTOCO': 4800,
    'TITAN': 3300,
    'BAJAJ-AUTO': 9200,
    'ASIANPAINT': 2900,
    'EICHERMOT': 4600,
    'APOLLOTYRE': 480,
    'TATAMOTORS': 950,
    'IDFCFIRSTB': 80,
    'GMRAIRPORT': 85,
    'PNB': 120,
    'SAIL': 150,
    'IRFC': 170,
    'RECLTD': 520,
    'PFC': 480,
    'BHEL': 280,
    'GAIL': 200,
    'NATIONALUM': 190,
    'NMDC': 240,
    'CANBK': 120,
    'BANKBARODA': 270,
    'TATACOMM': 1850,
    'TATACONSUM': 1100,
    'TATAPOWER': 430,
    'MUTHOOTFIN': 1700,
    'HINDUNILVR': 2450,
    'LTTS': 4800,
    'MOTHERSUMI': 250,
    'SAMVARDHANA': 250,
    'ADANIPOWER': 650,
    'DLF': 850,
    'GODREJPROP': 2500,
    'ASHOKLEY': 220,
    'BALKRISIND': 3100,
    'CHOLAFIN': 1400,
    'CONCOR': 950,
    'CUMMINSIND': 3300,
    'DIXON': 9800,
    'HAVELLS': 1600,
    'HDFCLIFE': 580,
    'ICICIGI': 1650,
    'IND HOTELS': 620,
    'INDUSINDBK': 1480,
    'IPCALAB': 1250,
    'JINDALSTEL': 950,
    'LICHSGFIN': 680,
    'LTIM': 4850,
    'MPHASIS': 2400,
    'MRF': 125000,
    'OFSS': 9800,
    'PIDILITIND': 3100,
    'POLYCAB': 6500,
    'SHREECEM': 26000,
    'SIEMENS': 6500,
    'SRF': 2300,
    'TATACHEM': 1050,
    'TRENT': 4800,
    'VOLTAS': 1400
  };

  if (prices[cleanSym] !== undefined) {
    return prices[cleanSym];
  }

  // Fallback: Deterministic dynamic base price if not explicitly in the list
  // Hash characters to assign standard realistic price range between 150 and 4500
  const hash = cleanSym.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const ranges = [150, 350, 750, 1250, 2200, 3200, 4500];
  const basePrice = ranges[hash % ranges.length] + (hash % 100);
  return basePrice;
}

// Simulate live data deterministically
export function getLiveStockData(): StockData[] {
  return FNO_STOCKS.slice(0, 10).map(symbol => {
    const min = new Date().getMinutes();
    const seed = symbol.charCodeAt(0) + symbol.length;
    
    // Improved Mock Spot Pricing: Get unified realistic base price
    const basePrice = getStockBasePrice(symbol);
    
    const deterministicNoise = Math.sin((min + seed) / 10) * 0.02;
    const lastPrice = basePrice * (1 + deterministicNoise);
    const pChange = deterministicNoise * 100;
    const oiChange = Math.sin(seed + min) * 10;
    const relVolume = 1.0 + Math.abs(Math.cos(seed));
    
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
      side: 'NSE',
      adr: lastPrice * (0.025 + Math.random() * 0.015) 
    } as any;
  });
}

export function getStrikeInterval(price: number): number {
  if (price > 10000) return 200;
  if (price > 5000) return 100;
  if (price > 2000) return 50; 
  if (price > 1000) return 20; // 1000-2000 range usually has 20 point strikes (like ASTRAL)
  if (price > 500) return 10;
  if (price > 100) return 5;
  if (price > 50) return 2.5;
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
    // We use a fixed deterministic "noise" based on the sym+strike to keep it stable but realistic
    const seed = (symbol.split('').reduce((a, b) => a + b.charCodeAt(0), 0) + strike) % 100;
    const stableNoise = (seed / 20); // 0 to 5 range, same for same strike

    const distance = Math.abs(currentPrice - strike);
    const decayFactor = Math.exp(-distance / (currentPrice * 0.12));
    const timeValue = (currentPrice * 0.025) * decayFactor;

    chain.push({
      strike,
      type: 'CE',
      lastPrice: Math.max(1.5, Number((ceIntrinsic + timeValue + stableNoise).toFixed(2))),
      change: (stableNoise * 2) - 5,
      oi: 50000 + (seed * 1000),
      oiChange: (seed % 10) - 5,
      iv: 18 + (seed % 15),
      delta: Math.max(0.05, Math.min(0.95, 0.5 + (currentPrice - strike) / (interval * 20))),
      theta: -(0.5 + (seed % 3)),
      gamma: 0.01 + (seed % 5) / 1000,
      vega: 1 + (seed % 10) / 5,
    });
    // Put
    chain.push({
      strike,
      type: 'PUT',
      lastPrice: Math.max(1.5, Number((peIntrinsic + timeValue + stableNoise).toFixed(2))),
      change: (stableNoise * 2) - 5,
      oi: 50000 + (seed * 1000),
      oiChange: (seed % 10) - 5,
      iv: 18 + (seed % 15),
      delta: Math.max(-0.95, Math.min(-0.05, -0.5 + (currentPrice - strike) / (interval * 20))),
      theta: -(0.5 + (seed % 3)),
      gamma: 0.01 + (seed % 5) / 1000,
      vega: 1 + (seed % 10) / 5,
    });
  });
  return chain;
}

export function getFyersOptionSymbol(symbol: string, strike: number, type: 'CE' | 'PE' | 'PUT'): string {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[now.getMonth()];
  const optionType = type === 'PUT' ? 'PE' : type;
  return `NSE:${symbol}${year}${month}${strike}${optionType}`;
}

export async function fetchRealOptionChain(symbol: string, currentPrice: number): Promise<OptionChainData[]> {
  const interval = getStrikeInterval(currentPrice);
  const roundPrice = Math.round(currentPrice / interval) * interval;
  
  // Generate 11 near-the-money strikes around currentPrice (ATM +/- 5 strikes)
  const strikes = Array.from({ length: 11 }, (_, i) => roundPrice - (5 * interval) + i * interval);
  
  const symbolsToFetch: string[] = [];
  strikes.forEach(strike => {
    symbolsToFetch.push(getFyersOptionSymbol(symbol, strike, 'CE'));
    symbolsToFetch.push(getFyersOptionSymbol(symbol, strike, 'PE'));
  });

  try {
    const response = await fetch(`/api/market/quotes?symbols=${symbolsToFetch.join(',')}`);
    const data = await response.json();
    
    if (data.d && Array.isArray(data.d)) {
      const quotesMap: Record<string, any> = {};
      data.d.forEach((item: any) => {
        quotesMap[item.n] = item.v;
      });
      
      const chain: OptionChainData[] = [];
      strikes.forEach(strike => {
        const ceSymbol = getFyersOptionSymbol(symbol, strike, 'CE');
        const peSymbol = getFyersOptionSymbol(symbol, strike, 'PE');
        
        const ceQuote = quotesMap[ceSymbol];
        const peQuote = quotesMap[peSymbol];
        
        const seed = (symbol.split('').reduce((a, b) => a + b.charCodeAt(0), 0) + strike) % 100;
        const stableNoise = (seed / 20);
        const distance = Math.abs(currentPrice - strike);
        const decayFactor = Math.exp(-distance / (currentPrice * 0.12));
        const timeValue = (currentPrice * 0.025) * decayFactor;

        // CE
        if (ceQuote) {
          chain.push({
            strike,
            type: 'CE',
            lastPrice: ceQuote.lp,
            change: ceQuote.chp,
            oi: ceQuote.oi || 10000,
            oiChange: ceQuote.oic || 0,
            iv: ceQuote.iv || (18 + (seed % 15)),
            delta: ceQuote.delta || Math.max(0.05, Math.min(0.95, 0.5 + (currentPrice - strike) / (interval * 20))),
            theta: ceQuote.theta || -(0.5 + (seed % 3)),
            gamma: ceQuote.gamma || (0.01 + (seed % 5) / 1000),
            vega: ceQuote.vega || (1 + (seed % 10) / 5),
          });
        } else {
          const ceIntrinsic = Math.max(0, currentPrice - strike);
          chain.push({
            strike,
            type: 'CE',
            lastPrice: Math.max(1.5, Number((ceIntrinsic + timeValue + stableNoise).toFixed(2))),
            change: (stableNoise * 2) - 5,
            oi: 50000 + (seed * 1000),
            oiChange: (seed % 10) - 5,
            iv: 18 + (seed % 15),
            delta: Math.max(0.05, Math.min(0.95, 0.5 + (currentPrice - strike) / (interval * 20))),
            theta: -(0.5 + (seed % 3)),
            gamma: 0.01 + (seed % 5) / 1000,
            vega: 1 + (seed % 10) / 5,
          });
        }

        // PUT
        if (peQuote) {
          chain.push({
            strike,
            type: 'PUT',
            lastPrice: peQuote.lp,
            change: peQuote.chp,
            oi: peQuote.oi || 10000,
            oiChange: peQuote.oic || 0,
            iv: peQuote.iv || (18 + (seed % 15)),
            delta: peQuote.delta || Math.max(-0.95, Math.min(-0.05, -0.5 + (currentPrice - strike) / (interval * 20))),
            theta: peQuote.theta || -(0.5 + (seed % 3)),
            gamma: peQuote.gamma || (0.01 + (seed % 5) / 1000),
            vega: peQuote.vega || (1 + (seed % 10) / 5),
          });
        } else {
          const peIntrinsic = Math.max(0, strike - currentPrice);
          chain.push({
            strike,
            type: 'PUT',
            lastPrice: Math.max(1.5, Number((peIntrinsic + timeValue + stableNoise).toFixed(2))),
            change: (stableNoise * 2) - 5,
            oi: 50000 + (seed * 1000),
            oiChange: (seed % 10) - 5,
            iv: 18 + (seed % 15),
            delta: Math.max(-0.95, Math.min(-0.05, -0.5 + (currentPrice - strike) / (interval * 20))),
            theta: -(0.5 + (seed % 3)),
            gamma: 0.01 + (seed % 5) / 1000,
            vega: 1 + (seed % 10) / 5,
          });
        }
      });
      return chain;
    }
  } catch (error) {
    console.error("[fetchRealOptionChain] error:", error);
  }

  // Fallback
  return getOptionChain(symbol, currentPrice);
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
    const topGainersArr = sorted.slice(0, 5);
    const topLosersArr = sorted.slice(-5);
    
    const top5Gainers = topGainersArr.map(s => s.symbol);
    const top5Losers = topLosersArr.map(s => s.symbol);
    
    const combined = [...new Set([...top5Gainers, ...top5Losers])].slice(0, 10);
    activeUniverseSymbols = combined;
    lastUniverseRefresh = now;
    
    if (dynamicMarketOverview) {
      if (topGainersArr.length > 0) dynamicMarketOverview.topGainer = topGainersArr[0].symbol;
      if (topLosersArr.length > 0) dynamicMarketOverview.topLoser = topLosersArr[topLosersArr.length - 1].symbol;
      dynamicMarketOverview.advances = allQuotes.filter(q => q.pChange > 0).length;
      dynamicMarketOverview.declines = allQuotes.filter(q => q.pChange < 0).length;
    }
    
    console.log('[Institutional Scanner] Universe Refreshed:', activeUniverseSymbols);
    return activeUniverseSymbols;
  } catch (error) {
    console.error('Universe Scan Failed:', error);
    return activeUniverseSymbols.length > 0 ? activeUniverseSymbols : FNO_STOCKS.slice(0, 10);
  }
}

export async function fetchLiveMarketData(trackedSymbols: string[] = []): Promise<StockData[] | null> {
  try {
    const activeUniverse = await getActiveInstitutionalUniverse();
    const combinedUniverse = [...new Set([...activeUniverse, ...trackedSymbols])];
    
    const stockSymbols = combinedUniverse.map(s => `NSE:${s}-EQ`).join(',');
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
        .filter((item: any) => item.n.includes('-EQ') || item.n.includes('-INDEX'))
        .map((item: any) => {
          const symbol = item.n.includes('-INDEX') ? item.n : item.n.split(':')[1].split('-')[0];
          const v = item.v;
          const lastPrice = v.lp;
          const pChange = v.chp;
          const relVolume = 0.9 + Math.random() * 1.5;
          
          let marketRegime = MarketRegime.SIDEWAYS;
          if (Math.abs(pChange) > 2.0 && relVolume > 1.8) {
            marketRegime = MarketRegime.BREAKOUT;
          } else if (Math.abs(pChange) > 1.2) {
            marketRegime = MarketRegime.TRENDING;
          } else if (Math.abs(pChange) < 0.3 && relVolume < 1.0) {
            marketRegime = MarketRegime.RANGE_CHOP;
          }

          return {
            symbol,
            name: symbol,
            lastPrice,
            pChange,
            volume: v.vol,
            relVolume,
            futuresOI: v.oi || 0,
            oiChange: v.oic || 0,
            vwap: v.avg_price || lastPrice,
            ema20: lastPrice * (1 - (Math.random() * 0.02)),
            ema50: lastPrice * (1 - (Math.random() * 0.04)),
            sector: FNO_DATA[symbol]?.sector || 'Index',
            relativeStrength: (pChange - (nifty?.v?.chp || 0)),
            marketRegime,
            trend: pChange > 0 ? Trend.BULLISH : Trend.BEARISH,
            rsi: 40 + (pChange * 2),
            pulse: pChange * 0.7,
            higherTimeframeBias: pChange > 0.5 ? 'BULLISH' : pChange < -0.5 ? 'BEARISH' : 'NEUTRAL',
            lotSize: FNO_DATA[symbol]?.lotSize || 1,
            atr: lastPrice * (0.015),
            adr: lastPrice * (0.03)
          };
        });
    }
    return null;
  } catch (error) {
    console.error("Error fetching Fyers data:", error);
    return null;
  }
}

/**
 * Fetches real quotes for a specific list of symbols (including options)
 */
export async function fetchQuotes(symbols: string[]): Promise<Record<string, any>> {
  if (symbols.length === 0) return {};
  
  try {
    const symbolsStr = symbols.join(',');
    const response = await fetch(`/api/market/quotes?symbols=${symbolsStr}`);
    const data = await response.json();
    
    const quotes: Record<string, any> = {};
    if (data.d && Array.isArray(data.d)) {
      data.d.forEach((item: any) => {
        quotes[item.n] = item.v;
      });
    }
    return quotes;
  } catch (error) {
    console.error("Fetch Quotes Failed:", error);
    return {};
  }
}

export function getMarketOverview() {
  if (dynamicMarketOverview) return dynamicMarketOverview;
  
  // Dynamic mock data that changes deterministically if real data missing
  const minutes = new Date().getMinutes();
  const drift = Math.sin(minutes / 10) * 5;
  return {
    nifty: { price: 24210.50 + drift, change: 120.5 + Math.sin(minutes)*5, pChange: 0.54 },
    bankNifty: { price: 52300.15 + drift*2, change: -45.2, pChange: -0.09 },
    indiaVix: { price: 13.4, change: 0.2, pChange: 1.5 },
    topGainer: 'RELIANCE',
    topLoser: 'TCS',
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
    if (!message) return;
    
    // Fyers Websocket can send full data (in message.d) or a single flat tick message
    let data: Record<string, any> = {};
    
    if (message.d) {
      data = message.d;
    } else if (message.symbol && message.ltp !== undefined) {
      // It's a flat raw tick! Wrap it in a dictionary to reuse the existing parsing logic
      data[message.symbol] = {
        lp: message.ltp,
        ch: message.ch || 0,
        chp: message.chp || 0,
        v: message.v || message.vol_traded_today || 0,
        oi: message.oi || 0,
        oic: message.oic || 0,
        avg_price: message.avg_price || message.ltp
      };
    } else {
      return;
    }
    
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
