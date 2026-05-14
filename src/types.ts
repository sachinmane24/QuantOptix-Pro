/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export enum Trend {
  BULLISH = 'BULLISH',
  BEARISH = 'BEARISH',
  SIDEWAYS = 'SIDEWAYS',
}

export enum MarketRegime {
  TRENDING = 'Trending',
  SIDEWAYS = 'Sideways',
  BREAKOUT = 'Breakout',
  HIGH_VOLATILITY = 'High Volatility',
}

export enum OptionAction {
  BUY_CE = 'BUY CE',
  BUY_PE = 'BUY PE',
}

export interface StockData {
  symbol: string;
  name: string;
  lastPrice: number;
  pChange: number;
  volume: number;
  relVolume: number;
  futuresOI: number;
  oiChange: number;
  vwap: number;
  ema20: number;
  ema50: number;
  sector: string;
  relativeStrength: number; // vs Nifty
  marketRegime: MarketRegime;
  trend: Trend;
  rsi: number;
  lotSize?: number;
}

export interface OptionChainData {
  strike: number;
  type: 'CE' | 'PUT';
  lastPrice: number;
  change: number;
  oi: number;
  oiChange: number;
  iv: number;
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
}

export interface AIProbabilityModel {
  winProbability: number;
  confidence: 'Low' | 'Medium' | 'High';
  momentumScore: number;
  institutionalActivityScore: number;
  breakoutQualityScore: number;
  riskScore: number;
  summary: string;
}

export interface TradeRecommendation {
  symbol: string;
  action: OptionAction;
  strike: number;
  expiry: string;
  entryPrice: number;
  stopLoss: number;
  targets: number[];
  riskReward: number;
  positionSize: string;
  probability: number;
}

export interface RiskSettings {
  maxCapital: number;
  maxTradesPerDay: number;
  maxLossPerDay: number;
  riskPerTrade: number; // percentage
  killSwitch: boolean;
}
