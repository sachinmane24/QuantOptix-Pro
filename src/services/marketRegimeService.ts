/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MarketRegime, RegimeData, StockData } from "../types";
import { ADX } from "technicalindicators";

export class MarketRegimeService {
  /**
   * Identifies the current market regime based on a basket of indicators
   */
  public static calculateRegime(
    niftyData: StockData,
    vixData: StockData,
    advances: number,
    declines: number,
    historicalNiftyPrices: number[]
  ): RegimeData {
    // 1. Calculate ADX and its slope
    let adxValue = 25;
    let adxSlope: 'RISING' | 'FALLING' | 'FLAT' = 'FLAT';
    
    if (historicalNiftyPrices.length >= 28) {
      const adxInput = {
        high: historicalNiftyPrices.map(p => p * 1.001), // Approximate high/low if only close provided
        low: historicalNiftyPrices.map(p => p * 0.999),
        close: historicalNiftyPrices,
        period: 14
      };
      const adxResults = ADX.calculate(adxInput);
      if (adxResults.length >= 2) {
        adxValue = adxResults[adxResults.length - 1].adx;
        const prevAdx = adxResults[adxResults.length - 2].adx;
        adxSlope = adxValue > prevAdx + 0.5 ? 'RISING' : adxValue < prevAdx - 0.5 ? 'FALLING' : 'FLAT';
      }
    }

    // 2. Breadth calculation
    const total = advances + declines || 1;
    const breadth = (advances / total) * 100;

    // 3. VIX Percentile proxy
    // In a real app, we'd use historical VIX data. Here we use level as proxy.
    const vix = vixData.lastPrice;
    const vixPercentile = Math.min(100, Math.max(0, (vix - 10) * 5)); // Roughly map 10-30 VIX to 0-100%

    // 4. Regime Decision Tree
    let regime = MarketRegime.SIDEWAYS;
    let description = "Market is in a neutral/choppy range.";

    if (adxValue > 25 && adxSlope === 'RISING') {
      regime = MarketRegime.TRENDING;
      description = "Strong trending regime detected. ADX is rising.";
    } else if (vix > 20) {
      regime = MarketRegime.HIGH_VOLATILITY;
      description = "High volatility regime. Expect wide swings and IV expansion.";
    } else if (adxValue < 18) {
      regime = MarketRegime.RANGE_CHOP;
      description = "Low momentum range chop. ADX is low.";
    } else if (Math.abs(niftyData.vwap - niftyData.lastPrice) / niftyData.lastPrice < 0.001) {
      regime = MarketRegime.MEAN_REVERSION;
      description = "Price hugging VWAP. Mean reversion likely.";
    }

    // Special case for Expiry Pinning
    const now = new Date();
    const istHours = now.getUTCHours() + 5.5; // Rough IST
    if (istHours > 14.5 && breadth > 40 && breadth < 60) {
       // Late day, neutral breadth - often pinning near large OI
       // (Simplified check)
    }

    return {
      regime,
      adx: adxValue,
      adXSlope: adxSlope,
      vixPercentile,
      breadth,
      description
    };
  }
}
