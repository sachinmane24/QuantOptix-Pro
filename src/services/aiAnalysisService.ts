/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";
import { StockData, OptionChainData, AIProbabilityModel, OptionAction, Trend } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function analyzeTradeProbability(
  stock: StockData,
  optionChain: OptionChainData[]
): Promise<AIProbabilityModel> {
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
  const stopLoss = entryPrice * 0.7; // 30% SL as default for options
  const target1 = entryPrice * 1.5;
  const target2 = entryPrice * 2.5;

  return {
    symbol: stock.symbol,
    action,
    strike: bestContract.strike,
    expiry: 'Current Monthly',
    entryPrice,
    stopLoss: parseFloat(stopLoss.toFixed(2)),
    targets: [parseFloat(target1.toFixed(2)), parseFloat(target2.toFixed(2))],
    riskReward: (target1 - entryPrice) / (entryPrice - stopLoss),
    positionSize: '1 Lot',
    probability: aiModel.winProbability
  };
}
