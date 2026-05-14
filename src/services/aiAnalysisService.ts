/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";
import { StockData, OptionChainData, AIProbabilityModel, OptionAction, Trend } from "../types";
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
      return {
        winProbability: 50,
        confidence: 'Low',
        momentumScore: 5,
        institutionalActivityScore: 5,
        breakoutQualityScore: 5,
        riskScore: 5,
        summary: "AI analysis server unreachable."
      };
    }
  }

  // Server-side (or dev with local client) execution
  if (!ai) {
    return {
      winProbability: 50,
      confidence: 'Low',
      momentumScore: 5,
      institutionalActivityScore: 5,
      breakoutQualityScore: 5,
      riskScore: 5,
      summary: "AI Service not initialized."
    };
  }

  try {
    const prompt = `
      As an expert quant trader, analyze the following stock and options data for ${stock.symbol}.
      Current Price: ${stock.lastPrice}
      Price Change: ${stock.pChange}%
      Relative Volume: ${stock.relVolume}
      Futures OI Change: ${stock.oiChange}%
      Trend: ${stock.trend}
      Market Regime: ${stock.marketRegime}
      Sector: ${stock.sector}
      RSI: ${stock.rsi}
      
      Option Chain Data (Top 5 Strikes):
      ${JSON.stringify(optionChain.slice(0, 5))}
      
      Focus on HIGH PROBABILITY OPTIONS BUYING opportunities. 
      Analyze institutional activity, momentum, and volatility expansion.
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
    return {
      winProbability: 50,
      confidence: 'Low',
      momentumScore: 5,
      institutionalActivityScore: 5,
      breakoutQualityScore: 5,
      riskScore: 5,
      summary: "AI analysis failed to load."
    };
  }
}

export function generateRecommendation(
  stock: StockData,
  aiModel: AIProbabilityModel,
  optionChain: OptionChainData[]
): any {
  const action = stock.trend === Trend.BULLISH ? OptionAction.BUY_CE : OptionAction.BUY_PE;
  const atmStrike = Math.round(stock.lastPrice / 50) * 50;
  
  // Select best strike (slightly ITM or ATM)
  let bestContract;
  if (action === OptionAction.BUY_CE) {
    bestContract = optionChain.find(c => c.type === 'CE' && c.strike <= atmStrike) || optionChain[0];
  } else {
    bestContract = optionChain.find(c => c.type === 'PUT' && c.strike >= atmStrike) || optionChain[0];
  }

  const entryPrice = bestContract.lastPrice;
  const delta = Math.abs(bestContract.delta);
  
  // Institutional Logic: 
  // 1. Spot Stop Loss based on ATR (Institutional Standard: 1.5 * ATR)
  const atr = stock.atr || (stock.lastPrice * 0.015);
  const spotStopLossDistance = atr * 1.5;
  
  // 2. Map Spot SL to Option SL using Delta
  // Change in Option Price ≈ Change in Spot Price * Delta
  const optionStopLossDistance = spotStopLossDistance * delta;
  
  // Factor in time decay and IV buffer (5% of premium)
  const slBuffer = entryPrice * 0.05;
  const stopLoss = Math.max(entryPrice * 0.1, entryPrice - optionStopLossDistance - slBuffer);

  // 3. Targets based on R-Multiples (Risk-Reward)
  // Standard Institutional Targets: 1.5R, 3R, 5R
  const riskValue = entryPrice - stopLoss;
  
  const target1 = entryPrice + (riskValue * 1.5); // 1.5R
  const target2 = entryPrice + (riskValue * 3.0); // 3R
  const target3 = entryPrice + (riskValue * 5.0); // 5R

  return {
    symbol: stock.symbol,
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
    probability: aiModel.winProbability
  };
}
