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
  const iv = bestContract.iv / 100;
  
  // Institutional Logic: 
  // 1. Stop Loss based on Volatility (IV) and Breakout Quality
  // High Volatility = We give more room, but weighted by riskScore
  // Breakout Quality = Higher quality leads to tighter SL expectations
  const baseRisk = 0.20; // 20% base risk
  const riskAdjustment = (aiModel.riskScore / 10); // Scale risk 1-10 to 0.1-1.0
  const volAdjustment = (iv > 0.3 ? 0.05 : 0); // Add 5% if IV is high (>30%)
  
  const slPercent = Math.max(0.1, baseRisk + volAdjustment - (aiModel.breakoutQualityScore * 0.01));
  const stopLoss = entryPrice * (1 - slPercent);

  // 2. Targets based on Momentum and Institutional Activity
  // Momentum score drives the stretch factor
  const momentumStretch = 1 + (aiModel.momentumScore / 10);
  const target1 = entryPrice * (1 + (slPercent * 1.5 * momentumStretch)); // Aim for min 1.5R adjusted by momentum
  const target2 = entryPrice * (1 + (slPercent * 3.0 * momentumStretch)); // Aim for 3R extension
  const target3 = entryPrice * (1 + (slPercent * 5.0 * momentumStretch)); // Moon shot

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
    riskReward: (target1 - entryPrice) / (entryPrice - stopLoss),
    positionSize: '1 Lot',
    probability: aiModel.winProbability
  };
}
