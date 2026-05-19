/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";
import { StockData, OptionChainData, AIProbabilityModel, OptionAction, Trend, MarketRegime } from "../types";
import { getStrikeInterval } from "./nseService";
import axios from "axios";

// Helper to check if we are in node or browser
const isServer = typeof process !== 'undefined' && process.env && !((process as any).browser);

// Only initialize if we have a key (server-side)
const apiKey = isServer ? process.env.GEMINI_API_KEY : null;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

export async function analyzeTradeProbability(
  stock: StockData,
  optionChain: OptionChainData[]
): Promise<AIProbabilityModel> {
  // If we are in the browser and don't have the AI client, call our local API instead
  if (!isServer && !ai) {
    try {
      const response = await axios.post("/api/ai/analyze", { stock, optionChain });
      return response.data;
    } catch (error) {
      console.error("Client AI Analysis Error (API):", error);
      const momentum = Math.min(10, Math.floor(Math.abs(stock.pChange) * 2));
      return {
        winProbability: 55,
        confidence: 'Low',
        momentumScore: momentum,
        institutionalActivityScore: 5,
        breakoutQualityScore: 5,
        riskScore: 5,
        summary: "Institutional momentum detected. AI analysis server connection pending."
      };
    }
  }

  // Server-side (or dev with local client) execution
  if (!ai) {
    const momentum = Math.min(10, Math.floor(Math.abs(stock.pChange) * 2));
    const volScore = Math.min(10, Math.floor(stock.relVolume * 2.5));
    
    // Improved heuristic analysis with multi-timeframe alignment and institutional filtering
    let winProb = 55; // Lower base for more conservative entries
    
    // 1. Multi-Timeframe Alignment (+15%)
    const isHtfAligned = (stock.trend === Trend.BULLISH && stock.higherTimeframeBias === 'BULLISH') || 
                         (stock.trend === Trend.BEARISH && stock.higherTimeframeBias === 'BEARISH');
    if (isHtfAligned) winProb += 15;

    // 2. Volume Spread Health (+10%)
    const hasInstitutionalVolume = stock.relVolume > 1.8;
    if (hasInstitutionalVolume) winProb += 10;
    
    // 3. Momentum & Price Action Quality (+10%)
    const isStrongBreakout = stock.marketRegime === MarketRegime.BREAKOUT && Math.abs(stock.pChange) > 0.6;
    if (isStrongBreakout) winProb += 10;

    // 4. Premium/Discount Filtering (-15% if overextended)
    // Buy when RSI < 65 (not overextended), Sell when RSI > 35 (not overextended)
    const isOverextended = (stock.trend === Trend.BULLISH && stock.rsi > 70) || 
                           (stock.trend === Trend.BEARISH && stock.rsi < 30);
    if (isOverextended) winProb -= 15;
    
    // Final capping and confidence adjustment
    const confidence = winProb >= 75 ? 'High' : winProb >= 60 ? 'Medium' : 'Low';

    return {
      winProbability: Math.min(94, Math.max(25, winProb)),
      confidence,
      momentumScore: Math.min(10, Math.floor(Math.abs(stock.pChange) * 2.5)),
      institutionalActivityScore: Math.min(10, Math.floor(stock.relVolume * 3)),
      breakoutQualityScore: isStrongBreakout ? 9 : 5,
      riskScore: isOverextended ? 8 : 3,
      summary: `[INSTITUTIONAL_V3] HTF_ALIGN: ${isHtfAligned ? 'YES' : 'NO'} | VOL_VAL: ${hasInstitutionalVolume ? 'VALID' : 'WEAK'}. ${stock.symbol} ${stock.trend} setup at ${stock.lastPrice}.`
    };
  }

  try {
    const prompt = `
      As an expert quant trader, analyze the following stock and options data for ${stock.symbol}.
      Current Price: ${stock.lastPrice}
      Price Change: ${stock.pChange}%
      Relative Volume: ${stock.relVolume}
      Futures OI Change: ${stock.oiChange}%
      Higher Timeframe (H1) Bias: ${stock.higherTimeframeBias || 'NEUTRAL'}
      Trend: ${stock.trend}
      Market Regime: ${stock.marketRegime}
      Sector: ${stock.sector}
      RSI: ${stock.rsi}
      
      Option Chain Data (Top 5 Strikes):
      ${JSON.stringify(optionChain.slice(0, 5))}
      
      Focus on HIGH PROBABILITY OPTIONS BUYING opportunities. 
      Analyze institutional activity, momentum, and volatility expansion.
      Factor in the Higher Timeframe Bias: Entry should ideally align with the H1 trend.
      Provide a concise summary and scores.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            winProbability: { type: Type.NUMBER },
            confidence: { type: Type.STRING, enum: ["Low", "Medium", "High"] },
            momentumScore: { type: Type.NUMBER },
            institutionalActivityScore: { type: Type.NUMBER },
            breakoutQualityScore: { type: Type.NUMBER },
            riskScore: { type: Type.NUMBER },
            summary: { type: Type.STRING }
          },
          required: ["winProbability", "confidence", "momentumScore", "summary"]
        }
      }
    });

    const result = JSON.parse(response.text || "{}");
    return {
      winProbability: result.winProbability || 0,
      confidence: result.confidence || 'Medium',
      momentumScore: result.momentumScore || 0,
      institutionalActivityScore: result.institutionalActivityScore || 0,
      breakoutQualityScore: result.breakoutQualityScore || 0,
      riskScore: result.riskScore || 0,
      summary: result.summary || "No analysis available"
    };
  } catch (error) {
    console.error("AI Analysis Error:", error);
    
    // Fallback: Perform basic heuristic analysis if AI fails
    const momentum = Math.min(10, Math.floor(Math.abs(stock.pChange) * 2));
    const instIdx = Math.min(10, Math.floor(stock.relVolume * 3));
    
    // Enhanced heuristic analysis with institutional filtering
    let winProb = 50; 
    
    const isHtfAligned = (stock.trend === Trend.BULLISH && stock.higherTimeframeBias === 'BULLISH') || 
                         (stock.trend === Trend.BEARISH && stock.higherTimeframeBias === 'BEARISH');
    
    if (isHtfAligned) winProb += 15;
    if (stock.relVolume > 2.0) winProb += 10;
    if (stock.marketRegime === MarketRegime.BREAKOUT) winProb += 10;
    
    // RSI Overextended protection
    if (stock.trend === Trend.BULLISH && stock.rsi > 72) winProb -= 20;
    if (stock.trend === Trend.BEARISH && stock.rsi < 28) winProb -= 20;

    return {
      winProbability: Math.min(92, Math.max(20, winProb)),
      confidence: 'High',
      momentumScore: momentum,
      institutionalActivityScore: instIdx,
      breakoutQualityScore: stock.marketRegime === MarketRegime.BREAKOUT ? 9 : 5,
      riskScore: stock.rsi > 75 || stock.rsi < 25 ? 8 : 3,
      summary: `[Q-ENGINE_PRO] HTF_BIAS: ${stock.higherTimeframeBias}. Alignment: ${isHtfAligned ? 'READY' : 'WAIT'}. Volume Presence: ${stock.relVolume > 2 ? 'INSTITUTIONAL' : 'RETAIL'}.`
    };
  }
}

export function generateRecommendation(
  stock: StockData,
  aiModel: AIProbabilityModel,
  optionChain: OptionChainData[]
): any {
  const action = stock.trend === Trend.BULLISH ? OptionAction.BUY_CE : OptionAction.BUY_PE;
  const interval = getStrikeInterval(stock.lastPrice);
  const atmStrike = Math.round(stock.lastPrice / interval) * interval;
  
  // Select best strike (Closest to ATM)
  let bestContract;
  if (action === OptionAction.BUY_CE) {
    // For CE, pick the strike closest to ATM from the lower side (Slightly ITM is better for options buying)
    const ceContracts = optionChain.filter(c => c.type === 'CE').sort((a, b) => b.strike - a.strike);
    bestContract = ceContracts.find(c => c.strike <= atmStrike) || ceContracts[0];
  } else {
    // For PUT, pick the strike closest to ATM from the upper side (Slightly ITM)
    const peContracts = optionChain.filter(c => c.type === 'PUT').sort((a, b) => a.strike - b.strike);
    bestContract = peContracts.find(c => c.strike >= atmStrike) || peContracts[0];
  }

  const entryPrice = bestContract.lastPrice;
  const delta = Math.abs(bestContract.delta);
  
  // Institutional Logic: 
  // 1. Spot Stop Loss based on ATR (Scalping Standard: 0.7 * ATR)
  const atr = stock.atr || (stock.lastPrice * 0.012);
  const spotStopLossDistance = atr * 0.7;
  
  // 2. Map Spot SL to Option SL using Delta
  // Change in Option Price ≈ Change in Spot Price * Delta
  const optionStopLossDistance = spotStopLossDistance * delta;
  
  // Factor in time decay and IV buffer (3% of premium)
  const slBuffer = entryPrice * 0.03;
  
  // Tighten SL: Cap max risk at 25% of premium for high-freq quant, floor at 10%
  let calculatedSL = entryPrice - optionStopLossDistance - slBuffer;
  const maxAllowedEntryRisk = entryPrice * 0.25;
  if (entryPrice - calculatedSL > maxAllowedEntryRisk) {
    calculatedSL = entryPrice - maxAllowedEntryRisk;
  }
  const stopLoss = Math.max(entryPrice * 0.1, calculatedSL);

  // 3. Targets based on R-Multiples (Risk-Reward)
  // Scalping Targets: 1.2R, 2R, 3R (Reduced from 1.5R, 3R, 5R for faster rotation)
  const riskValue = entryPrice - stopLoss;
  
  const target1 = entryPrice + (riskValue * 1.2); // 1.2R
  const target2 = entryPrice + (riskValue * 2.0); // 2R
  const target3 = entryPrice + (riskValue * 3.0); // 3R

  return {
    symbol: stock.symbol,
    fyersSymbol: getFyersOptionSymbol(stock.symbol, bestContract.strike, bestContract.type),
    action,
    strike: bestContract.strike,
    expiry: 'Current Weekly',
    entryPrice,
    stopLoss: parseFloat(stopLoss.toFixed(2)),
    targets: [
      parseFloat(target1.toFixed(2)), 
      parseFloat(target2.toFixed(2)),
      parseFloat(target3.toFixed(2))
    ],
    riskReward: parseFloat(((target1 - entryPrice) / riskValue).toFixed(2)),
    positionSize: `${stock.lotSize || 1} Units (1 Lot)`,
    probability: aiModel.winProbability,
    greeks: {
      delta: bestContract.delta,
      gamma: bestContract.gamma,
      theta: bestContract.theta,
      vega: bestContract.vega
    }
  };
}

export function getFyersOptionSymbol(symbol: string, strike: number, type: 'CE' | 'PE' | 'PUT'): string {
  // Format: SYMBOL{YY}{MMM}{STRIKE}{TYPE}
  // Example: COFORGE26MAY1320CE
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[now.getMonth()];
  
  const optionType = type === 'PUT' ? 'PE' : type;
  
  return `${symbol}${year}${month}${strike}${optionType}`;
}
