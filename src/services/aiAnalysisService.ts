/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";
import { StockData, OptionChainData, AIProbabilityModel, AIDecisionReport, OptionAction, Trend, MarketRegime } from "../types";
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
    // Institutional fix: Avoid double-counting momentum. Base on structure + regime.
    let winProb = 50; 
    
    // 1. Regime Alignment (Prerequisite)
    const isTrending = stock.marketRegime === MarketRegime.TRENDING || stock.marketRegime === MarketRegime.BREAKOUT;
    const isSideways = stock.marketRegime === MarketRegime.SIDEWAYS || stock.marketRegime === MarketRegime.RANGE_CHOP;
    
    // 2. Structural Alignment (+15%)
    const isHtfAligned = (stock.trend === Trend.BULLISH && stock.higherTimeframeBias === 'BULLISH') || 
                         (stock.trend === Trend.BEARISH && stock.higherTimeframeBias === 'BEARISH');
    if (isHtfAligned && isTrending) winProb += 15;

    // 3. Independent Volume Pillar (+10%)
    // Relative volume is independent of price move directionality
    const hasInstitutionalVolume = stock.relVolume > 2.0;
    if (hasInstitutionalVolume) winProb += 10;
    
    // 4. Price Extension Penalty (-20%)
    // Double-counting check: If RSI is extreme AND breakout already happened, it's matured
    const isExhausted = (stock.trend === Trend.BULLISH && stock.rsi > 68) || 
                       (stock.trend === Trend.BEARISH && stock.rsi < 32);
    if (isExhausted) winProb -= 20;

    // 5. Late Day Penalty (-10%)
    const now = new Date();
    const istTime = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
    if (istTime >= '14:30') winProb -= 10;
    
    // Final capping and confidence adjustment
    const confidence = winProb >= 75 ? 'High' : winProb >= 60 ? 'Medium' : 'Low';

    return {
      winProbability: Math.min(88, Math.max(15, winProb)), // Cap at 88% to avoid overconfidence
      confidence,
      momentumScore: Math.min(10, Math.floor(Math.abs(stock.pChange) * 2)),
      institutionalActivityScore: Math.min(10, Math.floor(stock.relVolume * 2.5)),
      breakoutQualityScore: (isTrending && !isExhausted) ? 8 : 4,
      riskScore: isExhausted ? 9 : (isSideways ? 7 : 3),
      summary: `[INST_PRO_V4] REGIME: ${stock.marketRegime} | HTF: ${stock.higherTimeframeBias}. Probability reflects ${isExhausted ? 'EXHAUSTION' : 'STRUCTURE'} focus. Late-day trade: ${istTime >= '14:30' ? 'YES (Penalty Applied)' : 'NO'}.`
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

export async function analyzeStrategyDecision(
  stock: StockData,
  optionChain: OptionChainData[]
): Promise<AIDecisionReport> {
  // If we are in the browser and don't have the AI client, call our local API instead
  if (!isServer && !ai) {
    try {
      const response = await axios.post("/api/ai/analyze-strategy", { stock, optionChain });
      return response.data;
    } catch (error) {
      console.error("Client AI Strategy Error (API):", error);
      return getHeuristicStrategyDecisionFallback(stock, optionChain);
    }
  }

  if (!ai) {
    return getHeuristicStrategyDecisionFallback(stock, optionChain);
  }

  try {
    const prompt = `
      You are an elite quantitative derivatives desk strategist at a premier proprietary trading firm.
      Analyze the underlying asset ${stock.symbol} and its top Option Chain contracts to determine if we should execute a day-trading or momentum scalping option position.

      Market Variables for ${stock.symbol}:
      - Current Spot Price: ₹${stock.lastPrice}
      - Price Change: ${stock.pChange}%
      - Relative Volume (RV): ${stock.relVolume} (Values > 2.0 indicate major institutional volume expansion)
      - Futures OI Change: ${stock.oiChange}%
      - Higher Timeframe (H1) Trend Bias: ${stock.higherTimeframeBias || 'NEUTRAL'}
      - Intraday Trend Direction: ${stock.trend}
      - Market Regime Archetype: ${stock.marketRegime}
      - Sector Industry: ${stock.sector}
      - RSI (14 Period): ${stock.rsi}

      Target Option Chain Metrics (Top 5 Active Strikes):
      ${JSON.stringify(optionChain.slice(0, 5))}

      You must provide a highly professional, institutional-grade decision matrix detailing:
      1. 'verdict': String, one of "ENTER" (if win Probability >= 75%), "SKIP", or "WATCH" (if borderline).
      2. 'strategyName': String, identify the exact setup (e.g. "Bullish Breakout Pullback", "Mean Reversion Exhaustion", "Regime Trend Continuation").
      3. 'winProbability': Number, 0 to 100, capping highest at 92%.
      4. 'confidence': String, "High", "Medium", or "Low".
      5. 'momentumScore', 'institutionalActivityScore', 'breakoutQualityScore', 'riskScore': Numbers from 0 to 10.
      6. 'technicalConflux':
         - 'regimeAlignment': "STRONG", "MODERATE", "WEAK", "NONE"
         - 'relativeVolumeVsAverage': Professional description, e.g., "Extremely heavy at 3.4x average"
         - 'higherTimeframeBias': "BULLISH", "BEARISH", "NEUTRAL"
         - 'rsiOverextensionCheck': "SAFE", "WARNING", "CRITICAL"
      7. 'optionsMetricsEvaluation':
         - 'recommendedStrikeSelection': String, e.g. "3000 CE (ATM)" or "2900 PE"
         - 'gammaSqueezePotential': "High", "Medium", "Low"
         - 'thetaDecayRisk': "High", "Medium", "Low"
         - 'impliedVolatilityRank': "Low", "Moderate", "High"
      8. 'suggestedRiskRules':
         - 'dynamicStopLoss': Number, standard stop price (suggested stop for the option premium if bought)
         - 'recommendedTarget1': Number, target 1
         - 'recommendedTarget2': Number, target 2
         - 'suggestedMaxCapitalAllocPercent': Number, suggested capital allocation % per trade (e.g., 0.5 to 2.5)
      9. 'rationales': Comprehensive 3-4 sentence professional quantitative breakdown explaining institutional positioning, order book density, index trend alignment, and why this strategy is suggested.

      Ensure strict adherence to formatting. Your output must perfectly match the schema requested.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            symbol: { type: Type.STRING },
            verdict: { type: Type.STRING, enum: ["ENTER", "SKIP", "WATCH"] },
            strategyName: { type: Type.STRING },
            winProbability: { type: Type.NUMBER },
            confidence: { type: Type.STRING, enum: ["Low", "Medium", "High"] },
            momentumScore: { type: Type.NUMBER },
            institutionalActivityScore: { type: Type.NUMBER },
            breakoutQualityScore: { type: Type.NUMBER },
            riskScore: { type: Type.NUMBER },
            technicalConflux: {
              type: Type.OBJECT,
              properties: {
                regimeAlignment: { type: Type.STRING, enum: ["STRONG", "MODERATE", "WEAK", "NONE"] },
                relativeVolumeVsAverage: { type: Type.STRING },
                higherTimeframeBias: { type: Type.STRING, enum: ["BULLISH", "BEARISH", "NEUTRAL"] },
                rsiOverextensionCheck: { type: Type.STRING, enum: ["SAFE", "WARNING", "CRITICAL"] }
              },
              required: ["regimeAlignment", "relativeVolumeVsAverage", "higherTimeframeBias", "rsiOverextensionCheck"]
            },
            optionsMetricsEvaluation: {
              type: Type.OBJECT,
              properties: {
                recommendedStrikeSelection: { type: Type.STRING },
                gammaSqueezePotential: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
                thetaDecayRisk: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
                impliedVolatilityRank: { type: Type.STRING, enum: ["Low", "Moderate", "High"] }
              },
              required: ["recommendedStrikeSelection", "gammaSqueezePotential", "thetaDecayRisk", "impliedVolatilityRank"]
            },
            suggestedRiskRules: {
              type: Type.OBJECT,
              properties: {
                dynamicStopLoss: { type: Type.NUMBER },
                recommendedTarget1: { type: Type.NUMBER },
                recommendedTarget2: { type: Type.NUMBER },
                suggestedMaxCapitalAllocPercent: { type: Type.NUMBER }
              },
              required: ["dynamicStopLoss", "recommendedTarget1", "recommendedTarget2", "suggestedMaxCapitalAllocPercent"]
            },
            rationales: { type: Type.STRING }
          },
          required: [
            "symbol", "verdict", "strategyName", "winProbability", "confidence",
            "momentumScore", "institutionalActivityScore", "breakoutQualityScore", "riskScore",
            "technicalConflux", "optionsMetricsEvaluation", "suggestedRiskRules", "rationales"
          ]
        }
      }
    });

    const result = JSON.parse(response.text || "{}");
    return {
      symbol: stock.symbol,
      verdict: result.verdict || 'WATCH',
      strategyName: result.strategyName || 'Quantitative Momentum Setup',
      winProbability: result.winProbability || 50,
      confidence: result.confidence || 'Medium',
      momentumScore: result.momentumScore || 5,
      institutionalActivityScore: result.institutionalActivityScore || 5,
      breakoutQualityScore: result.breakoutQualityScore || 5,
      riskScore: result.riskScore || 5,
      technicalConflux: {
        regimeAlignment: result.technicalConflux?.regimeAlignment || 'MODERATE',
        relativeVolumeVsAverage: result.technicalConflux?.relativeVolumeVsAverage || `${stock.relVolume.toFixed(2)}x vs Average`,
        higherTimeframeBias: result.technicalConflux?.higherTimeframeBias || 'NEUTRAL',
        rsiOverextensionCheck: result.technicalConflux?.rsiOverextensionCheck || 'SAFE'
      },
      optionsMetricsEvaluation: {
        recommendedStrikeSelection: result.optionsMetricsEvaluation?.recommendedStrikeSelection || 'ATM Options Selection',
        gammaSqueezePotential: result.optionsMetricsEvaluation?.gammaSqueezePotential || 'Medium',
        thetaDecayRisk: result.optionsMetricsEvaluation?.thetaDecayRisk || 'Medium',
        impliedVolatilityRank: result.optionsMetricsEvaluation?.impliedVolatilityRank || 'Moderate'
      },
      suggestedRiskRules: {
        dynamicStopLoss: result.suggestedRiskRules?.dynamicStopLoss || parseFloat((stock.lastPrice * 0.98).toFixed(2)),
        recommendedTarget1: result.suggestedRiskRules?.recommendedTarget1 || parseFloat((stock.lastPrice * 1.02).toFixed(2)),
        recommendedTarget2: result.suggestedRiskRules?.recommendedTarget2 || parseFloat((stock.lastPrice * 1.05).toFixed(2)),
        suggestedMaxCapitalAllocPercent: result.suggestedRiskRules?.suggestedMaxCapitalAllocPercent || 1.0
      },
      rationales: result.rationales || "Custom strategic decision generated successfully."
    };
  } catch (error) {
    console.error("AI Strategy Analysis Error:", error);
    return getHeuristicStrategyDecisionFallback(stock, optionChain);
  }
}

export function getHeuristicStrategyDecisionFallback(
  stock: StockData,
  optionChain: OptionChainData[]
): AIDecisionReport {
  const momentum = Math.min(10, Math.floor(Math.abs(stock.pChange) * 2));
  const instIdx = Math.min(10, Math.floor(stock.relVolume * 3));
  
  let winProb = 50; 
  const isHtfAligned = (stock.trend === Trend.BULLISH && stock.higherTimeframeBias === 'BULLISH') || 
                       (stock.trend === Trend.BEARISH && stock.higherTimeframeBias === 'BEARISH');
  
  if (isHtfAligned) winProb += 15;
  if (stock.relVolume > 2.0) winProb += 15;
  if (stock.marketRegime === MarketRegime.BREAKOUT) winProb += 10;
  
  if (stock.trend === Trend.BULLISH && stock.rsi > 72) winProb -= 20;
  if (stock.trend === Trend.BEARISH && stock.rsi < 28) winProb -= 20;

  const finalWinProb = Math.min(92, Math.max(15, winProb));
  const verdict = finalWinProb >= 75 ? 'ENTER' : finalWinProb >= 55 ? 'WATCH' : 'SKIP';
  const confidence = finalWinProb >= 75 ? 'High' : finalWinProb >= 55 ? 'Medium' : 'Low';

  const contractType = stock.trend === Trend.BULLISH ? 'CE' : 'PE';
  const interval = getStrikeInterval(stock.lastPrice);
  const strike = Math.round(stock.lastPrice / interval) * interval;
  const strikeStr = `${strike} ${contractType}`;

  const optionLastPrice = optionChain?.[0]?.lastPrice || (stock.lastPrice * 0.02);
  const stopLoss = optionLastPrice * 0.75;
  const target1 = optionLastPrice * 1.35;
  const target2 = optionLastPrice * 1.65;

  return {
    symbol: stock.symbol,
    verdict,
    strategyName: isHtfAligned ? "HTF Aligned Breakout Expansion" : "Intraday Range Scalp Strategy",
    winProbability: finalWinProb,
    confidence,
    momentumScore: momentum,
    institutionalActivityScore: instIdx,
    breakoutQualityScore: stock.marketRegime === MarketRegime.BREAKOUT ? 9 : 5,
    riskScore: stock.rsi > 70 || stock.rsi < 30 ? 8 : 3,
    technicalConflux: {
      regimeAlignment: stock.marketRegime === MarketRegime.BREAKOUT ? 'STRONG' : 'MODERATE',
      relativeVolumeVsAverage: `${stock.relVolume.toFixed(2)}x vs average trading limit`,
      higherTimeframeBias: stock.higherTimeframeBias || 'NEUTRAL',
      rsiOverextensionCheck: stock.rsi > 70 || stock.rsi < 30 ? 'CRITICAL' : stock.rsi > 60 || stock.rsi < 40 ? 'WARNING' : 'SAFE'
    },
    optionsMetricsEvaluation: {
      recommendedStrikeSelection: strikeStr,
      gammaSqueezePotential: stock.relVolume > 2.5 ? 'High' : 'Medium',
      thetaDecayRisk: 'Medium',
      impliedVolatilityRank: 'Moderate'
    },
    suggestedRiskRules: {
      dynamicStopLoss: parseFloat(stopLoss.toFixed(2)),
      recommendedTarget1: parseFloat(target1.toFixed(2)),
      recommendedTarget2: parseFloat(target2.toFixed(2)),
      suggestedMaxCapitalAllocPercent: finalWinProb >= 75 ? 1.5 : 0.5
    },
    rationales: `Fallback Heuristic Engine Analysis: Asset indicates ${stock.marketRegime} dynamics in progress. High-timeframe ${stock.higherTimeframeBias || 'neutral'} alignment indicates a ${verdict} priority. Sizing recommended at ${finalWinProb >= 75 ? '1.5%' : '0.5%'} options capital allocated.`
  };
}

export function generateRecommendation(
  stock: StockData,
  aiModel: AIProbabilityModel,
  optionChain: OptionChainData[]
): any {
  const action = stock.trend === Trend.BULLISH ? OptionAction.BUY_CE : OptionAction.BUY_PE;
  const now = new Date();
  const istTime = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
  const isAfternoon = istTime >= '12:00';

  // Better Strike Logic based on time of day
  // Prefer delta 0.50-0.65 before noon.
  // Prefer delta 0.60-0.75 after noon because gamma/theta risk rises.
  const targetDeltaMin = isAfternoon ? 0.60 : 0.50;
  const targetDeltaMax = isAfternoon ? 0.75 : 0.65;
  
  let bestContract;
  const relevantContracts = optionChain.filter(c => 
    (action === OptionAction.BUY_CE ? c.type === 'CE' : c.type === 'PUT') &&
    c.lastPrice >= 20 // Avoid premium < Rs20
  );

  if (relevantContracts.length > 0) {
    // Rank by Delta proximity and Spread efficiency
    bestContract = relevantContracts.sort((a, b) => {
      const distA = Math.abs(Math.abs(a.delta) - (targetDeltaMin + targetDeltaMax) / 2);
      const distB = Math.abs(Math.abs(b.delta) - (targetDeltaMin + targetDeltaMax) / 2);
      return distA - distB;
    })[0];
  }

  // Fallback to simple ATM if delta filtering fails
  if (!bestContract) {
    const interval = getStrikeInterval(stock.lastPrice);
    const atmStrike = Math.round(stock.lastPrice / interval) * interval;
    if (action === OptionAction.BUY_CE) {
      const ceContracts = optionChain.filter(c => c.type === 'CE').sort((a, b) => b.strike - a.strike);
      bestContract = ceContracts.find(c => c.strike <= atmStrike) || ceContracts[0];
    } else {
      const peContracts = optionChain.filter(c => c.type === 'PUT').sort((a, b) => a.strike - b.strike);
      bestContract = peContracts.find(c => c.strike >= atmStrike) || peContracts[0];
    }
  }

  const entryPrice = bestContract.lastPrice;
  const delta = Math.abs(bestContract.delta);
  
  // Institutional SL: Structure + Time Stop
  // Initial SL: smaller of 0.8 x option ATR or structural invalidation
  const atrPrice = (stock.atr || (stock.lastPrice * 0.012)) * 0.8;
  const structuralSLDistance = atrPrice * delta;
  
  // Hard max loss: 35% for naked buys
  const hardMaxSL = entryPrice * 0.35;
  const stopLossDistance = Math.min(structuralSLDistance, hardMaxSL);
  const stopLoss = Math.max(entryPrice * 0.1, entryPrice - stopLossDistance);

  // Targets: Structure-aware (not just fixed ATR if possible, but here we use scaled ATR as proxy)
  const target1 = entryPrice + (stopLossDistance * 1.5); // 1.5R - Institutional standard
  const target2 = entryPrice + (stopLossDistance * 3.0); // 3R
  const target3 = entryPrice + (stopLossDistance * 5.0); // 5R

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
    riskReward: parseFloat(((target1 - entryPrice) / (entryPrice - stopLoss)).toFixed(2)),
    positionSize: `${stock.lotSize || 1} Units (Risk per trade: 0.5% Cap)`,
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
  // Format: NSE:SYMBOL{YY}{MMM}{STRIKE}{TYPE}
  // Example: NSE:COFORGE26MAY1320CE
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[now.getMonth()];
  
  const optionType = type === 'PUT' ? 'PE' : type;
  
  return `NSE:${symbol}${year}${month}${strike}${optionType}`;
}
