/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { StockData, MarketRegime, Trend, OptionChainData } from '../types';

export const FNO_STOCKS = [
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'INFY', 'TCS', 'AXISBANK', 'KOTAKBANK',
  'TATAMOTORS', 'LT', 'BEL', 'HAL', 'TRENT', 'ADANIENT', 'ADANIPORTS', 'COFORGE',
  'CHOLAFIN', 'BAJFINANCE', 'BHARTIARTL', 'M&M', 'SUNPHARMA', 'HINDUNILVR',
  'ITC', 'TITAN', 'ASIANPAINT', 'ULTRACEMCO', 'NTPC', 'POWERGRID', 'ONGC', 'JSWSTEEL'
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

export function getMarketOverview() {
  return {
    nifty: { price: 22450.30, change: 120.5, pChange: 0.54 },
    bankNifty: { price: 47800.15, change: -45.2, pChange: -0.09 },
    indiaVix: { price: 12.4, change: 0.2, pChange: 1.5 },
    topGainer: 'TRENT',
    topLoser: 'TATAMOTORS',
    advances: 104,
    declines: 78
  }
}
