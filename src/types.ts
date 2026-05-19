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
  RANGE_CHOP = 'Range Chop',
  MEAN_REVERSION = 'Mean Reversion',
  HIGH_VOLATILITY = 'High Volatility',
  EXPIRED_PINNING = 'Expiry Pinning'
}

export interface RegimeData {
  regime: MarketRegime;
  adx: number;
  adXSlope: 'RISING' | 'FALLING' | 'FLAT';
  vixPercentile: number;
  breadth: number; // percentage of stocks advancing
  description: string;
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
  pulse: number;
  higherTimeframeBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  lotSize?: number;
  atr?: number;
  adr?: number;
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
  fyersSymbol?: string;
  action: OptionAction;
  strike: number;
  expiry: string;
  entryPrice: number;
  stopLoss: number;
  targets: number[];
  riskReward: number;
  positionSize: string;
  probability: number;
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
}

export interface ScannerLog {
  id: string;
  timestamp: Date;
  symbol: string;
  action: string;
  status: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  reason: string;
}

export interface Position {
  id: string;
  userId: string;
  symbol: string;
  fyersSymbol: string;
  type: string;
  optionType: 'CE' | 'PUT' | 'PE';
  strike: number;
  qty: number;
  entry: number;
  sl: number;
  tsl?: number;
  targets: number[];
  pnl: number;
  currentPrice: number;
  status: 'ACTIVE' | 'OPEN' | 'CLOSED';
  timestamp: any;
  prob?: number;
  entryGreeks?: any;
  exitGreeks?: any;
  exitReason?: string;
  exit?: number;
  closedAt?: any;
}

export interface RiskSettings {
  userId?: string;
  maxCapital: number;
  maxTradesPerDay: number;
  maxLossPerDay: number;
  riskPerTrade: number; // percentage
  killSwitch: boolean;
  maxConcurrentTrades?: number;
  maxCapitalPerTrade?: number;
}
