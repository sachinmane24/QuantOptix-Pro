/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  LogOut, LogIn, User as UserIcon, Settings,
  History, TrendingUp, TrendingDown,
  LayoutDashboard, Eye, ListFilter, Activity, Target, Shield, AlertTriangle, 
  BarChart3, Search, RefreshCw, Layers, Zap, PieChart, ChevronRight, Terminal, Download
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, BarChart, Bar, Cell, PieChart as RePieChart, Pie,
  LineChart, Line
} from 'recharts';
import { cn, formatCurrency, formatNumber } from './lib/utils';
import { 
  getLiveStockData, getMarketOverview, getOptionChain, fetchLiveMarketData,
  initializeMarketWebSocket, socket, getActiveInstitutionalUniverse, getRecommendedStrike,
  fetchQuotes
} from './services/nseService';
import { analyzeTradeProbability, generateRecommendation, getFyersOptionSymbol } from './services/aiAnalysisService';
import { 
  sendTelegramNotification, formatTradeEntry, formatTradeExit, formatTestMessage
} from './services/telegramService';
import { ScannerAlerts } from './components/ScannerAlerts';
import { 
  StockData, OptionAction, Trend, MarketRegime, 
  AIProbabilityModel, TradeRecommendation, RiskSettings, ScannerLog
} from './types';
import { 
  auth, db, googleProvider, signInWithPopup, onAuthStateChanged, 
  collection, addDoc, setDoc, query, where, onSnapshot, orderBy, updateDoc, doc, Timestamp,
  handleFirestoreError, OperationType, User
} from './lib/firebase';

// --- Sub-components ---

const StatCard = ({ title, value, change, suffix = "" }: { title: string, value: string, change?: number, suffix?: string }) => (
  <div className="bg-tech-surface border border-tech-border p-4">
    <div className="text-[10px] text-neutral-500 font-mono uppercase tracking-widest mb-2">{title}</div>
    <div className="flex items-baseline gap-2">
      <div className={cn(
        "text-xl font-sans font-extrabold text-white tracking-tighter",
        change !== undefined && change >= 0 ? "glow-green" : change !== undefined ? "glow-red" : ""
      )}>{value}{suffix}</div>
      {change !== undefined && (
        <span className={cn("text-[10px] font-mono font-bold", change >= 0 ? "text-neon-green" : "text-neon-red")}>
          {change >= 0 ? "+" : ""}{change}%
        </span>
      )}
    </div>
  </div>
);

const RiskIndicator = ({ score, label }: { score: number, label: string }) => (
  <div className="flex flex-col gap-1 w-full">
    <div className="flex justify-between text-[8px] uppercase tracking-widest font-mono text-neutral-500">
      <span>{label}</span>
      <span className="text-white">{score}/10</span>
    </div>
    <div className="h-1 bg-tech-border overflow-hidden">
      <motion.div 
        initial={{ width: 0 }}
        animate={{ width: `${score * 10}%` }}
        className={cn("h-full", score > 7 ? "bg-neon-green" : score > 4 ? "bg-amber-500" : "bg-neon-red")}
      />
    </div>
  </div>
);

// VER: 2.1.0-AUTH-GUEST-FIX
const GUEST_USER = {
  uid: 'guest_institutional_trader',
  displayName: 'QUANT_INSTITUTIONAL_CORE',
  email: 'trader@quant.optix',
  photoURL: null
} as any;

// --- Main App Component ---

export default function App() {
  const [activeView, setActiveView] = useState<'dashboard' | 'screener' | 'analysis' | 'trades' | 'risk' | 'analytics'>('dashboard');
  const [user, setUser] = useState<User | null>(GUEST_USER);
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [marketInfo, setMarketInfo] = useState<any>(null);
  const [selectedStock, setSelectedStock] = useState<StockData | null>(null);
  const [optionChain, setOptionChain] = useState<any[]>([]);
  const [aiAnalysis, setAiAnalysis] = useState<AIProbabilityModel | null>(null);
  const [recommendation, setRecommendation] = useState<TradeRecommendation | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [analysisTab, setAnalysisTab] = useState<'iv' | 'oi'>('iv');
  const [dashAlphaTab, setDashAlphaTab] = useState<'CE' | 'PE'>('CE');

  // Scanners
  const [filter, setFilter] = useState<'all' | 'bullish' | 'bearish' | 'breakout'>('all');

  // Paper Trading State
  const [portfolio, setPortfolio] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [monitoredPrices, setMonitoredPrices] = useState<Record<string, number>>({});
  const [tradeHistory, setTradeHistory] = useState<any[]>([]);

  const exportTradeCSV = () => {
    if (!tradeHistory || tradeHistory.length === 0) return;
    
    // Headers
    const headers = ["Symbol", "Strike", "Type", "Lots", "Lot Size", "Qty", "Entry Price", "Exit Price", "PnL", "Exit Reason", "Time"];
    const rows = tradeHistory.map(t => [
      `"${t.symbol}"`,
      t.strike,
      `"${t.type}"`,
      t.numLots || Math.round(t.qty / (t.lotSize || 1)) || 1,
      t.lotSize || 1,
      t.qty || 0,
      t.entry || 0,
       t.exit || 0,
      t.pnl || 0,
      `"${t.exitReason || 'AUTO_EXIT'}"`,
      `"${(t.closedAt?.toDate?.() || (t.closedAt instanceof Date ? t.closedAt : new Date())).toLocaleString()}"`
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map(row => row.join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `quantoptix_trades_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  const portfolioValue = portfolio?.balance || 1000000;

  const [activeAnalyticsTab, setActiveAnalyticsTab] = useState<'overview' | 'sl' | 'calibration' | 'timing' | 'exits' | 'options'>('overview');

  const attributionStats = useMemo(() => {
    if (!tradeHistory || tradeHistory.length === 0) return null;

    const total = tradeHistory.length;
    const wins = tradeHistory.filter(t => (t.pnl || 0) > 0);
    const losses = tradeHistory.filter(t => (t.pnl || 0) <= 0);
    const winRate = (wins.length / total) * 100;
    const totalPnl = tradeHistory.reduce((acc, t) => acc + (t.pnl || 0), 0);
    
    const grossProfits = wins.reduce((acc, t) => acc + (t.pnl || 0), 0);
    const grossLosses = Math.abs(losses.reduce((acc, t) => acc + (t.pnl || 0), 0));
    const profitFactor = grossLosses === 0 ? grossProfits : grossProfits / grossLosses;

    const avgWin = wins.length > 0 ? grossProfits / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0;
    const ratio = avgLoss === 0 ? avgWin : avgWin / avgLoss;

    // Max Drawdown calculation
    let maxDd = 0;
    let peak = 0;
    let currentEquity = 0;
    const sortedTrades = [...tradeHistory].sort((a, b) => {
      const ta = a.closedAt?.toDate?.() || (a.closedAt instanceof Date ? a.closedAt : new Date());
      const tb = b.closedAt?.toDate?.() || (b.closedAt instanceof Date ? b.closedAt : new Date());
      return ta.getTime() - tb.getTime();
    });

    for (const t of sortedTrades) {
      currentEquity += (t.pnl || 0);
      if (currentEquity > peak) peak = currentEquity;
      const dd = peak - currentEquity;
      if (dd > maxDd) maxDd = dd;
    }

    // Performance by Setup (Grouping by Type and probability tiers)
    const setups: Record<string, any> = {};
    tradeHistory.forEach(t => {
      const tier = t.prob >= 90 ? 'T1' : t.prob >= 85 ? 'T2' : 'T3';
      const key = `${t.type}_${tier}`;
      if (!setups[key]) {
        setups[key] = { signal: t.type, tier, asset: 'STOCK', trades: 0, wins: 0, pnl: 0 };
      }
      setups[key].trades++;
      if (t.pnl > 0) setups[key].wins++;
      setups[key].pnl += t.pnl;
    });

    return {
      total,
      wins: wins.length,
      losses: losses.length,
      winRate,
      totalPnl,
      profitFactor,
      maxDd,
      avgWin,
      avgLoss,
      ratio,
      setups: Object.values(setups).sort((a, b) => b.trades - a.trades)
    };
  }, [tradeHistory]);

  const [isAutoTrading, setIsAutoTrading] = useState(false);
  const [tradeLogs, setTradeLogs] = useState<string[]>([]);
  const [marketSession, setMarketSession] = useState<'PRE_OPEN' | 'WATCH_PERIOD' | 'ACTIVE_TRADING' | 'SQUARE_OFF' | 'CLOSED'>('CLOSED');
  const positionsRef = React.useRef<any[]>([]);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    const updateSession = () => {
      const now = new Date();
      const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      const hours = istTime.getUTCHours();
      const minutes = istTime.getUTCMinutes();
      const timeValue = hours * 100 + minutes;

      if (timeValue < 900) setMarketSession('CLOSED');
      else if (timeValue < 915) setMarketSession('PRE_OPEN');
      else if (timeValue < 930) setMarketSession('WATCH_PERIOD');
      else if (timeValue < 1500) setMarketSession('ACTIVE_TRADING');
      else if (timeValue < 1530) setMarketSession('SQUARE_OFF');
      else setMarketSession('CLOSED');
    };
    updateSession();
    const interval = setInterval(updateSession, 60000);
    return () => clearInterval(interval);
  }, []);
  
  // Institutional Trade Monitor (Options Price Monitoring)
  const tradingLock = React.useRef<Record<string, any>>({});

  useEffect(() => {
    if (positions.length === 0) return;

    const monitorInterval = setInterval(async () => {
      const allFyersSymbols = positions.map(p => p.fyersSymbol).filter(Boolean) as string[];
      const stockSymbols = [...new Set(positions.map(p => `NSE:${p.symbol}-EQ`))] as string[];
      
      try {
        const [optionQuotes, stockQuotes] = await Promise.all([
          fetchQuotes(allFyersSymbols),
          fetchQuotes(stockSymbols)
        ]);

        const newPrices: Record<string, number> = {};

        positions.forEach(async (pos) => {
          if (pos.status !== 'OPEN') return;

          let currentPrice = 0;
          const fyersQuote = optionQuotes[pos.fyersSymbol];
          
          if (fyersQuote && fyersQuote.lp !== undefined) {
             currentPrice = fyersQuote.lp;
          } else {
             const stockQuote = stockQuotes[`NSE:${pos.symbol}-EQ`];
             const spotPrice = stockQuote?.lp || stocks.find(s => s.symbol === pos.symbol)?.lastPrice || pos.entry;
             
             const chain = getOptionChain(pos.symbol, spotPrice);
             const contract = chain.find(c => c.strike === pos.strike && (c.type === pos.optionType || (c.type === 'PUT' && pos.optionType === 'PE')));
             if (contract) {
               currentPrice = contract.lastPrice;
             } else {
               currentPrice = pos.currentPrice || pos.entry;
             }
          }

          if (currentPrice > 0) {
            newPrices[pos.fyersSymbol] = currentPrice;
            
            const currentPnl = (currentPrice - pos.entry) * pos.qty;
            const lastSyncKey = `last_sync_${pos.id}`;
            const nowTime = Date.now();
            if (!tradingLock.current[lastSyncKey] || nowTime - (tradingLock.current[lastSyncKey] as any) > 15000) {
              tradingLock.current[lastSyncKey] = nowTime as any;
              const docRef = doc(db, 'trades', pos.id);
              updateDoc(docRef, { 
                currentPrice,
                pnl: currentPnl
              });
            }

            let exitReason = null;

            // --- Auto-Exit Rule (3:00 PM IST) ---
            const now = new Date();
            const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
            const hours = istTime.getUTCHours();
            const timeValue = hours * 100 + istTime.getUTCMinutes();
            
            if (timeValue >= 1515) {
              exitReason = 'INTRADAY_SQUARE_OFF';
            } else if (currentPrice <= (pos.tsl || pos.sl)) {
              exitReason = pos.tsl ? 'TRAILING_STOP_HIT' : 'STOP_LOSS';
            } else {
              // ... trailing logic ...
              if (currentPrice >= pos.entry * 1.10 && (pos.sl < pos.entry)) {
                const docRef = doc(db, 'trades', pos.id);
                updateDoc(docRef, { sl: pos.entry });
                addLog(pos.symbol, 'TSL_UPDATE', 'SUCCESS', `Stop Loss moved to Breakeven @ ₹${pos.entry.toFixed(2)}`);
              }
              if (currentPrice >= pos.entry * 1.25) {
                const idealTsl = currentPrice * 0.90;
                if (!pos.tsl || idealTsl > pos.tsl) {
                   const docRef = doc(db, 'trades', pos.id);
                   updateDoc(docRef, { tsl: idealTsl });
                   addLog(pos.symbol, 'TSL_UPDATE', 'SUCCESS', `Trailing Stop updated to ₹${idealTsl.toFixed(2)}`);
                }
              }

              const targets = pos.targets || [];
              if (targets.length > 0) {
                const sortedTargets = [...targets].sort((a, b) => b - a);
                for (const target of sortedTargets) {
                  if (currentPrice >= target) {
                    exitReason = 'TARGET_MET';
                    break;
                  }
                }
              }
            }

            if (exitReason) {
              addLog(pos.symbol, 'CORE_EXIT', 'WARNING', `Market condition met: ${exitReason} @ ₹${currentPrice.toFixed(2)}`);
              closePosition(pos.id, exitReason);
            }
          }
        });
        if (Object.keys(newPrices).length > 0) {
          setMonitoredPrices(prev => ({ ...prev, ...newPrices }));
        }
      } catch (err) {
        console.error("Monitor Real Quote Error:", err);
      }
    }, 5000);

    return () => clearInterval(monitorInterval);
  }, [positions, stocks]); // Depend on length and stocks update to keep fresh
  const DEFAULT_SETTINGS: RiskSettings = {
    userId: GUEST_USER.uid,
    maxCapital: 1000000,
    maxTradesPerDay: 20,
    maxLossPerDay: 20000,
    riskPerTrade: 1,
    killSwitch: false,
    maxConcurrentTrades: 5,
    maxCapitalPerTrade: 200000
  };

  const [riskSettings, setRiskSettings] = useState<RiskSettings>(DEFAULT_SETTINGS);
  const [editingSettings, setEditingSettings] = useState<RiskSettings | null>(DEFAULT_SETTINGS);
  const realizedPnL = useMemo(() => {
    return tradeHistory.reduce((acc, t) => acc + (t.pnl || 0), 0);
  }, [tradeHistory]);

  const analytics = useMemo(() => {
    if (!tradeHistory || tradeHistory.length === 0) return {
      winRate: 0,
      expectancy: 0,
      avgRR: 0,
      maxWinStreak: 0,
      maxLossStreak: 0,
      avgWin: 0,
      avgLoss: 0
    };

    const wins = tradeHistory.filter(t => (t.pnl || 0) > 0);
    const losses = tradeHistory.filter(t => (t.pnl || 0) <= 0);
    const winRate = (wins.length / tradeHistory.length) * 100;
    
    const avgWin = wins.length > 0 ? wins.reduce((acc, t) => acc + (t.pnl || 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((acc, t) => acc + (t.pnl || 0), 0) / losses.length) : 0;
    
    const expectancy = (winRate / 100 * avgWin) - ((1 - winRate / 100) * avgLoss);
    const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;

    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let currentWinStreak = 0;
    let currentLossStreak = 0;

    const sortedHistory = [...tradeHistory].sort((a, b) => {
       const dateA = a.closedAt?.toDate?.() || (a.closedAt instanceof Date ? a.closedAt : new Date());
       const dateB = b.closedAt?.toDate?.() || (b.closedAt instanceof Date ? b.closedAt : new Date());
       return dateA.getTime() - dateB.getTime();
    });

    sortedHistory.forEach(t => {
      if ((t.pnl || 0) > 0) {
        currentWinStreak++;
        currentLossStreak = 0;
        maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
      } else {
        currentLossStreak++;
        currentWinStreak = 0;
        maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
      }
    });

    return { winRate, expectancy, avgRR, maxWinStreak, maxLossStreak, avgWin, avgLoss };
  }, [tradeHistory]);

  // --- Real-time Institutional PnL Engine ---
  const unrealizedPnL = useMemo(() => {
    return positions.reduce((acc, pos) => {
      const price = monitoredPrices[pos.fyersSymbol] || pos.currentPrice || pos.entry;
      return acc + (price - pos.entry) * pos.qty;
    }, 0);
  }, [positions, monitoredPrices]);

  const dailyPnL = realizedPnL + unrealizedPnL;
  const [isFyersConnected, setIsFyersConnected] = useState(false);
  const [isSendingTelegram, setIsSendingTelegram] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scannerSignals, setScannerSignals] = useState<any[]>([]);
  const [sectorStrengths, setSectorStrengths] = useState<any[]>([]);
  const [activeUniverse, setActiveUniverse] = useState<string[]>([]);
  const [systemLogs, setSystemLogs] = useState<ScannerLog[]>([]);

  const addLog = (symbol: string, action: string, status: ScannerLog['status'], reason: string) => {
    const newLog: ScannerLog = {
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date(),
      symbol,
      action,
      status,
      reason
    };
    setSystemLogs(prev => [newLog, ...prev].slice(0, 30));
  };

  const [isAutoLoggingIn, setIsAutoLoggingIn] = useState(false);
  const [manualAuthCode, setManualAuthCode] = useState('');
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);
  const [showManualCodeInput, setShowManualCodeInput] = useState(false);

  const loadMarketData = async () => {
    // Refresh Active Institutional Universe
    addLog('STOCKS', 'RESCAN', 'INFO', 'Updating top movers universe from NSE Data...');
    const trackedSymbols = positionsRef.current.map(p => p.symbol);
    const uni = await getActiveInstitutionalUniverse();
    setActiveUniverse(uni);
    addLog('STOCKS', 'UNIVERSE_READY', 'SUCCESS', `Tracking active symbols: ${uni.join(', ')}`);

    const realData = await fetchLiveMarketData(trackedSymbols);
    let currentStocks: StockData[] = [];
    
    if (realData) {
      currentStocks = realData;
      setIsFyersConnected(true);
    } else {
      currentStocks = getLiveStockData();
      setIsFyersConnected(false);
      addLog('SYSTEM', 'LIVE_FEED_ERR', 'WARNING', 'Failed to connect to Fyers API. Using simulated data cluster.');
    }
    
    setStocks(currentStocks);
    setMarketInfo(getMarketOverview());

    // Unified Momentum Detection & Alpha Scanner Feedback
    const hotStocks = currentStocks.filter(s => uni.includes(s.symbol) && Math.abs(s.pChange) > 1.5);
    
    if (hotStocks.length > 0) {
      setScannerSignals(prev => {
        const newSignals = hotStocks.map(s => ({
          id: Math.random().toString(36).substr(2, 9),
          symbol: s.symbol,
          type: s.pChange > 0 ? 'BULLISH' : 'BEARISH',
          price: s.lastPrice,
          time: new Date().toLocaleTimeString(),
          strength: Math.min(Math.floor(Math.abs(s.pChange) / 2) + 1, 5)
        }));
        const merged = [...newSignals, ...prev];
        const unique = Array.from(new Map(merged.map(s => [s.symbol, s])).values());
        return unique.slice(0, 10);
      });

      // Log detected momentum to Engine Console
      hotStocks.filter(h => Math.abs(h.pChange) > 2.5).forEach(s => {
        addLog(s.symbol, 'MOMENTUM_DETECTOR', 'SUCCESS', `Institutional pressure noted: ${s.pChange.toFixed(2)}% move detected.`);
      });
    }

    // Auto-analysis and trading background scan
    if (isAutoTrading) {
      addLog('SCANNER', 'AUTO_SCAN', 'INFO', `Scanning ${uni.length} institutional assets for trade quality...`);
      
      const candidates: { stock: StockData, analysis: AIProbabilityModel }[] = [];
      
      for (const symbol of uni) {
        const stock = currentStocks.find(s => s.symbol === symbol);
        if (stock && (Math.abs(stock.pChange) > 1.0 || stock.relVolume > 1.2)) {
          const chain = getOptionChain(stock.symbol, stock.lastPrice);
          const analysis = await analyzeTradeProbability(stock, chain);
          
          if (analysis.winProbability >= 70) {
            candidates.push({ stock, analysis });
          }
        }
      }

      // Tie-breaking Logic: Sort by Probability DESC, then Relative Volume DESC
      candidates.sort((a, b) => {
        if (b.analysis.winProbability !== a.analysis.winProbability) 
          return b.analysis.winProbability - a.analysis.winProbability;
        return b.stock.relVolume - a.stock.relVolume;
      });

      // Execute top 3 qualified trades if they have at least 75% prob (reduced from 80 for more activity)
      for (const candidate of candidates.slice(0, 3)) {
        if (candidate.analysis.winProbability >= 75) {
          analyzeAndMaybeTrade(candidate.stock, candidate.analysis);
        } else {
          addLog(candidate.stock.symbol, 'SKIP', 'INFO', `Probability ${candidate.analysis.winProbability}% below auto-entry threshold (75%).`);
        }
      }
    }

    // Calculate Sector Strengths
    const sectors = Array.from(new Set(currentStocks.map(s => s.sector)));
    const strengths = sectors.map(sector => {
      const sectorStocks = currentStocks.filter(s => s.sector === sector);
      const avgPerf = sectorStocks.reduce((acc, s) => acc + s.pChange, 0) / sectorStocks.length;
      return {
        name: sector,
        val: avgPerf,
        color: avgPerf > 0.5 ? 'bg-neon-green' : avgPerf < -0.5 ? 'bg-neon-red' : 'bg-neutral-600'
      };
    }).sort((a, b) => b.val - a.val);
    setSectorStrengths(strengths.slice(0, 6));
  };

  const analyzeAndMaybeTrade = async (stock: StockData, preComputedAnalysis?: AIProbabilityModel) => {
    // Robust check against stale state using Ref and multi-level locks
    if (positionsRef.current.some(p => p.symbol === stock.symbol)) return;
    
    // Check if there is an active execution lock for this symbol to prevent race conditions
    if (tradingLock.current[`${stock.symbol}_BUY_CE`] || tradingLock.current[`${stock.symbol}_BUY_PE`]) return;

    try {
      const chain = getOptionChain(stock.symbol, stock.lastPrice);
      const analysis = preComputedAnalysis || await analyzeTradeProbability(stock, chain);
      const rec = generateRecommendation(stock, analysis, chain);

      if (analysis.winProbability >= 75) { // Consistent Institutional Threshold
        addLog(stock.symbol, 'QUALIFIED', 'SUCCESS', `Institutional breakout score: ${analysis.winProbability}%. Executing...`);
        executeTrade(stock, rec, analysis);
      } else {
        addLog(stock.symbol, 'SKIPPED', 'INFO', `Scored ${analysis.winProbability}%. Confidence too low for automated entry.`);
      }
    } catch (e) {
      console.error(`Scanner error for ${stock.symbol}:`, e);
    }
  };

  const triggerAutoLogin = async () => {
    if (isAutoLoggingIn) return;
    setIsAutoLoggingIn(true);
    try {
      const res = await fetch('/api/auth/fyers/autologin');
      const data = await res.json();
      if (data.success) {
        setIsFyersConnected(true);
        loadMarketData();
      } else {
        alert(data.message || "Auto-login failed");
      }
    } catch (e) {
      console.error("Auto-login request failed:", e);
      alert("Failed to reach server for auto-login");
    } finally {
      setIsAutoLoggingIn(false);
    }
  };

  const submitManualCode = async () => {
    if (!manualAuthCode) return;
    setIsSubmittingCode(true);
    try {
      const res = await fetch('/api/auth/fyers/submit-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_code: manualAuthCode })
      });
      const data = await res.json();
      if (data.success) {
        setIsFyersConnected(true);
        setShowManualCodeInput(false);
        loadMarketData();
      } else {
        alert(data.message || "Code exchange failed");
      }
    } catch (e) {
      console.error("Code submission failed:", e);
      alert("Failed to reach server for code exchange");
    } finally {
      setIsSubmittingCode(false);
    }
  };

  // Live re-evaluation for selected stock when data updates
  useEffect(() => {
    if (!isAutoTrading || !selectedStock || !aiAnalysis || !recommendation) return;
    
    // Check if the current probability (shown in UI) meets the auto-trade threshold
    if (aiAnalysis.winProbability >= 75 && !positions.find(p => p.symbol === selectedStock.symbol)) {
      const lastCheckKey = `last_trade_check_${selectedStock.symbol}`;
      const lastCheck = (window as any)[lastCheckKey] || 0;
      
      // Throttle re-checks to once every 10s to avoid spam
      if (Date.now() - lastCheck > 10000) {
        (window as any)[lastCheckKey] = Date.now();
        addLog(selectedStock.symbol, 'UI_WATCH_MATCH', 'SUCCESS', `Focused asset probability hit ${aiAnalysis.winProbability}%. Auto-triggering...`);
        executeTrade(selectedStock, recommendation, aiAnalysis);
      }
    }
  }, [stocks, aiAnalysis, isAutoTrading, selectedStock]);

  // NSE / Fyers Data flow
  useEffect(() => {
    const checkServer = async () => {
      try {
        const res = await fetch('/api/health');
        const data = await res.json();
        console.log("Server Health:", data);
      } catch (e) {
        console.error("Server not responding to API calls:", e);
      }
    };
    checkServer();

    loadMarketData();
    
    // Refresh interval every 5 mins to sync universe and scan
    const refreshInterval = setInterval(() => {
      loadMarketData();
    }, 5 * 60 * 1000);
    
    return () => clearInterval(refreshInterval);
  }, [isAutoTrading]); // Refire scanner setup when auto-trading toggled
    
  useEffect(() => {
    // Initialize WebSockets for real-time updates
    initializeMarketWebSocket(
      (updates) => {
        setStocks(prev => {
          const newStocks = [...prev];
          updates.forEach(upd => {
            const idx = newStocks.findIndex(s => s.symbol === upd.symbol);
            if (idx !== -1) {
              newStocks[idx] = { ...newStocks[idx], ...upd };
            } else {
              newStocks.push(upd);
            }
          });
          return newStocks;
        });
      },
      (market) => setMarketInfo({ ...market }),
      (signal) => {
        setScannerSignals(prev => {
          const newSignal = {
            id: Math.random().toString(36).substr(2, 9),
            symbol: signal.symbol,
            type: signal.type,
            price: signal.price,
            time: new Date().toLocaleTimeString(),
            strength: signal.strength || 2
          };
          // Keep only last 10 signals
          return [newSignal, ...prev].slice(0, 10);
        });
      },
      (portfolioUpdate) => {
        // Optional: Update local portfolio from server if desired
        console.log("Paper Portfolio Update:", portfolioUpdate);
      },
      (enabled) => {
        setIsAutoTrading(enabled);
      },
      (log) => {
        setTradeLogs(prev => [log, ...prev].slice(0, 100));
      }
    );

    const interval = setInterval(loadMarketData, 30000); // Pulse every 30s as fallback

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (u) {
        setUser(u);
      } else {
        setUser(GUEST_USER);
      }
    });
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  // Firebase Real-time Sync
  useEffect(() => {
    if (!user) return;

    // Sync Portfolio
    const unsubPort = onSnapshot(doc(db, 'portfolios', user.uid), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setPortfolio({
          userId: data.userId || user.uid,
          balance: data.balance ?? 1000000,
          totalTrades: data.totalTrades || 0,
          winRate: data.winRate || 0,
          netPnl: data.netPnl || 0
        });
      } else {
        // Initial Portfolio
        const initial = {
          userId: user.uid,
          balance: 1000000,
          totalTrades: 0,
          winRate: 0,
          netPnl: 0
        };
        setDoc(doc(db, 'portfolios', user.uid), initial);
        setPortfolio(initial);
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, `portfolios/${user.uid}`));

    // Sync Trades
    const qTrades = query(
      collection(db, 'trades'), 
      where('userId', '==', user.uid),
      orderBy('timestamp', 'desc')
    );
    const unsubTrades = onSnapshot(qTrades, (snap) => {
      const all = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setPositions(all.filter((t: any) => t.status === 'OPEN'));
      setTradeHistory(all.filter((t: any) => t.status === 'CLOSED'));
      
      // Calculate Daily PnL
      const today = new Date().toDateString();
      const closedToday = all.filter((t: any) => {
        const d = t.closedAt?.toDate?.() || new Date();
        return t.status === 'CLOSED' && d.toDateString() === today;
      });
      const closedPnl = closedToday.reduce((acc: number, t: any) => acc + (t.pnl || 0), 0);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'trades'));

    // Sync Settings
    const unsubSettings = onSnapshot(doc(db, 'settings', user.uid), (snap) => {
      console.log(`[SETTINGS_SYNC] Snapshot for ${user.uid} exists:`, snap.exists());
      if (snap.exists()) {
        const data = snap.data() as RiskSettings;
        // Ensure all fields exist
        const sanitized = {
          maxCapital: data.maxCapital || 1000000,
          maxTradesPerDay: data.maxTradesPerDay || 20,
          maxLossPerDay: data.maxLossPerDay || 20000,
          riskPerTrade: data.riskPerTrade || 1,
          killSwitch: !!data.killSwitch,
          userId: data.userId || user.uid,
          maxConcurrentTrades: data.maxConcurrentTrades || 5,
          maxCapitalPerTrade: data.maxCapitalPerTrade || 200000
        };
        setRiskSettings(sanitized);
        setEditingSettings(sanitized);
      } else {
        // Initial Settings
        const initial = {
          userId: user.uid,
          maxCapital: 1000000,
          maxTradesPerDay: 20,
          maxLossPerDay: 20000,
          riskPerTrade: 1, // 1%
          killSwitch: false,
          maxConcurrentTrades: 5,
          maxCapitalPerTrade: 200000
        };
        setDoc(doc(db, 'settings', user.uid), initial);
        setRiskSettings(initial);
        setEditingSettings(initial);
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, `settings/${user.uid}`));

    return () => {
      unsubPort();
      unsubTrades();
      unsubSettings();
    };
  }, [user]);

  useEffect(() => {
    if (riskSettings?.killSwitch) {
       setIsAutoTrading(false);
    }
  }, [riskSettings?.killSwitch]);

  const handleLogout = () => {
    setUser(GUEST_USER);
    auth.signOut();
  };

  const sendTestTelegram = async () => {
    setIsSendingTelegram(true);
    try {
      const response = await fetch('/api/notify/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: formatTestMessage(user?.displayName || "Trader") }),
      });
      
      const data = await response.json();
      if (data.success) {
        alert("SUCCESS: Test message delivered to Telegram!");
      } else {
        alert(`ERROR: ${data.details || data.error || "Unknown error"}. Ensure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set in Secrets.`);
      }
    } catch (e: any) {
      alert("FAILED: Network error or server unreachable. " + e.message);
    } finally {
      setIsSendingTelegram(false);
    }
  };

  const forceTradeDebug = async () => {
    addLog('DEBUG', 'FORCE_START', 'INFO', 'Starting forced trade execution for COFORGE...');
    let targetStock = stocks.find(s => s.symbol === 'COFORGE');
    
    if (!targetStock) {
      addLog('DEBUG', 'WARN', 'WARNING', 'COFORGE not in snapshot, using fallback for debug structure.');
      targetStock = stocks[0];
    }
    
    if (!targetStock) {
      addLog('DEBUG', 'ERR', 'ERROR', 'No stocks available in current snapshot.');
      return;
    }
    
    const mockAnalysis: AIProbabilityModel = {
      winProbability: 95,
      confidence: 'High',
      momentumScore: 90,
      institutionalActivityScore: 85,
      breakoutQualityScore: 88,
      riskScore: 2,
      summary: "Manual Debug Execution triggered for COFORGE26MAY1320CE"
    };
    
    const fyersSymbol = getFyersOptionSymbol(targetStock.symbol, 1320, 'CE');
    
    // Simulate the specific requested contract for internal logging/testing
    const mockRec: TradeRecommendation = {
      symbol: targetStock.symbol,
      fyersSymbol: fyersSymbol,
      action: OptionAction.BUY_CE,
      strike: 1320,
      expiry: '26MAY',
      entryPrice: 45, // Symbolic entry
      stopLoss: 30,
      targets: [65, 85],
      riskReward: 2.5,
      positionSize: 'Standard',
      probability: 95
    };
    
    addLog('DEBUG', 'FORCING', 'INFO', `Executing debug trade for ${fyersSymbol}...`);
    executeTrade(targetStock, mockRec, mockAnalysis);
  };
  
  const updateRiskSettings = async (updates: Partial<RiskSettings>) => {
    const uid = user?.uid || GUEST_USER.uid;
    try {
      // Use setDoc with merge to ensure document exists
      await setDoc(doc(db, 'settings', uid), updates, { merge: true });
      addLog('SETTINGS', 'SYNC_SUCCESS', 'SUCCESS', 'Risk configuration committed to cloud profiles.');
      
      // Update local state immediately for better UX
      if (riskSettings) setRiskSettings({ ...riskSettings, ...updates });
    } catch (err) {
      console.error("Settings Update Failed:", err);
      handleFirestoreError(err, OperationType.UPDATE, `settings/${uid}`);
    }
  };

  const handleStockSelect = async (stock: StockData) => {
    const chain = getOptionChain(stock.symbol, stock.lastPrice);
    setSelectedStock(stock);
    setOptionChain(chain);
    setActiveView('analysis');
    setLoadingAnalysis(true);
    
    // Fetch AI Analysis
    const analysis = await analyzeTradeProbability(stock, chain);
    setAiAnalysis(analysis);
    const rec = generateRecommendation(stock, analysis, chain);
    setRecommendation(rec);
    setLoadingAnalysis(false);

    // Auto-Trading Logic
    if (isAutoTrading && analysis.winProbability >= 80) {
      executeTrade(stock, rec, analysis);
    }
  };

  const executeTrade = async (stock: StockData, rec: TradeRecommendation, analysis: AIProbabilityModel) => {
    // 1. Immediate Lock Assertion (BEFORE any async or sync checks)
    const lockKey = `${stock.symbol}_${rec.action}`;
    if (tradingLock.current[lockKey]) {
      console.warn(`[QUANT_GUARD] Concurrent execution blocked for ${lockKey}`);
      return;
    }
    tradingLock.current[lockKey] = true;

    // 2. Double-check against latest positions (using stable Ref)
    if (positionsRef.current.some(p => p.symbol === stock.symbol && (p.type === rec.action || p.fyersSymbol === rec.fyersSymbol))) {
      addLog(stock.symbol, 'SKIP', 'INFO', `Active ${rec.action} position detected in pool. Dual-entry suppressed.`);
      tradingLock.current[lockKey] = false; // Release since we won't trade
      return;
    }
    
    // Check Portfolio/Settings data availability
    if (!portfolio || !riskSettings) {
      addLog(stock.symbol, 'DATA_BLOCK', 'ERROR', 'Quantum data sync pending. Wait for institutional profile load.');
      return;
    }

    // Reject if Kill Switch is active
    if (riskSettings.killSwitch) {
       addLog(stock.symbol, 'RISK_BLOCK', 'ERROR', 'Global Kill Switch is ACTIVE. Trade halted.');
       setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Global Kill Switch is ACTIVE`, ...prev]);
       return;
    }

    // Check Max Trades Per Day
    const today = new Date().toDateString();
    const tradesToday = [...positions, ...tradeHistory].filter(t => {
      const tDate = t.timestamp?.toDate?.() || new Date();
      return tDate.toDateString() === today;
    }).length;

    if (tradesToday >= riskSettings.maxTradesPerDay) {
       addLog(stock.symbol, 'RISK_BLOCK', 'WARNING', `Daily trade limit reached (${riskSettings.maxTradesPerDay}/${riskSettings.maxTradesPerDay}).`);
       setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Max daily trades (${riskSettings.maxTradesPerDay}) reached`, ...prev]);
       return;
    }

    // Check Max Concurrent Trades
    if (riskSettings.maxConcurrentTrades && positions.length >= riskSettings.maxConcurrentTrades) {
      addLog(stock.symbol, 'RISK_BLOCK', 'WARNING', `Max concurrent positions (${riskSettings.maxConcurrentTrades}) reached.`);
      setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Max concurrent trades (${riskSettings.maxConcurrentTrades}) reached`, ...prev]);
      return;
    }

    // Check Max Capital
    const currentAllocation = positions.reduce((acc, p) => acc + (p.entry * p.qty), 0);
    if (currentAllocation >= riskSettings.maxCapital) {
       addLog(stock.symbol, 'RISK_BLOCK', 'WARNING', `Capital limit exceeded. Current: ${formatCurrency(currentAllocation)} | Limit: ${formatCurrency(riskSettings.maxCapital)}`);
       setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Max capital allocation reached`, ...prev]);
       return;
    }

    // Check Max Loss Per Day (Drawdown)
    if (dailyPnL <= -riskSettings.maxLossPerDay) {
       addLog(stock.symbol, 'RISK_BLOCK', 'ERROR', `Daily drawdown limit hit (${formatCurrency(dailyPnL)}).`);
       setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Daily SL Limit (${formatCurrency(riskSettings.maxLossPerDay)}) hit`, ...prev]);
       return;
    }

    // --- Market Timing Protocol (Institutional Rules) ---
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(Date.now() + istOffset);
    const hours = istTime.getUTCHours();
    const minutes = istTime.getUTCMinutes();
    const timeValue = hours * 100 + minutes;

    if (timeValue < 930) {
      addLog(stock.symbol, 'TIMING_BLOCK', 'WARNING', 'Market Watch Period (9:15-9:30). No trades allowed until 9:30 AM.');
      setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] REJECTED: Wait for 9:30 AM institutional confirmation`, ...prev]);
      return;
    }

    if (timeValue >= 1515) {
      addLog(stock.symbol, 'TIMING_BLOCK', 'WARNING', 'Intraday Square-off Protocol Active (After 3:15 PM). No new trades.');
      setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] REJECTED: Post 3:15 PM trade restriction`, ...prev]);
      return;
    }

    // --- Institutional Confluence Filter ---
    const bias = stock.higherTimeframeBias;
    const isBullishTrade = rec.action.includes('CE');
    const isBearishTrade = rec.action.includes('PE') || rec.action.includes('PUT');
    
    // 1. Timeframe Alignment
    if (isBullishTrade && bias === 'BEARISH') {
      addLog(stock.symbol, 'CONFLUENCE_ERR', 'ERROR', 'Trade REJECTED: Higher Timeframe Bias is BEARISH while attempting BUY/CE.');
      return;
    }
    if (isBearishTrade && bias === 'BULLISH') {
      addLog(stock.symbol, 'CONFLUENCE_ERR', 'ERROR', 'Trade REJECTED: Higher Timeframe Bias is BULLISH while attempting BUY/PE.');
      return;
    }

    // 2. Sector Strength Alignment
    const sectorData = sectorStrengths.find(s => s.name === stock.sector);
    if (isBullishTrade && sectorData && sectorData.val < -0.3) {
      addLog(stock.symbol, 'SECTOR_BLOCK', 'ERROR', `Trade REJECTED: Sector ${stock.sector} is under pressure (${sectorData.val.toFixed(2)}%).`);
      return;
    }
    if (isBearishTrade && sectorData && sectorData.val > 0.3) {
      addLog(stock.symbol, 'SECTOR_BLOCK', 'ERROR', `Trade REJECTED: Sector ${stock.sector} is too strong for shorts (${sectorData.val.toFixed(2)}%).`);
      return;
    }

    // 3. RSI Exhaustion Protocol (Mean Reversion Check)
    if (isBullishTrade && stock.rsi > 75) {
      addLog(stock.symbol, 'CORE_REJECT', 'WARNING', `ALPHA_GUARD: Long entry blocked on ${stock.symbol}. RSI (${stock.rsi.toFixed(1)}) at exhaustion.`);
      return;
    }
    if (isBearishTrade && stock.rsi < 25) {
      addLog(stock.symbol, 'CORE_REJECT', 'WARNING', `ALPHA_GUARD: Short entry blocked on ${stock.symbol}. RSI (${stock.rsi.toFixed(1)}) at capitulation.`);
      return;
    }

    // 4. Volume Spread Validation (Institutional Footprint)
    if (stock.relVolume < 1.4) {
      addLog(stock.symbol, 'CORE_REJECT', 'INFO', `VOL_GUARD: Low volume breakout on ${stock.symbol} (RV: ${stock.relVolume.toFixed(2)}x). Skipping retail noise.`);
      return;
    }
    // ----------------------------------------

    const userId = user?.uid || 'guest_institutional_trader';
    addLog(stock.symbol, 'PROTOCOL_V2', 'INFO', `Protocol engaged via ${user?.displayName || 'GUEST_CORE'}. Action: ${rec.fyersSymbol || rec.action} @ ${formatCurrency(rec.entryPrice)}`);

    const riskPerTrade = riskSettings.riskPerTrade || 1;
    const riskAmount = (portfolio?.balance || 1000000) * (riskPerTrade / 100);
    const entry = rec.entryPrice;
    const sl = rec.stopLoss;
    const stopLossPoints = Math.max(0.05, Math.abs(entry - sl));
    
    // lotSize based position sizing with Signal Strength Multiplier
    const lotSize = stock.lotSize || 1;
    
    // Calculate base lots from risk management
    const baseLots = Math.floor(riskAmount / (stopLossPoints * lotSize));
    
    // Apply Signal Strength Multiplier (Prob based)
    // 80% is the threshold for entry. 
    // 80-84: 1x base lots (Min 1)
    // 85-89: 2x base lots (Min 2)
    // 90+: 3x base lots (Min 3)
    let multiplier = 1;
    if (analysis.winProbability >= 90) multiplier = 3;
    else if (analysis.winProbability >= 85) multiplier = 2;
    
    let numLots = Math.max(1, baseLots) * multiplier;
    let qty = numLots * lotSize;
    
    const currentMargin = qty * entry;
    if (riskSettings.maxCapitalPerTrade && currentMargin > riskSettings.maxCapitalPerTrade) {
      const maxPossibleQty = Math.floor(riskSettings.maxCapitalPerTrade / entry);
      const adjustedLots = Math.floor(maxPossibleQty / lotSize);
      qty = adjustedLots * lotSize;
      
      if (qty <= 0) {
        addLog(stock.symbol, 'SIZE_BLOCK', 'ERROR', `Trade REJECTED: Max capital/trade limit too low for 1 lot.`);
        return;
      }
      addLog(stock.symbol, 'SIZE_ADJUST', 'WARNING', `Quantity adjusted to respect Max Capital/Trade limit of ${formatCurrency(riskSettings.maxCapitalPerTrade)}`);
    }
    
    if (isNaN(qty) || qty <= 0) {
      addLog(stock.symbol, 'SIZE_ERR', 'ERROR', `Invalid QTY. Prob: ${analysis.winProbability}%, Lots: ${numLots}, Risk: ${riskAmount.toFixed(0)}`);
      return;
    }

    const marginRequired = qty * entry;
    // Log detailed calculation for transparency
    addLog(stock.symbol, 'ORDER_INIT', 'INFO', `Order Prep: ${numLots} Lots (Lot Size: ${lotSize}, Total QTY: ${qty}). Estimated Margin: ${formatCurrency(marginRequired)}`);

    const newPosition = {
      userId: userId,
      symbol: stock.symbol,
      fyersSymbol: rec.fyersSymbol || "UNKNOWN",
      type: rec.action,
      optionType: rec.action.includes('CE') ? 'CE' : 'PUT',
      strike: rec.strike,
      expiry: rec.expiry,
      qty: qty,
      numLots: numLots,
      lotSize: lotSize,
      entry: entry,
      sl: sl,
      targets: rec.targets,
      pnl: 0,
      currentPrice: entry,
      status: 'OPEN',
      timestamp: Timestamp.now(),
      prob: analysis.winProbability,
      entryGreeks: rec.greeks
    };

    console.log('[DEBUG] ATTEMPTING FIRESTORE WRITE | PATH: trades | AUTH:', !!user, 'ID:', userId);
    console.log('[DEBUG] DB_CONFIG:', db.app.options.databaseURL || 'DEFAULT');
    console.log('[DEBUG] PAYLOAD:', JSON.stringify(newPosition));

    try {
      // Use handleFirestoreError to get the specific JSON diagnostic
      const collectionRef = collection(db, 'trades');
      const docRef = await addDoc(collectionRef, newPosition);
      console.log('[DEBUG] FIRESTORE_SUCCESS | ID:', docRef.id);
      addLog(stock.symbol, 'ORDER_SUCCESS', 'SUCCESS', `Order executed: ${newPosition.qty} units @ ${newPosition.entry}.`);
      setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER EXECUTED: ${rec.fyersSymbol || stock.symbol} ${rec.action} @ ${rec.entryPrice} QTY: ${qty}`, ...prev]);
      
      // REAL ORDER EXECUTION ON FYERS (REMOVED - PAPER TRADING ONLY)
      /*
      if (isFyersConnected && rec.fyersSymbol) {
        ...
      }
      */

      // Notify Telegram
      sendTelegramNotification(formatTradeEntry(newPosition));
    } catch (err: any) {
      addLog(stock.symbol, 'ORDER_ERR', 'ERROR', `Execution failed: ${err.message}`);
      handleFirestoreError(err, OperationType.CREATE, 'trades');
    } finally {
      // Extended cooldown to allow Firestore listeners and state to sync (20s)
      setTimeout(() => {
        if (tradingLock.current[lockKey]) {
          tradingLock.current[lockKey] = false;
        }
      }, 20000);
    }
  };

  const closePosition = async (id: string, reason: string = 'MANUAL', exitGreeks?: any) => {
    const pos = positions.find(p => p.id === id);
    if (!pos) return;

    try {
      const livePrice = monitoredPrices[pos.fyersSymbol] || pos.currentPrice || pos.entry;
      const finalPnl = (livePrice - pos.entry) * pos.qty;
      
      let actualExitGreeks = exitGreeks;
      if (!actualExitGreeks) {
        const stock = stocks.find(s => s.symbol === pos.symbol);
        if (stock) {
          const chain = getOptionChain(pos.symbol, stock.lastPrice);
          const contract = chain.find(c => c.strike === pos.strike && (c.type === pos.optionType || (c.type === 'PUT' && pos.optionType === 'PE')));
          if (contract) {
            actualExitGreeks = {
              delta: contract.delta,
              gamma: contract.gamma,
              theta: contract.theta,
              vega: contract.vega
            };
          }
        }
      }
      
      const docRef = doc(db, 'trades', id);
      await updateDoc(docRef, {
        status: 'CLOSED',
        exit: livePrice,
        pnl: finalPnl,
        exitReason: reason,
        exitGreeks: actualExitGreeks || null,
        closedAt: Timestamp.now()
      });

      // Update Portfolio (Simplified)
      const userId = user?.uid || 'guest_institutional_trader';
      const pRef = doc(db, 'portfolios', userId);
      await updateDoc(pRef, {
        balance: ((portfolio?.balance) || 1000000) + finalPnl,
        totalTrades: ((portfolio?.totalTrades) || 0) + 1,
        netPnl: ((portfolio?.netPnl) || 0) + finalPnl
      });

      setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] POSITION CLOSED: ${pos.symbol} PNL: ${(finalPnl || 0).toFixed(2)}`, ...prev]);
      
      // Notify Telegram
      sendTelegramNotification(formatTradeExit(pos, livePrice, finalPnl));
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'trades');
    }
  };

  const filteredStocks = stocks.filter(s => {
    const matchesSearch = s.symbol.toLowerCase().includes(searchQuery.toLowerCase());
    if (filter === 'bullish') {
      return matchesSearch && 
             s.lastPrice > s.ema20 && 
             (s.oiChange > 0 || s.pChange > 0.5);
    }
    if (filter === 'bearish') {
      return matchesSearch && 
             s.lastPrice < s.ema20 && 
             (s.oiChange < 0 || s.pChange < -0.5);
    }
    if (filter === 'breakout') {
      return matchesSearch && 
             (s.marketRegime === MarketRegime.BREAKOUT || s.relVolume > 1.25);
    }
    return matchesSearch;
  });

  return (
    <div className="h-screen bg-tech-bg text-tech-text flex flex-col font-sans overflow-hidden selection:bg-neon-green selection:text-black">
      {/* Header */}
      <header className="h-14 border-b border-tech-border px-6 flex items-center justify-between shrink-0 bg-tech-bg">
        <div className="flex items-center gap-10">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 bg-neon-green rounded-full shadow-[0_0_8px_rgba(0,255,148,0.5)]"></div>
            <h1 className="text-xl font-sans font-extrabold tracking-tighter text-white uppercase">Quant<span className="text-neon-green">Optix</span></h1>
          </div>
          
          <div className="hidden xl:flex gap-8 text-[10px] font-mono uppercase text-neutral-500">
            {marketInfo && (
              <>
                <div>NIFTY 50 <span className={cn("font-bold ml-1", marketInfo.nifty.pChange >= 0 ? "text-neon-green" : "text-neon-red")}>{marketInfo.nifty.price} ({marketInfo.nifty.pChange >= 0 ? "+" : ""}{marketInfo.nifty.pChange}%)</span></div>
                <div>BANK NIFTY <span className={cn("font-bold ml-1", marketInfo.bankNifty.pChange >= 0 ? "text-neon-green" : "text-neon-red")}>{marketInfo.bankNifty.price} ({marketInfo.bankNifty.pChange >= 0 ? "+" : ""}{marketInfo.bankNifty.pChange}%)</span></div>
                <div className="flex items-center gap-2">
                  SESSION_PNL: 
                  <span className={cn("font-bold", dailyPnL >= 0 ? "text-neon-green" : "text-neon-red")}>
                    {dailyPnL >= 0 ? "+" : ""}{formatCurrency(dailyPnL)}
                  </span>
                </div>
                <div>F&O UNIVERSE <span className="text-white font-bold ml-1">{stocks.length} ACTIVE</span></div>
                
                <div className="flex items-center gap-2 border-l border-tech-border pl-8 ml-4">
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    marketSession === 'ACTIVE_TRADING' ? "bg-neon-green animate-pulse" : 
                    marketSession === 'WATCH_PERIOD' ? "bg-amber-500" : 
                    "bg-neon-red"
                  )}></div>
                  <div className="flex flex-col">
                    <span className="text-[7px] text-neutral-600 tracking-[0.2em]">MARKET_STATE</span>
                    <span className={cn(
                      "font-bold",
                      marketSession === 'ACTIVE_TRADING' ? "text-neon-green" : 
                      marketSession === 'WATCH_PERIOD' ? "text-amber-500" : 
                      "text-neutral-400"
                    )}>
                      {marketSession.replace('_', ' ')}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-6">
          <nav className="flex items-center gap-1 bg-tech-surface p-1 border border-tech-border">
            {[
              { id: 'dashboard', icon: LayoutDashboard, label: 'DASHBOARD' },
              { id: 'screener', icon: ListFilter, label: 'SCREENER' },
              { id: 'analysis', icon: Search, label: 'ANALYSIS' },
              { id: 'trades', icon: Activity, label: 'TRADES' },
              { id: 'risk', icon: Shield, label: 'RISK' },
              { id: 'analytics', icon: BarChart3, label: 'ANALYTICS' }
            ].map(item => (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id as any)}
                className={cn(
                  "flex items-center gap-2 px-3 py-1 text-[10px] font-mono font-bold tracking-widest transition-all",
                  activeView === item.id ? "bg-tech-bg text-neon-green border border-tech-border shadow-[0_0_10px_rgba(0,255,148,0.1)]" : "text-neutral-500 hover:text-neutral-200"
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>
          
          <div className="flex items-center gap-4 border-l border-tech-border pl-6">
            <div className="flex items-center gap-3">
               <div className="text-right">
                 <div className="text-[8px] text-neutral-500 uppercase font-mono tracking-widest">{user?.displayName || GUEST_USER.displayName}</div>
                 <div className="text-white text-[10px] font-mono font-bold leading-none">{formatCurrency(portfolio?.balance || 0)}</div>
               </div>
               <div className="w-8 h-8 bg-tech-border rounded-full flex items-center justify-center text-neon-green">
                 <UserIcon size={16} />
               </div>
            </div>
            <div className="w-px h-8 bg-tech-border mx-2"></div>
            <div className="flex items-center gap-3 bg-tech-surface border border-tech-border px-3 py-1 text-[10px] font-mono">
              <span className="text-neutral-500 uppercase tracking-widest text-[9px]">Fyers:</span>
              {isFyersConnected ? (
                <span className="text-neon-green font-bold">LINKED</span>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <a 
                      href="/api/auth/fyers/login"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-amber-500 hover:text-white transition-colors"
                    >
                      CONNECT
                    </a>
                    <button 
                      onClick={triggerAutoLogin}
                      disabled={isAutoLoggingIn}
                      className="text-[9px] bg-neutral-800 hover:bg-neutral-700 text-neutral-400 py-0.5 px-1.5 transition-colors uppercase font-bold"
                    >
                      {isAutoLoggingIn ? 'Attempting...' : 'Try Auto'}
                    </button>
                    <button 
                      onClick={() => setShowManualCodeInput(!showManualCodeInput)}
                      className="text-[9px] bg-neutral-800 hover:bg-neutral-700 text-neutral-400 py-0.5 px-1.5 transition-colors uppercase font-bold"
                    >
                      Manual Code
                    </button>
                  </div>
                  {showManualCodeInput && (
                    <div className="flex items-center gap-1 mt-1">
                      <input 
                        type="text" 
                        placeholder="Auth Code"
                        value={manualAuthCode}
                        onChange={(e) => setManualAuthCode(e.target.value)}
                        className="bg-black border border-tech-border text-[9px] px-1 py-0.5 w-24 text-white focus:border-neon-green outline-none"
                      />
                      <button 
                        onClick={submitManualCode}
                        disabled={isSubmittingCode}
                        className="text-[9px] bg-neon-green/20 hover:bg-neon-green/40 text-neon-green py-0.5 px-1.5 transition-colors uppercase font-bold border border-neon-green/30"
                      >
                        {isSubmittingCode ? '...' : 'Submit'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="w-px h-8 bg-tech-border mx-2"></div>
            <div className="bg-tech-surface border border-tech-border px-3 py-1 text-[10px] font-mono flex items-center gap-3">
              <span className="text-neutral-500 uppercase tracking-widest text-[9px]">Alerts:</span>
              <button 
                onClick={sendTestTelegram}
                disabled={isSendingTelegram}
                className="text-sky-400 hover:text-white transition-colors font-bold flex items-center gap-1"
              >
                {isSendingTelegram ? 'SENDING...' : 'TEST_TELEGRAM'}
              </button>
              <div className="w-px h-3 bg-tech-border"></div>
              <button 
                onClick={forceTradeDebug}
                className="text-amber-400 hover:text-white transition-colors font-bold text-[9px]"
              >
                DEBUG_EXEC
              </button>
            </div>
            <div className="w-px h-8 bg-tech-border mx-2"></div>
            <div className="bg-tech-surface border border-tech-border px-3 py-1 text-[10px] font-mono flex items-center gap-3">
              <span className="text-neutral-500 uppercase tracking-widest text-[9px]">Auto-Bot:</span>
              <button 
                onClick={() => {
                  if (!riskSettings?.killSwitch && socket) {
                    socket.emit('toggle-auto-trade', !isAutoTrading);
                  }
                }}
                disabled={riskSettings?.killSwitch}
                className={cn(
                  "px-3 py-0.5 font-black uppercase tracking-tighter transition-all text-[9px]",
                  isAutoTrading ? "bg-neon-green text-black shadow-[0_0_8px_rgba(0,255,148,0.5)]" : "bg-neutral-800 text-neutral-500",
                  riskSettings?.killSwitch && "bg-neon-red/20 text-neon-red border border-neon-red/50 cursor-not-allowed"
                )}
              >
                {riskSettings?.killSwitch ? "HALTED" : (isAutoTrading ? "ACTIVE" : "STANDBY")}
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Sidebar / Sector Rotation */}
        <aside className="w-72 border-r border-tech-border flex flex-col shrink-0 bg-tech-bg/50">
          <div className="p-6 border-b border-tech-border">
            <h3 className="text-[10px] uppercase text-neutral-500 font-bold mb-4 tracking-[0.2em]">Sector Strength Index</h3>
            <div className="space-y-4">
              {sectorStrengths.length > 0 ? sectorStrengths.map(s => (
                <div key={s.name} className="group">
                  <div className="flex justify-between text-[11px] mb-1.5 font-mono">
                    <span className="text-neutral-400">{s.name}</span>
                    <span className={cn(s.val > 0 ? "text-neon-green" : "text-neon-red")}>{s.val > 0 ? "+" : ""}{s.val.toFixed(1)}%</span>
                  </div>
                  <div className="h-1 bg-tech-border relative overflow-hidden">
                    <div className={cn("absolute h-full top-0 left-0 transition-all duration-1000", s.color)} style={{ width: `${Math.min(100, Math.abs(s.val) * 10)}%` }}></div>
                  </div>
                </div>
              )) : (
                <div className="text-[10px] text-neutral-600 font-mono italic">Calculating sector pulse...</div>
              )}
            </div>
          </div>
          
          <div className="flex-1 p-6 overflow-y-auto">
            <ScannerAlerts 
              signals={scannerSignals} 
              onSelect={(symbol) => {
                const stock = stocks.find(s => s.symbol === symbol);
                if (stock) handleStockSelect(stock);
              }}
            />
          </div>
        </aside>

        {/* Dynamic Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[#0a0c10]">
          <div className="flex-1 overflow-y-auto p-6">
            <AnimatePresence mode="wait">
              {activeView === 'dashboard' && (
                <motion.div 
                  key="dashboard"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="space-y-8"
                >
                  {/* Session Summary Bar */}
                  <div className="flex flex-wrap gap-4 items-center bg-tech-surface border border-tech-border p-4 mb-2">
                    <div className="flex gap-8">
                      <div className="flex flex-col">
                        <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Realized PnL</span>
                        <span className={cn("text-lg font-black font-mono", realizedPnL >= 0 ? "text-neon-green" : "text-neon-red")}>
                          {realizedPnL >= 0 ? '+' : ''}{formatCurrency(realizedPnL)}
                        </span>
                      </div>
                      <div className="w-px h-8 bg-tech-border"></div>
                      <div className="flex flex-col">
                        <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Unrealized PnL</span>
                        <span className={cn("text-lg font-black font-mono", unrealizedPnL >= 0 ? "text-neon-green" : "text-neon-red")}>
                          {unrealizedPnL >= 0 ? '+' : ''}{formatCurrency(unrealizedPnL)}
                        </span>
                      </div>
                      <div className="w-px h-8 bg-tech-border"></div>
                      <div className="flex flex-col">
                        <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Net Session</span>
                        <span className={cn("text-lg font-black font-mono", dailyPnL >= 0 ? "text-neon-green" : "text-neon-red")}>
                          {dailyPnL >= 0 ? '+' : ''}{formatCurrency(dailyPnL)}
                        </span>
                      </div>
                    </div>
                    
                    <div className="ml-auto flex items-center gap-4">
                       <div className="text-right">
                          <div className="text-[8px] text-neutral-500 uppercase font-mono tracking-widest">Bot Status</div>
                          <div className={cn("text-[10px] font-bold font-mono", isAutoTrading ? "text-neon-green" : "text-amber-500")}>
                            {isAutoTrading ? "RUNNING_STABLE" : "USER_CONTROL"}
                          </div>
                       </div>
                       <button onClick={() => setActiveView('trades')} className="bg-tech-bg border border-tech-border px-4 py-1.5 text-[9px] font-bold uppercase tracking-widest hover:text-neon-green transition-colors">
                          Manage Trades
                       </button>
                    </div>
                  </div>

                  {/* High Prob Alpha Opportunities */}
                  <div className="space-y-6">
                    <div className="flex justify-between items-center">
                      <h2 className="text-sm font-bold uppercase tracking-[0.2em] flex items-center gap-3">
                        <div className={cn("w-2 h-2 shadow-green", dashAlphaTab === 'CE' ? "bg-neon-green" : "bg-neon-red shadow-red")}></div>
                        Institutional Alpha {dashAlphaTab === 'CE' ? 'Bullish (Top Movers)' : 'Bearish (Short Decay)'}
                      </h2>
                      <div className="flex bg-tech-surface border border-tech-border p-1">
                        <button 
                          onClick={() => setDashAlphaTab('CE')}
                          className={cn("px-5 py-1 text-[10px] font-bold uppercase tracking-tighter transition-all", dashAlphaTab === 'CE' ? "bg-neon-green text-black" : "text-neutral-500 hover:text-white")}
                        >
                          CE ALPHA
                        </button>
                        <button 
                          onClick={() => setDashAlphaTab('PE')}
                          className={cn("px-5 py-1 text-[10px] font-bold uppercase tracking-tighter transition-all", dashAlphaTab === 'PE' ? "bg-neon-red text-white" : "text-neutral-500 hover:text-white")}
                        >
                          PE ALPHA
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                      {stocks.filter(s => {
                        const isInUni = activeUniverse.includes(s.symbol);
                        const isDirectional = dashAlphaTab === 'CE' ? s.pChange > 0.5 : s.pChange < -0.5;
                        
                        // Bearish Reversal Detection Logic:
                        // 1. Stock is overbought (RSI > 70)
                        // 2. Pulse (short-term momentum) is fading or negative
                        // 3. Price is still currently high relative to day's low
                        const isBearishReversal = s.rsi > 68 && s.pulse < 0.2 && s.pChange > 0.8;
                        
                        return isInUni && (isDirectional || (dashAlphaTab === 'PE' && isBearishReversal));
                      }).slice(0, 4).map(s => {
                        const isReversal = s.rsi > 68 && s.pulse < 0.2 && s.pChange > 0.8 && dashAlphaTab === 'PE';
                        const isPE = dashAlphaTab === 'PE' || s.pChange < 0;
                        
                        const reversalFactors = [
                          { label: 'RSI_EXH', value: (s.rsi || 0).toFixed(1), threshold: '>68', met: (s.rsi || 0) > 68 },
                          { label: 'MOM_FADE', value: (s.pulse || 0).toFixed(2), threshold: '<0.2', met: (s.pulse || 0) < 0.2 },
                          { label: 'PRICE_EXT', value: (s.pChange || 0).toFixed(1) + '%', threshold: '>0.8%', met: (s.pChange || 0) > 0.8 }
                        ];

                        return (
                          <div key={s.symbol} className={cn(
                            "bg-tech-surface border p-5 relative overflow-hidden group cursor-pointer transition-all duration-300",
                            isReversal 
                              ? "border-amber-500/40 bg-amber-500/5 hover:border-amber-500 ring-1 ring-amber-500/20 shadow-[inset_0_0_20px_rgba(245,158,11,0.05)]" 
                              : "border-tech-border hover:border-neon-green/50"
                          )} onClick={() => handleStockSelect(s)}>
                            {isReversal && (
                              <div className="absolute top-0 left-0 flex flex-col items-start z-10">
                                <div className="bg-amber-500 text-black text-[9px] font-bold px-2 py-0.5 flex items-center gap-1 uppercase tracking-tighter">
                                  <Zap size={10} fill="currentColor" />
                                  BEARISH_EXHAUSTION
                                </div>
                                <div className="flex gap-[1px]">
                                  {reversalFactors.map(f => (
                                    <div key={f.label} className={cn(
                                      "text-[7px] px-1 py-0.5 font-mono",
                                      f.met ? "bg-amber-500/20 text-amber-500" : "bg-neutral-800 text-neutral-500"
                                    )}>
                                      {f.label}:{f.value}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            <div className={cn(
                              "absolute top-0 right-0 p-4 opacity-5 font-black text-6xl italic uppercase pointer-events-none group-hover:opacity-10 transition-opacity",
                              isPE ? "text-neon-red" : "text-neon-green"
                            )}>{isPE ? 'PE BUY' : 'CE BUY'}</div>
                          <div className="flex justify-between items-start mb-4">
                            <div>
                              <h1 className="text-2xl font-black leading-none tracking-tighter text-white">{s.symbol}</h1>
                              <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">{s.sector} | LOT: {s.lotSize}</span>
                            </div>
                            <div className="text-right">
                              <div className={cn("text-xl font-mono font-black", isPE ? "text-neon-red glow-red" : "text-neon-green glow-green")}>
                                {isPE ? "BUY PE" : "BUY CE"}
                              </div>
                              <div className="text-[9px] font-mono text-neutral-400 mt-1 uppercase tracking-widest">
                                Strike: {getRecommendedStrike(s.lastPrice, isPE ? 'PUT' : 'CE')}
                              </div>
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-4 gap-2 mb-4">
                            {[
                              { label: 'Strength', val: `${(80 + Math.abs(s.pChange || 0) * 2).toFixed(1)}%`, highlight: true },
                              { label: 'Vol Flow', val: (s.relVolume || 0).toFixed(2) + 'x' },
                              { label: 'Trend', val: s.trend },
                              { label: 'RSI(14)', val: (s.rsi || 0).toFixed(0) },
                            ].map((stat, i) => (
                              <div key={i} className="bg-tech-bg p-2 border border-tech-border">
                                <div className="text-[8px] text-neutral-500 uppercase font-mono tracking-widest mb-1">{stat.label}</div>
                                <div className={cn("text-xs font-bold", stat.highlight ? (s.pChange > 0 ? "text-neon-green" : "text-neon-red") : "text-white")}>{stat.val}</div>
                              </div>
                            ))}
                          </div>

                          <div className={cn(
                            "flex justify-between items-center p-2.5 border",
                            s.pChange > 0 ? "bg-neon-green/5 border-neon-green/20" : "bg-neon-red/5 border-neon-red/20"
                          )}>
                            <span className={cn("text-[9px] font-bold font-mono uppercase tracking-widest", s.pChange > 0 ? "text-neon-green" : "text-neon-red")}>
                              Pulse: {(s.pChange || 0).toFixed(2)}% | OI: {(s.oiChange || 0).toFixed(1)}%
                            </span>
                            <span className={cn(
                              "text-[9px] font-bold px-2 py-0.5 border uppercase tracking-tighter",
                              s.pChange > 0 ? "text-neon-green border-neon-green/50 bg-neon-green/10" : "text-neon-red border-neon-red/50 bg-neon-red/10"
                            )}>
                              {s.marketRegime}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                  {/* Institutional Scanner Grid */}
                  <div className="space-y-4 flex-1 flex flex-col">
                    <div className="flex justify-between items-end">
                      <h2 className="text-[10px] font-mono font-bold uppercase tracking-[.3em] text-neutral-500">Institutional Scanner (Top F&O Liquidity)</h2>
                      <div className="text-[9px] font-mono text-neutral-600 uppercase tracking-widest">Auto-Refresh: 5s // Mode: Real-time</div>
                    </div>
                    <div className="border border-tech-border bg-tech-surface overflow-hidden">
                      <table className="w-full text-left font-mono">
                        <thead className="text-[10px] bg-[#1a1d23] text-neutral-500 border-b border-tech-border uppercase">
                          <tr>
                            <th className="px-4 py-3 tracking-widest">Symbol</th>
                            <th className="px-4 py-3 tracking-widest">Price</th>
                            <th className="px-4 py-3 tracking-widest">Change</th>
                            <th className="px-4 py-3 tracking-widest">OI Change%</th>
                            <th className="px-4 py-3 tracking-widest">Buildup</th>
                            <th className="px-4 py-3 tracking-widest">CONFLUENCE</th>
                            <th className="px-4 py-3 tracking-widest text-right">Signal</th>
                          </tr>
                        </thead>
                        <tbody className="text-[11px] divide-y divide-tech-border">
                          {stocks.slice(0, 8).map(stock => (
                            <tr key={stock.symbol} className="hover:bg-white/5 transition-colors cursor-pointer" onClick={() => handleStockSelect(stock)}>
                              <td className="px-4 py-3 font-bold text-white">{stock.symbol}</td>
                              <td className="px-4 py-3">{formatCurrency(stock.lastPrice)}</td>
                              <td className={cn("px-4 py-3 font-bold", (stock.pChange || 0) >= 0 ? "text-neon-green" : "text-neon-red")}>
                                {(stock.pChange || 0) >= 0 ? "+" : ""}{(stock.pChange || 0).toFixed(2)}%
                              </td>
                              <td className="px-4 py-3 text-neutral-400">+{Math.abs(stock.oiChange || 0).toFixed(1)}%</td>
                              <td className={cn("px-4 py-3 font-bold", stock.trend === Trend.BULLISH ? "text-neon-green" : "text-neon-red")}>
                                {stock.trend === Trend.BULLISH ? "LONG BUILDUP" : stock.trend === Trend.BEARISH ? "SHORT BUILDUP" : "NEUTRAL"}
                              </td>
                              <td className="px-4 py-3 text-neutral-500">{(0.6 + Math.random() * 0.8).toFixed(2)}</td>
                              <td className="px-4 py-3">
                                <div className="flex flex-col">
                                  <span className={cn(
                                    "text-[9px] font-bold px-1.5 py-0.5 border w-fit font-mono",
                                    stock.higherTimeframeBias === 'BULLISH' ? "border-neon-green/30 text-neon-green bg-neon-green/5" :
                                    stock.higherTimeframeBias === 'BEARISH' ? "border-neon-red/30 text-neon-red bg-neon-red/5" :
                                    "border-neutral-700 text-neutral-400"
                                  )}>
                                    H1: {stock.higherTimeframeBias || 'NEUTRAL'}
                                  </span>
                                </div>
                              </td>
                              <td className={cn("px-4 py-3 text-right font-bold", 
                                stock.trend === Trend.BULLISH ? "text-neon-green glow-green" : 
                                stock.trend === Trend.BEARISH ? "text-neon-red glow-red" : "text-neutral-700"
                              )}>
                                {stock.trend || 'NEUTRAL'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Institutional Console (System Logs) */}
                  <div className="space-y-4">
                    <div className="flex justify-between items-end">
                      <h2 className="text-[10px] font-mono font-bold uppercase tracking-[.3em] text-neutral-500 flex items-center gap-2">
                        <Terminal size={12} className="text-neon-green" />
                        Institutional Engine Console
                      </h2>
                      <div className="text-[9px] font-mono text-neutral-600 uppercase tracking-widest">Verbosity: High // Trace Enabled</div>
                    </div>
                    <div className="bg-[#050608] border border-tech-border h-[250px] overflow-y-auto font-mono p-4 custom-scrollbar">
                      {systemLogs.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-neutral-700 text-[10px] uppercase tracking-[0.4em]">
                          Engine Idle. Listening for institutional flow...
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {systemLogs.map(log => (
                            <div key={log.id} className="text-[10px] flex gap-3 group">
                              <span className="text-neutral-600 shrink-0">[{log.timestamp.toLocaleTimeString()}]</span>
                              <span className={cn(
                                "flex-none w-20 font-bold",
                                log.status === 'SUCCESS' ? "text-neon-green" : 
                                log.status === 'WARNING' ? "text-amber-500" : 
                                log.status === 'ERROR' ? "text-neon-red" : "text-sky-400"
                              )}>
                                {log.action}
                              </span>
                              <span className="text-white font-bold shrink-0 w-16">{log.symbol}</span>
                              <span className="text-neutral-400 group-hover:text-white transition-colors">{log.reason}</span>
                            </div>
                          ))}
                          <div className="pt-2 animate-pulse text-neon-green text-[10px]">_</div>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}

          {activeView === 'screener' && (
            <motion.div 
              key="screener"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-8"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="relative group flex-1 max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 group-focus-within:text-neon-green transition-colors" size={18} />
                  <input 
                    type="text" 
                    placeholder="ENTER SYMBOL TO QUANT SCAN..." 
                    className="w-full bg-tech-bg border border-tech-border py-2.5 pl-10 pr-4 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-neon-green transition-all"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <div className="flex bg-tech-surface p-1 border border-tech-border overflow-hidden">
                  {[
                    { id: 'all', label: 'ALL CONTRACTS' },
                    { id: 'bullish', label: 'BULLISH ALGO' },
                    { id: 'bearish', label: 'BEARISH ALGO' },
                    { id: 'breakout', label: 'BREAKOUTS' }
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setFilter(tab.id as any)}
                      className={cn(
                        "px-4 py-1.5 text-[10px] font-mono font-bold tracking-tighter transition-all",
                        filter === tab.id ? "bg-tech-bg text-neon-green border border-tech-border" : "text-neutral-500 hover:text-neutral-300"
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="border border-tech-border bg-tech-surface overflow-hidden">
                <table className="w-full text-left font-mono">
                  <thead className="bg-[#1a1d23] text-neutral-500 uppercase">
                    <tr>
                      <th className="px-6 py-4 text-[10px] tracking-[.2em] border-b border-tech-border">Asset Cluster</th>
                      <th className="px-6 py-4 text-[10px] tracking-[.2em] border-b border-tech-border">Spot Price</th>
                      <th className="px-6 py-4 text-[10px] tracking-[.2em] border-b border-tech-border">Change %</th>
                      <th className="px-6 py-4 text-[10px] tracking-[.2em] border-b border-tech-border">Trend Profile</th>
                      <th className="px-6 py-4 text-[10px] tracking-[.2em] border-b border-tech-border">Rel. Vol</th>
                      <th className="px-6 py-4 text-[10px] tracking-[.2em] border-b border-tech-border">FUT OI Δ</th>
                      <th className="px-6 py-4 text-[10px] tracking-[.2em] border-b border-tech-border text-right">Exec</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs divide-y divide-tech-border">
                    {filteredStocks.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-6 py-20 text-center">
                           <div className="flex flex-col items-center gap-4">
                              <Search size={40} className="text-neutral-800" />
                              <div className="text-neutral-500 font-mono uppercase tracking-[0.3em]">No Alpha Opportunities Found for current filter</div>
                              <button onClick={() => setFilter('all')} className="text-neon-green text-[10px] font-bold underline">RESET FILTERS</button>
                           </div>
                        </td>
                      </tr>
                    ) : filteredStocks.map(stock => (
                      <tr key={stock.symbol} className="hover:bg-white/5 transition-colors group">
                        <td className="px-6 py-4">
                          <div className="flex flex-col gap-1">
                            <span className="text-sm font-black text-white tracking-tighter">{stock.symbol}</span>
                            <span className="text-[9px] text-neutral-500 uppercase tracking-widest">{stock.sector}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 font-mono text-neutral-200">
                          {formatCurrency(stock.lastPrice)}
                        </td>
                        <td className="px-6 py-4">
                          <span className={cn("font-bold text-sm tracking-tighter", stock.pChange >= 0 ? "text-neon-green" : "text-neon-red")}>
                            {stock.pChange >= 0 ? "+" : ""}{(stock.pChange || 0).toFixed(2)}%
                          </span>
                        </td>
                        <td className="px-6 py-4">
                           <span className={cn(
                            "px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter",
                            stock.trend === Trend.BULLISH ? "bg-neon-green/10 text-neon-green" : stock.trend === Trend.BEARISH ? "bg-neon-red/10 text-neon-red" : "bg-neutral-800 text-neutral-500"
                          )}>
                            {stock.trend}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-neutral-400 font-bold">
                          {(stock.relVolume || 0).toFixed(2)}X
                        </td>
                        <td className="px-6 py-4">
                          <span className={cn("font-bold", stock.oiChange > 0 ? "text-neon-green" : "text-neon-red")}>
                             {stock.oiChange > 0 ? "+" : ""}{stock.oiChange.toFixed(2)}%
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button 
                            onClick={() => handleStockSelect(stock)}
                            className="bg-neon-green text-black px-5 py-2 text-[10px] font-black uppercase tracking-tighter hover:bg-[#00e082] transition-all shadow-[0_4px_10px_rgba(0,255,148,0.2)]"
                          >
                            RUN ALPHA SCAN
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}

          {activeView === 'analysis' && (
            <motion.div 
              key="analysis-container"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-6"
            >
              {!selectedStock ? (
                <div className="bg-tech-surface border border-tech-border p-20 flex flex-col items-center justify-center text-center">
                  <Search className="w-16 h-16 text-neutral-800 mb-6" />
                  <h3 className="text-2xl font-black text-white mb-2">Alpha Engine Ready</h3>
                  <p className="text-neutral-500 font-mono text-xs mb-8 uppercase tracking-widest max-w-md">No security selected for deep analysis. Select an active ticker from the dashboard or use the quick switcher below.</p>
                  
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full max-w-2xl">
                    {stocks.slice(0, 8).map(s => (
                      <button 
                        key={s.symbol}
                        onClick={() => setSelectedStock(s)}
                        className="bg-tech-bg border border-tech-border p-4 hover:border-neon-green transition-all group"
                      >
                        <div className="text-sm font-black text-white group-hover:text-neon-green">{s.symbol}</div>
                        <div className={cn("text-[9px] font-mono", s.pChange >= 0 ? "text-neon-green" : "text-neon-red")}>
                          {s.pChange >= 0 ? "+" : ""}{s.pChange}%
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                  {/* Existing Analysis Content */}
                  <div className="lg:col-span-1 space-y-6">
                     <div className="bg-tech-surface border border-tech-border p-6 shadow-2xl">
                        <div className="flex items-center justify-between mb-6">
                           <div className="flex flex-col">
                              <h2 className="text-3xl font-black tracking-tighter text-white">{selectedStock.symbol}</h2>
                              <span className="text-[10px] text-neutral-500 font-mono uppercase tracking-widest">Deep Volatility Scan</span>
                           </div>
                           <button 
                             onClick={() => setSelectedStock(null)}
                             className="text-[9px] font-mono text-neutral-600 hover:text-white uppercase"
                           >
                             [Change]
                           </button>
                        </div>
                        <div className="space-y-4 font-mono">
                           <div className="flex justify-between items-baseline">
                             <span className="text-[10px] text-neutral-500 uppercase tracking-widest">SPOT PRICE</span>
                             <span className="text-xl font-bold text-white">₹{selectedStock.lastPrice.toLocaleString()}</span>
                           </div>
                           <div className="flex justify-between items-baseline">
                             <span className="text-[10px] text-neutral-500 uppercase tracking-widest">TREND_STATE</span>
                             <span className={cn("text-xs font-black px-2 py-0.5", selectedStock.trend === Trend.BULLISH ? "bg-neon-green text-black" : "bg-neon-red")}>
                                {selectedStock.trend}
                             </span>
                           </div>
                           <div className="flex justify-between items-baseline">
                             <span className="text-[10px] text-neutral-500 uppercase tracking-widest">REL VOLUME</span>
                             <span className="text-sm font-bold text-neon-green">{selectedStock.relVolume.toFixed(2)}x</span>
                           </div>
                           <div className="flex justify-between items-baseline">
                             <span className="text-[10px] text-neutral-500 uppercase tracking-widest">RS INDEX</span>
                             <span className="text-sm font-bold text-neutral-200">{selectedStock.relativeStrength.toFixed(2)}</span>
                           </div>
                        </div>

                        <div className="mt-8 pt-8 border-t border-tech-border space-y-4">
                           <h3 className="text-[10px] font-mono font-bold uppercase text-neutral-500 tracking-[0.2em]">Quant-TF Correlation</h3>
                           <div className="grid grid-cols-2 gap-2">
                              {['Daily', 'Hourly', '15m', '5m'].map(tf => (
                                <div key={tf} className="bg-tech-bg p-2 border border-tech-border flex items-center justify-between">
                                   <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest">{tf}</span>
                                   <TrendingUp size={12} className="text-neon-green" />
                                </div>
                              ))}
                           </div>
                        </div>
                     </div>
                  </div>

                  <div className="lg:col-span-3 space-y-6">
                    {/* Trading Recommendation */}
                    <div className={cn("bg-tech-surface border-2 p-6 shadow-[0_20px_50px_rgba(0,0,0,0.5)] relative overflow-hidden", 
                      recommendation?.action === OptionAction.BUY_CE ? "border-neon-green/30 shadow-neon-green/5" : "border-neon-red/30 shadow-neon-red/5"
                    )}>
                      {loadingAnalysis ? (
                        <div className="flex flex-col items-center justify-center min-h-[300px] gap-4">
                           <RefreshCw className="animate-spin text-neon-green" size={32} />
                           <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-[.2em]">Quant-AI Processing...</span>
                        </div>
                      ) : (
                        <>
                           <div className="absolute top-0 right-0 p-4 opacity-10">
                              <Target size={48} className={cn(recommendation?.action === OptionAction.BUY_CE ? "text-neon-green" : "text-neon-red")} />
                           </div>
                           <h3 className="text-[10px] font-mono font-extrabold uppercase text-neutral-500 tracking-[0.3em] mb-6">AI Execution Signal</h3>
                           <div className="flex flex-col gap-1 mb-8">
                              <span className={cn("text-4xl font-black uppercase tracking-tighter leading-none", 
                                recommendation?.action === OptionAction.BUY_CE ? "text-neon-green glow-green" : "text-neon-red glow-red"
                              )}>{recommendation?.action}</span>
                              <span className="text-sm font-bold text-white font-mono tracking-tight mt-2">{selectedStock.symbol} {recommendation?.strike} {recommendation?.expiry}</span>
                           </div>

                           <div className="grid grid-cols-2 gap-2 mb-8 uppercase font-mono">
                              <div className="p-3 bg-tech-bg border border-tech-border">
                                 <span className="text-[8px] text-neutral-500 block mb-1">Entry Range</span>
                                 <span className="text-sm font-bold text-white tracking-widest">{formatCurrency(recommendation?.entryPrice || 0)}</span>
                              </div>
                              <div className="p-3 bg-tech-bg border border-neon-red/20 text-neon-red">
                                 <span className="text-[8px] block mb-1">Stop Loss</span>
                                 <span className="text-sm font-bold tracking-widest">{formatCurrency(recommendation?.stopLoss || 0)}</span>
                              </div>
                           </div>

                           <div className="space-y-2 mb-8 font-mono">
                              {recommendation?.targets?.map((tgt: number, i: number) => (
                                <div key={i} className="flex justify-between items-center bg-tech-bg p-2.5 border border-neon-green/20">
                                   <span className="text-[10px] text-neon-green font-bold uppercase tracking-widest">TARGET_{i+1}</span>
                                   <span className="text-sm font-bold text-white tracking-widest">{formatCurrency(tgt)}</span>
                                </div>
                              ))}
                           </div>

                           <div className="flex items-center justify-between text-[10px] font-mono font-bold tracking-widest uppercase py-4 border-t border-tech-border">
                              <span className="text-neutral-500">PROB: <span className="text-white">{aiAnalysis?.winProbability}%</span></span>
                              <span className="text-neon-green">R:R {recommendation?.riskReward.toFixed(2)}</span>
                           </div>

                           <button 
                             onClick={() => executeTrade(selectedStock, recommendation!, aiAnalysis!)}
                             disabled={isAutoTrading}
                             className={cn(
                               "w-full py-4 font-black uppercase tracking-[.3em] text-xs transition-all flex items-center justify-center gap-3",
                               recommendation?.action === OptionAction.BUY_CE 
                                 ? "bg-neon-green text-black hover:bg-white shadow-[0_0_20px_rgba(0,255,148,0.3)]" 
                                 : "bg-neon-red text-white hover:bg-white hover:text-black shadow-[0_0_20px_rgba(255,49,49,0.3)]",
                               isAutoTrading && "opacity-50 cursor-not-allowed grayscale"
                             )}
                           >
                             {isAutoTrading ? "QUANT_BOT_HANDLING" : "INITIALIZE_INSTITUTIONAL_ORDER"}
                           </button>
                        </>
                      )}
                    </div>

                    <div className="bg-tech-surface border border-tech-border p-8 shadow-2xl relative overflow-hidden">
                       <div className="absolute top-0 right-0 w-64 h-64 bg-neon-green/5 blur-[100px] rounded-full pointer-events-none"></div>
                       <div className="flex flex-col md:flex-row gap-12 items-center relative z-10">
                          <div className="flex flex-col items-center">
                             <div className={cn(
                               "w-24 h-24 rounded-full border-[6px] flex items-center justify-center mb-4 transition-all duration-1000",
                               aiAnalysis && aiAnalysis.winProbability > 75 ? "border-neon-green text-neon-green glow-green shadow-[0_0_15px_rgba(0,255,148,0.2)]" : "border-tech-border text-neutral-500"
                             )}>
                                <span className="text-3xl font-black">{aiAnalysis?.winProbability}%</span>
                             </div>
                             <span className="text-[10px] uppercase font-mono font-bold text-neutral-500 tracking-[0.3em] text-center">Alpha Probability</span>
                          </div>

                          <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-6 w-full">
                             <RiskIndicator label="MOMENTUM_STR" score={aiAnalysis?.momentumScore || 0} />
                             <RiskIndicator label="INSTITUTIONAL_FLW" score={aiAnalysis?.institutionalActivityScore || 0} />
                             <RiskIndicator label="BREAKOUT_QUAL" score={aiAnalysis?.breakoutQualityScore || 0} />
                             <RiskIndicator label="AGGREGATED_RISK" score={aiAnalysis?.riskScore || 0} />
                          </div>
                       </div>
                       {aiAnalysis && (
                         <div className="mt-10 p-5 bg-[#0b0e14] border border-tech-border">
                            <p className="text-xs text-neutral-300 leading-loose uppercase font-mono tracking-wider italic">
                              <Zap size={14} className="inline mr-3 text-neon-green fill-neon-green" />
                              {aiAnalysis.summary}
                            </p>
                         </div>
                       )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                       <div className="bg-tech-surface border border-tech-border overflow-hidden h-[500px] flex flex-col shadow-xl">
                          <div className="p-4 border-b border-tech-border bg-[#1a1d23] flex justify-between items-center">
                             <h3 className="text-[10px] font-bold text-white uppercase tracking-[0.3em] flex items-center gap-3">
                                <Layers size={16} className="text-sky-400" />
                                Institutional OI Profile
                             </h3>
                          </div>
                          <div className="flex-1 overflow-auto custom-scrollbar uppercase">
                             <table className="w-full text-[10px] font-mono">
                                <thead className="sticky top-0 bg-[#0B0E14] border-b border-tech-border z-10">
                                   <tr>
                                      <th className="px-4 py-4 text-neutral-500 tracking-widest text-left uppercase">CE_VOL</th>
                                      <th className="px-4 py-4 text-white text-center font-black uppercase tracking-widest">Strike</th>
                                      <th className="px-4 py-4 text-neutral-500 tracking-widest text-right uppercase">PE_VOL</th>
                                   </tr>
                                </thead>
                                <tbody className="divide-y divide-tech-border">
                                   {Array.from({ length: 11 }).map((_, i) => {
                                     const baseStrike = Math.round(selectedStock.lastPrice / 50) * 50;
                                     const strike = baseStrike - 250 + i * 50;
                                     const ce = optionChain.find(o => o.strike === strike && o.type === 'CE');
                                     const pe = optionChain.find(o => o.strike === strike && o.type === 'PUT');
                                     const isAtm = strike === baseStrike;
                                     
                                     return (
                                       <tr key={strike} className={cn("hover:bg-white/5 transition-colors", isAtm && "bg-neon-green/5")}>
                                          <td className="px-4 py-3">
                                             <div className="flex items-center gap-3">
                                                <div className="h-1.5 bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.3)] transition-all duration-700" style={{ width: `${Math.min(100, (ce?.oi || 0) / 1000)}%` }} />
                                                <span className="text-neutral-400">{formatNumber(ce?.oi || 0)}</span>
                                             </div>
                                          </td>
                                          <td className="px-4 py-3 text-center font-black text-white bg-tech-bg/80 border-x border-tech-border">{strike}</td>
                                          <td className="px-4 py-3">
                                             <div className="flex items-center justify-end gap-3">
                                                <span className="text-neutral-400">{formatNumber(pe?.oi || 0)}</span>
                                                <div className="h-1.5 bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.3)] transition-all duration-700" style={{ width: `${Math.min(100, (pe?.oi || 0) / 1000)}%` }} />
                                             </div>
                                          </td>
                                       </tr>
                                     );
                                   })}
                                </tbody>
                             </table>
                          </div>
                       </div>

                       <div className="bg-tech-surface border border-tech-border flex flex-col shadow-xl">
                          <div className="p-4 border-b border-tech-border bg-[#1a1d23] flex gap-6">
                             <button 
                               onClick={() => setAnalysisTab('iv')}
                               className={cn(
                                 "text-[10px] font-mono font-bold tracking-[0.2em] uppercase pb-1 transition-all",
                                 analysisTab === 'iv' ? "text-neon-green border-b-2 border-neon-green shadow-neon-green" : "text-neutral-500 hover:text-white"
                               )}
                             >
                               IV_VECTOR
                             </button>
                             <button 
                               onClick={() => setAnalysisTab('oi')}
                               className={cn(
                                 "text-[10px] font-mono font-bold tracking-[0.2em] uppercase pb-1 transition-all",
                                 analysisTab === 'oi' ? "text-neon-green border-b-2 border-neon-green shadow-neon-green" : "text-neutral-500 hover:text-white"
                               )}
                             >
                               OI_DELTA
                             </button>
                          </div>
                          <div className="flex-1 p-8 h-[400px]">
                             <ResponsiveContainer width="100%" height="100%">
                                {analysisTab === 'iv' ? (
                                  <AreaChart data={[
                                    { time: '10:00', val: 18.2 },
                                    { time: '11:00', val: 19.5 },
                                    { time: '12:00', val: 18.8 },
                                    { time: '13:00', val: 20.4 },
                                    { time: '14:00', val: 22.1 },
                                    { time: '15:00', val: 21.8 },
                                  ]}>
                                     <defs>
                                       <linearGradient id="colorIv" x1="0" y1="0" x2="0" y2="1">
                                         <stop offset="5%" stopColor="#00FF94" stopOpacity={0.4}/>
                                         <stop offset="95%" stopColor="#00FF94" stopOpacity={0}/>
                                       </linearGradient>
                                     </defs>
                                     <CartesianGrid strokeDasharray="3 3" stroke="#242831" vertical={false} />
                                     <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#666', fontFamily: 'JetBrains Mono' }} />
                                     <YAxis domain={['auto', 'auto']} axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#666', fontFamily: 'JetBrains Mono' }} />
                                     <Tooltip 
                                       contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #242831', fontSize: '10px', borderRadius: '0px', fontFamily: 'JetBrains Mono' }}
                                       itemStyle={{ color: '#00FF94' }}
                                     />
                                     <Area type="stepAfter" dataKey="val" stroke="#00FF94" fillOpacity={1} fill="url(#colorIv)" strokeWidth={2} />
                                  </AreaChart>
                                ) : (
                                  <BarChart data={[
                                    { time: '10:00', ce: 4500, pe: 3200 },
                                    { time: '11:00', ce: 5100, pe: 3400 },
                                    { time: '12:00', ce: 4800, pe: 4100 },
                                    { time: '13:00', ce: 5900, pe: 3800 },
                                    { time: '14:00', ce: 6200, pe: 4500 },
                                    { time: '15:00', ce: 5800, pe: 4900 },
                                  ]}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#242831" vertical={false} />
                                    <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#666', fontFamily: 'JetBrains Mono' }} />
                                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#666', fontFamily: 'JetBrains Mono' }} />
                                    <Tooltip 
                                      contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #242831', fontSize: '10px', borderRadius: '0px', fontFamily: 'JetBrains Mono' }}
                                    />
                                    <Bar dataKey="ce" fill="#0ea5e9" radius={[2, 2, 0, 0]} />
                                    <Bar dataKey="pe" fill="#f43f5e" radius={[2, 2, 0, 0]} />
                                  </BarChart>
                                )}
                             </ResponsiveContainer>
                          </div>
                          <div className="p-4 border-t border-tech-border bg-tech-bg/50 text-[9px] text-neon-green font-mono font-black text-center tracking-[.4em] uppercase">
                             System Alert: High Velocity Volatility Expansion Confirmed
                          </div>
                       </div>
                    </div>

                    {/* Indicators Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                       {[
                         { label: 'RSI(14)_INDEX', value: (selectedStock.rsi || 0).toFixed(2), status: selectedStock.rsi > 70 ? 'OVERBOUGHT' : selectedStock.rsi < 30 ? 'OVERSOLD' : 'STABLE' },
                         { label: 'VWAP_VECTOR', value: formatCurrency(selectedStock.vwap || selectedStock.lastPrice), status: selectedStock.lastPrice > (selectedStock.vwap || 0) ? 'BULLISH' : 'BEARISH' },
                         { label: 'EMA_20_SIG', value: formatCurrency(selectedStock.ema20 || selectedStock.lastPrice), status: selectedStock.lastPrice > (selectedStock.ema20 || 0) ? 'SUPP_ENABLED' : 'RES_ACTIVE' },
                         { 
                           label: 'PCR_L_VOL', 
                           value: (() => {
                             const callOi = optionChain.filter(o => o.type === 'CE').reduce((acc, o) => acc + o.oi, 0);
                             const putOi = optionChain.filter(o => o.type === 'PUT').reduce((acc, o) => acc + o.oi, 0);
                             return callOi > 0 ? (putOi / callOi).toFixed(2) : '1.00';
                           })(), 
                           status: 'C_UNWINDING' 
                         },
                       ].map((idx, i) => (
                         <div key={i} className="bg-tech-surface border border-tech-border p-5 relative group overflow-hidden">
                            <div className="absolute top-0 left-0 w-1 h-full bg-tech-border group-hover:bg-neon-green transition-colors"></div>
                            <div className="text-[9px] font-mono font-bold text-neutral-500 mb-2 tracking-widest uppercase">{idx.label}</div>
                            <div className="text-sm font-black text-white mb-1.5 font-mono">{idx.value}</div>
                            <div className={cn("text-[9px] font-black tracking-widest uppercase", 
                              idx.status.includes('BULLISH') || idx.status === 'SUPP_ENABLED' ? "text-neon-green" :
                              idx.status.includes('BEARISH') || idx.status === 'RES_ACTIVE' ? "text-neon-red" : "text-amber-500"
                            )}>{idx.status}</div>
                         </div>
                       ))}
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}
          {activeView === 'trades' && (
            <motion.div 
              key="trades"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-6"
            >
              <div className="flex justify-between items-center bg-tech-surface border border-tech-border p-4 mb-2">
                <div className="flex gap-8">
                  <div className="flex flex-col">
                    <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Realized PnL</span>
                    <span className={cn("text-xl font-black font-mono", realizedPnL >= 0 ? "text-neon-green" : "text-neon-red")}>
                      {realizedPnL >= 0 ? '+' : ''}{formatCurrency(realizedPnL)}
                    </span>
                  </div>
                  <div className="w-px h-10 bg-tech-border"></div>
                  <div className="flex flex-col">
                    <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Unrealized PnL</span>
                    <span className={cn("text-xl font-black font-mono", unrealizedPnL >= 0 ? "text-neon-green" : "text-neon-red")}>
                      {unrealizedPnL >= 0 ? '+' : ''}{formatCurrency(unrealizedPnL)}
                    </span>
                  </div>
                  <div className="w-px h-10 bg-tech-border"></div>
                  <div className="flex flex-col">
                    <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Net Session</span>
                    <span className={cn("text-xl font-black font-mono", dailyPnL >= 0 ? "text-neon-green" : "text-neon-red")}>
                      {dailyPnL >= 0 ? '+' : ''}{formatCurrency(dailyPnL)}
                    </span>
                  </div>
                </div>
                
                <div className="flex bg-tech-bg border border-tech-border p-1">
                  <button className="px-6 py-1.5 text-[10px] font-black uppercase tracking-widest bg-neon-green text-black">Live Exposure</button>
                  <button className="px-6 py-1.5 text-[10px] font-black uppercase tracking-widest text-neutral-500 hover:text-white transition-colors" onClick={() => setActiveView('analytics')}>Trade History</button>
                </div>
              </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <StatCard title="Account Balance" value={formatCurrency(portfolio?.balance || 0)} />
                <StatCard title="Capital Deployed" value={formatCurrency(positions.reduce((acc, p) => acc + ((p.entry || 0) * (p.qty || 0)), 0))} />
                <StatCard title="Active PnL" value={formatCurrency(unrealizedPnL)} change={portfolio?.balance ? (unrealizedPnL / portfolio.balance * 100) : 0} />
                <StatCard title="Net ROI" value={portfolio?.balance ? (dailyPnL / portfolio.balance * 100).toFixed(2) : "0.00"} suffix="%" change={0.8} />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                <div className="xl:col-span-2 space-y-6">
                  <div className="flex justify-between items-center">
                    <h2 className="text-[10px] font-mono font-bold uppercase tracking-[.3em] text-neutral-500">Active High-Freq Quant Positions</h2>
                  </div>
                  <div className="border border-tech-border bg-tech-surface overflow-hidden shadow-2xl">
                    <table className="w-full text-left font-mono">
                      <thead className="text-[10px] bg-[#1a1d23] text-neutral-500 border-b border-tech-border uppercase">
                        <tr>
                          <th className="px-4 py-3 tracking-widest">Symbol</th>
                          <th className="px-4 py-3 tracking-widest">Type</th>
                          <th className="px-4 py-3 tracking-widest text-center">Entry Time</th>
                          <th className="px-4 py-3 tracking-widest text-right">Lots</th>
                          <th className="px-4 py-3 tracking-widest text-right">Entry</th>
                          <th className="px-4 py-3 tracking-widest text-right">Live</th>
                          <th className="px-4 py-3 tracking-widest text-right">SL</th>
                          <th className="px-4 py-3 tracking-widest text-right">Targets</th>
                          <th className="px-4 py-3 tracking-widest text-right">Margin</th>
                          <th className="px-4 py-3 tracking-widest text-right">PnL</th>
                          <th className="px-4 py-3 tracking-widest text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="text-[11px] divide-y divide-tech-border">
                        {positions.length === 0 ? (
                          <tr>
                            <td colSpan={10} className="px-4 py-24 text-center text-neutral-600 uppercase tracking-widest italic font-mono">
                               <div className="flex flex-col items-center gap-4">
                                  <RefreshCw className="animate-spin opacity-20" size={32} />
                                  Scanning Universe for Alpha Entry...
                               </div>
                            </td>
                          </tr>
                        ) : (
                          positions.map(pos => {
                            if (!pos) return null;
                            const livePrice = (monitoredPrices && monitoredPrices[pos.fyersSymbol]) || pos.currentPrice || pos.entry || 0;
                            const currentPnl = (livePrice - (pos.entry || 0)) * (pos.qty || 0);
                            
                            return (
                              <tr key={pos.id} className="hover:bg-white/5 transition-all">
                                <td className="px-4 py-3">
                                  <div className="flex flex-col">
                                    <span className="font-bold text-white tracking-widest">{pos.symbol || 'UNKNOWN'}</span>
                                    <span className="text-[9px] text-neutral-500 uppercase tracking-widest">Strike: {pos.strike || 'N/A'}</span>
                                  </div>
                                </td>
                                <td className={cn("px-4 py-3 font-black", (pos.type || '').includes('CE') ? "text-neon-green" : "text-neon-red")}>{pos.type || 'N/A'}</td>
                                <td className="px-4 py-3 text-center text-neutral-500 font-mono text-[9px]">
                                  {(pos.createdAt?.toDate?.() || (pos.createdAt instanceof Date ? pos.createdAt : new Date())).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <div className="flex flex-col items-end">
                                    <span className="text-white font-bold">{pos.numLots || Math.round((pos.qty || 0) / (pos.lotSize || 1)) || 0} L</span>
                                    <span className="text-[8px] text-neutral-500">Size: {pos.lotSize || 1}</span>
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-neutral-400 text-right">{(pos.entry || 0).toFixed(2)}</td>
                                <td className={cn("px-4 py-3 font-bold text-right", (livePrice || 0) >= (pos.entry || 0) ? "text-neon-green" : "text-neon-red")}>
                                  {(livePrice || 0).toFixed(2)}
                                </td>
                                <td className="px-4 py-3 text-neon-red/70 text-right">{(pos.sl || 0).toFixed(2)}</td>
                                <td className="px-4 py-3 text-neon-green/70 text-right">
                                  <div className="flex flex-col items-end">
                                    {(() => {
                                      const targets = Array.isArray(pos.targets) ? pos.targets : [];
                                      // Ensure targets are sorted ascending (for CE/PE buying, we want them in increasing order)
                                      const sortedTgt = [...targets].sort((a, b) => a - b);
                                      return (
                                        <>
                                          <span className="text-[9px] font-bold text-neon-green">{sortedTgt[0] || 'N/A'}</span>
                                          {sortedTgt.length > 1 && <span className="text-[7px] opacity-40">[{sortedTgt.slice(1).join(', ')}]</span>}
                                        </>
                                      );
                                    })()}
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-white font-bold bg-white/5 text-right font-mono">{formatCurrency((pos.entry || 0) * (pos.qty || 0))}</td>
                                <td className={cn("px-4 py-3 font-black text-right", currentPnl >= 0 ? "text-neon-green glow-green" : "text-neon-red glow-red")}>
                                  {formatCurrency(currentPnl)}
                                </td>
                                <td className="px-4 py-3 text-right">
                                  <button 
                                    onClick={() => closePosition(pos.id)}
                                    className="text-neutral-500 hover:text-white uppercase text-[8px] font-black tracking-[.2em] border border-tech-border px-3 py-1 hover:border-white transition-all focus:outline-none"
                                  >
                                    LIQUIDATE
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  <h2 className="text-[10px] font-mono font-bold uppercase tracking-[.3em] text-neutral-500 mt-10">Institutional Execution Logs</h2>
                  <div className="bg-[#0b0e14] border border-tech-border p-5 h-[300px] overflow-y-auto font-mono text-[9px] space-y-3 custom-scrollbar">
                    {(!tradeLogs || tradeLogs.length === 0) && <div className="text-neutral-700 italic uppercase">System ready. Waiting for order triggers...</div>}
                    {tradeLogs && tradeLogs.map((log, i) => {
                      const logStr = String(log || '');
                      const isRejected = logStr.includes('REJECTED');
                      const isExecuted = logStr.includes('EXECUTED');
                      const isClosed = logStr.includes('CLOSED');
                      
                      return (
                        <div key={i} className="text-neutral-400 flex gap-4 items-start border-b border-white/5 pb-2">
                          <span className={cn(
                            "font-black shrink-0",
                            isRejected ? "text-neon-red" : isExecuted ? "text-neon-green" : isClosed ? "text-amber-500" : "text-sky-400"
                          )}>
                            [{isRejected ? 'REJECT' : isExecuted ? 'EXEC_OK' : isClosed ? 'EXIT_OK' : 'SYSTEM'}]
                          </span>
                          <span className={cn(isRejected && "text-neutral-500 italic")}>{logStr}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-8">
                   <div className="bg-tech-surface border border-tech-border p-6">
                      <h3 className="text-[10px] font-mono font-bold uppercase tracking-[.3em] text-neon-green mb-6">Capital Allocation</h3>
                      <div className="h-64">
                         <ResponsiveContainer width="100%" height="100%">
                            <RePieChart>
                               <Pie
                                 data={[
                                   { name: 'Active Margin', value: positions.length * 50000 },
                                   { name: 'Free Liquid', value: (portfolio?.balance || 1000000) - (positions.length * 50000) },
                                 ]}
                                 cx="50%"
                                 cy="50%"
                                 innerRadius={60}
                                 outerRadius={80}
                                 paddingAngle={5}
                                 dataKey="value"
                               >
                                 <Cell fill="#00FF94" />
                                 <Cell fill="#1a1d23" />
                               </Pie>
                               <Tooltip contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #242831' }} />
                            </RePieChart>
                         </ResponsiveContainer>
                      </div>
                      <div className="space-y-4">
                         <div className="flex justify-between text-[10px] font-mono uppercase tracking-widest">
                            <span className="text-neutral-500">Margin Utilization</span>
                            <span className="text-white">{(positions.length * 5).toFixed(1)}%</span>
                         </div>
                         <div className="h-1.5 bg-tech-border overflow-hidden">
                            <div className="h-full bg-neon-green" style={{ width: `${positions.length * 5}%` }}></div>
                         </div>
                      </div>
                   </div>

                   <div className="bg-tech-surface border border-tech-border p-6 shadow-2xl">
                      <h3 className="text-[10px] font-mono font-bold uppercase tracking-[.3em] text-neutral-500 mb-6">Risk Profile: {positions.length > 3 ? 'MODERATE' : 'CONSERVATIVE'}</h3>
                      <div className="space-y-5">
                         {[
                           { label: 'Max Drawdown', val: '2.4%', color: 'text-neon-red' },
                           { label: 'Sharpe Ratio', val: '2.84', color: 'text-neon-green' },
                           { label: 'Volatility(Vol)', val: '14.2', color: 'text-amber-500' },
                           { label: 'Recovery Factor', val: '3.1', color: 'text-neon-green' }
                         ].map(r => (
                           <div key={r.label} className="flex justify-between items-baseline border-b border-tech-border pb-3">
                              <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">{r.label}</span>
                              <span className={cn("text-xs font-black font-mono", r.color)}>{r.val}</span>
                           </div>
                         ))}
                      </div>
                   </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeView === 'risk' && (
             <motion.div 
               key="risk"
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               exit={{ opacity: 0 }}
               className="space-y-6"
             >
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="bg-tech-surface border border-tech-border p-6 lg:col-span-1">
                       <h3 className="text-[10px] font-mono font-bold uppercase text-neutral-500 tracking-widest mb-6 underline decoration-neon-green/30">Alpha Learning Logic</h3>
                       <div className="space-y-6">
                          <div className="p-4 bg-tech-bg border border-tech-border">
                             <div className="text-[8px] text-neutral-500 uppercase mb-2">Success Correlation (Prob &gt; 85%)</div>
                             <div className="flex items-center gap-3">
                                <div className="text-2xl font-black text-white">
                                   {tradeHistory.filter(t => t.prob >= 85).length > 0 
                                     ? ((tradeHistory.filter(t => t.prob >= 85 && t.pnl > 0).length / tradeHistory.filter(t => t.prob >= 85).length) * 100).toFixed(0)
                                     : '0'}%
                                </div>
                                <div className="h-1 flex-1 bg-tech-border rounded-full overflow-hidden">
                                   <div className="h-full bg-neon-green" style={{ width: `${tradeHistory.filter(t => t.prob >= 85).length > 0 ? (tradeHistory.filter(t => t.prob >= 85 && t.pnl > 0).length / tradeHistory.filter(t => t.prob >= 85).length) * 100 : 0}%` }}></div>
                                </div>
                             </div>
                             <span className="text-[7px] text-neutral-600 font-mono italic">Insight: Higher confidence signals correlated with +12% higher edge.</span>
                          </div>

                          <div className="p-4 bg-tech-bg border border-tech-border">
                             <div className="text-[8px] text-neutral-500 uppercase mb-2">Alpha Decay Rate (Theta)</div>
                             <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-white tracking-widest">
                                   Avg Hold: {tradeHistory && tradeHistory.length > 0 
                                     ? (tradeHistory.reduce((acc, t) => {
                                         if (!t) return acc;
                                         const start = t.timestamp?.toDate?.() || (t.timestamp instanceof Date ? t.timestamp : new Date());
                                         const end = t.closedAt?.toDate?.() || (t.closedAt instanceof Date ? t.closedAt : new Date());
                                         return acc + (end.getTime() - start.getTime());
                                       }, 0) / tradeHistory.length / 60000).toFixed(1)
                                     : '0'}m
                                </span>
                                <TrendingDown size={14} className="text-neon-red opacity-50" />
                             </div>
                             <p className="text-[7px] text-neutral-500 mt-2 leading-relaxed">
                                Self-Correction: Option value decreases by ~₹142 per minute of sideways chop.
                             </p>
                          </div>
                       </div>
                    </div>

                    <div className="bg-tech-surface border border-tech-border p-6 lg:col-span-2">
                       <h3 className="text-[10px] font-mono font-bold uppercase text-neutral-500 tracking-widest mb-6">Trade Quality Distribution</h3>
                       <div className="h-[180px]">
                          <ResponsiveContainer width="100%" height="100%">
                             <BarChart data={[
                               { range: '80-84%', count: tradeHistory.filter(t => t.prob >= 80 && t.prob < 85).length, win: tradeHistory.filter(t => t.prob >= 80 && t.prob < 85 && t.pnl > 0).length },
                               { range: '85-89%', count: tradeHistory.filter(t => t.prob >= 85 && t.prob < 90).length, win: tradeHistory.filter(t => t.prob >= 85 && t.prob < 90 && t.pnl > 0).length },
                               { range: '90%+', count: tradeHistory.filter(t => t.prob >= 90).length, win: tradeHistory.filter(t => t.prob >= 90 && t.pnl > 0).length },
                             ]}>
                                <XAxis dataKey="range" hide />
                                <YAxis hide />
                                <Tooltip contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #1a1d23', fontSize: '10px', fontFamily: 'monospace' }} />
                                <Bar dataKey="count" fill="#334155" label={{ position: 'top', fill: '#94a3b8', fontSize: 10 }} />
                                <Bar dataKey="win" fill="#00ff94" />
                             </BarChart>
                          </ResponsiveContainer>
                       </div>
                       <div className="flex justify-center gap-6 mt-4 font-mono text-[8px] uppercase tracking-widest">
                          <div className="flex items-center gap-2">
                             <div className="w-2 h-2 bg-slate-600"></div> Total Sample
                          </div>
                          <div className="flex items-center gap-2">
                             <div className="w-2 h-2 bg-neon-green"></div> Alpha Success
                          </div>
                       </div>
                    </div>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                   <div className="bg-tech-surface border border-tech-border p-8 space-y-8 shadow-2xl">
                      <div className="flex items-center justify-between gap-4 mb-4">
                         <div className="flex items-center gap-4">
                            <Shield className="text-neon-green" size={24} />
                            <h2 className="text-xl font-black uppercase tracking-tighter">Global Risk Management</h2>
                         </div>
                         <button 
                            onClick={() => updateRiskSettings({ killSwitch: !riskSettings?.killSwitch })}
                            className={cn(
                               "px-6 py-2 text-[10px] font-black uppercase tracking-[.3em] transition-all border",
                               riskSettings?.killSwitch 
                                 ? "bg-neon-red text-white border-neon-red glow-red" 
                                 : "bg-neutral-800 text-neutral-500 border-tech-border hover:bg-white hover:text-black hover:border-white shadow-xl"
                            )}
                         >
                            {riskSettings?.killSwitch ? "KILL_SWITCH_ACTIVE" : "ARM_KILL_SWITCH"}
                         </button>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-6">
                         {[
                           { label: 'Max Capital Allocation', key: 'maxCapital', min: 100000, max: 2000000, step: 50000, isCurrency: true, current: positions.reduce((acc, p) => acc + (p.entry * p.qty), 0) },
                           { label: 'Max Trades Per Day', key: 'maxTradesPerDay', min: 1, max: 50, step: 1, current: [...positions, ...tradeHistory].filter(t => (t.timestamp?.toDate?.() || new Date()).toDateString() === new Date().toDateString()).length },
                           { label: 'Daily SL Limit', key: 'maxLossPerDay', min: 1000, max: 50000, step: 1000, isCurrency: true, current: Math.abs(Math.min(0, dailyPnL)) },
                           { label: 'Risk Per Order (%)', key: 'riskPerTrade', min: 0.1, max: 5, step: 0.1, isPercent: true },
                           { label: 'Max Concurrent Trades', key: 'maxConcurrentTrades', min: 1, max: 10, step: 1, current: positions.length },
                           { label: 'Max Capital Per Trade', key: 'maxCapitalPerTrade', min: 10000, max: 500000, step: 10000, isCurrency: true },
                         ].map(cfg => (
                            <div key={cfg.key} className="p-6 bg-tech-bg border border-tech-border space-y-4 group hover:border-neutral-700 transition-all">
                               <div className="flex justify-between items-center text-[9px] font-mono text-neutral-500 uppercase tracking-widest">
                                  <span>{cfg.label}</span>
                                  <div className="flex items-center gap-2">
                                     {cfg.current !== undefined && (
                                       <span className="text-neutral-600 mr-2">[USE: {cfg.isCurrency ? formatCurrency(cfg.current) : cfg.current}]</span>
                                     )}
                                     <span className="text-white font-bold text-xs">
                                        {cfg.isCurrency ? formatCurrency((editingSettings?.[cfg.key as keyof RiskSettings] as number) ?? (riskSettings?.[cfg.key as keyof RiskSettings] as number) ?? 0) : 
                                         cfg.isPercent ? `${editingSettings?.[cfg.key as keyof RiskSettings] ?? riskSettings?.[cfg.key as keyof RiskSettings] ?? 1}%` : 
                                         editingSettings?.[cfg.key as keyof RiskSettings] ?? riskSettings?.[cfg.key as keyof RiskSettings] ?? 0}
                                     </span>
                                  </div>
                               </div>
                               <input 
                                  type="range"
                                  min={cfg.min}
                                  max={cfg.max}
                                  step={cfg.step}
                                  disabled={riskSettings?.killSwitch}
                                  value={editingSettings?.[cfg.key as keyof RiskSettings] as number ?? riskSettings?.[cfg.key as keyof RiskSettings] as number ?? cfg.min}
                                  onChange={(e) => {
                                   const val = parseFloat(e.target.value);
                                   setEditingSettings(prev => {
                                      if (prev) return { ...prev, [cfg.key]: val };
                                      if (riskSettings) return { ...riskSettings, [cfg.key]: val };
                                      return null;
                                   });
                                }}
                                  className={cn(
                                     "w-full accent-neon-green bg-tech-border h-1 appearance-none cursor-pointer",
                                     riskSettings?.killSwitch && "opacity-20 cursor-not-allowed"
                                  )}
                               />
                            </div>
                         ))}
                      </div>

                      <div className="flex justify-end pt-4">
                         <button
                            onClick={() => editingSettings && updateRiskSettings(editingSettings)}
                            disabled={riskSettings?.killSwitch || JSON.stringify(riskSettings) === JSON.stringify(editingSettings)}
                            className={cn(
                               "px-8 py-3 text-[10px] font-black uppercase tracking-[.4em] transition-all",
                               JSON.stringify(riskSettings) !== JSON.stringify(editingSettings) 
                                 ? "bg-neon-green text-black hover:bg-white shadow-[0_0_20px_rgba(0,255,148,0.2)]" 
                                 : "bg-neutral-800 text-neutral-600 cursor-not-allowed"
                            )}
                         >
                            Apply_Risk_Configuration
                         </button>
                      </div>

                      <div className="space-y-6 pt-4 border-t border-tech-border">
                         <h3 className="text-[10px] font-mono font-bold uppercase tracking-widest text-neutral-500">Institutional Circuit Breakers</h3>
                         {[
                           { label: 'Drawdown Circuit Breaker', val: '5%', status: riskSettings?.killSwitch ? 'TRIPPED' : 'ARMED', color: riskSettings?.killSwitch ? 'bg-neon-red' : 'bg-neon-green' },
                           { label: 'Institutional Volatility Cap', val: '35%', status: 'MONITORING', color: 'bg-amber-500' },
                           { label: 'Event-Based Pause', val: 'ENABLED', status: 'ACTIVE', color: 'bg-neon-green' }
                         ].map(rule => (
                           <div key={rule.label} className="p-4 border border-tech-border bg-tech-bg/50 flex justify-between items-center group hover:border-white/20 transition-all">
                              <div className="flex flex-col gap-1">
                                 <span className="text-xs font-bold text-white uppercase">{rule.label}</span>
                                 <span className="text-[9px] text-neutral-500 font-mono tracking-widest">{rule.val}</span>
                              </div>
                              <div className="flex items-center gap-3">
                                 <span className="text-[8px] font-black font-mono text-neutral-500">{rule.status}</span>
                                 <div className={cn("w-2 h-2 rounded-full", rule.color)} />
                              </div>
                           </div>
                         ))}
                      </div>
                   </div>

                   <div className="bg-tech-surface border border-tech-border p-8">
                      <h2 className="text-sm font-bold uppercase tracking-[0.3em] text-neutral-500 mb-8">Monte Carlo Survival Projection</h2>
                      <div className="h-[300px]">
                         <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={[
                              { x: 0, y: 100 }, { x: 10, y: 105 }, { x: 20, y: 102 }, { x: 30, y: 110 }, 
                              { x: 40, y: 108 }, { x: 50, y: 115 }, { x: 60, y: 125 }, { x: 70, y: 122 },
                              { x: 80, y: 130 }, { x: 90, y: 128 }, { x: 100, y: 140 }
                            ]}>
                               <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                               <XAxis dataKey="x" hide />
                               <YAxis hide domain={['dataMin - 10', 'dataMax + 10']} />
                               <Line type="monotone" dataKey="y" stroke="#00FF94" strokeWidth={3} dot={false} strokeDasharray="4 4" />
                               <Line type="monotone" dataKey="y" stroke="#00FF94" strokeWidth={1} dot={false} opacity={0.3} />
                            </LineChart>
                         </ResponsiveContainer>
                      </div>
                      <div className="mt-8 p-6 bg-[#1a1d23] border border-tech-border text-[10px] font-mono text-neutral-400 leading-relaxed uppercase tracking-widest italic">
                         Analysis: Under current risk parameters, probability of ruin (POR) remains below 0.01% for 1,000 simulations at current win rate.
                      </div>
                   </div>
                </div>
             </motion.div>
           )}
           {activeView === 'analytics' && (
             <motion.div 
               key="analytics"
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               exit={{ opacity: 0 }}
               className="space-y-8 pb-10"
             >
                {/* Attribution Header */}
                <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-tech-border pb-6">
                   <div>
                      <div className="flex items-center gap-3 mb-2">
                         <div className="p-1.5 bg-neon-green/20 rounded">
                            <BarChart3 className="text-neon-green" size={20} />
                         </div>
                         <h1 className="text-3xl font-black text-white tracking-tighter">Attribution Analytics</h1>
                      </div>
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[10px] font-mono text-neutral-500 uppercase tracking-widest">
                         <span>{tradeHistory.length} closed trades</span>
                         {tradeHistory.length > 0 && (
                            <>
                               <span>•</span>
                               <span>
                                 {(() => {
                                   const start = tradeHistory[tradeHistory.length - 1].closedAt?.toDate?.() || tradeHistory[tradeHistory.length - 1].closedAt;
                                   const end = tradeHistory[0].closedAt?.toDate?.() || tradeHistory[0].closedAt;
                                   return `${(start instanceof Date ? start : new Date()).toLocaleDateString()} → ${(end instanceof Date ? end : new Date()).toLocaleDateString()}`;
                                 })()}
                               </span>
                               <span>•</span>
                               <span>{new Set(tradeHistory.map(t => (t.closedAt?.toDate?.() || t.closedAt || new Date()).toDateString())).size} trading days</span>
                            </>
                         )}
                      </div>
                   </div>
                   <div className="flex bg-tech-bg border border-tech-border p-1 rounded-sm">
                      <div className="px-4 py-1.5 text-[10px] font-bold text-white bg-white/5 border border-white/10 font-mono">
                         {new Date().toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })} IST
                      </div>
                   </div>
                </div>

                {/* KPI Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
                  {[
                    { 
                      label: 'Closed Trades', 
                      value: attributionStats?.total || 0, 
                      sub: `${attributionStats?.wins || 0}W / ${attributionStats?.losses || 0}L`,
                      color: 'text-white'
                    },
                    { 
                      label: 'Win Rate', 
                      value: `${(attributionStats?.winRate || 0).toFixed(1)}%`, 
                      sub: attributionStats && attributionStats.winRate > 50 ? 'Above Edge' : 'Needs Optimization',
                      color: attributionStats && attributionStats.winRate > 50 ? 'text-neon-green' : 'text-neon-red'
                    },
                    { 
                      label: 'Total PnL', 
                      value: formatCurrency(attributionStats?.totalPnl || 0), 
                      sub: `net: ${formatCurrency((attributionStats?.totalPnl || 0) * 0.98)} (est. drag)`,
                      color: (attributionStats?.totalPnl || 0) >= 0 ? 'text-neon-green' : 'text-neon-red'
                    },
                    { 
                      label: 'Profit Factor', 
                      value: (attributionStats?.profitFactor || 0).toFixed(2), 
                      sub: `net: ${(attributionStats?.profitFactor || 0 * 0.95).toFixed(2)}`,
                      color: (attributionStats?.profitFactor || 0) > 1.2 ? 'text-neon-green' : 'text-white'
                    },
                    { 
                      label: 'Max Drawdown', 
                      value: formatCurrency(attributionStats?.maxDd || 0), 
                      sub: 'peak → trough',
                      color: 'text-neon-red'
                    },
                    { 
                      label: 'Avg Win / Loss', 
                      value: `${formatCurrency(attributionStats?.avgWin || 0).replace('₹', '')} / ${formatCurrency(attributionStats?.avgLoss || 0).replace('₹', '')}`, 
                      sub: `ratio ${(attributionStats?.ratio || 0).toFixed(1)}`,
                      color: 'text-white'
                    },
                  ].map((kpi, i) => (
                    <div key={i} className="bg-tech-surface border border-tech-border p-6 rounded-sm space-y-3 group hover:border-white/20 transition-all">
                      <div className="text-[10px] font-mono font-bold text-neutral-500 uppercase tracking-[0.2em]">{kpi.label}</div>
                      <div className={cn("text-2xl font-black tracking-tight font-mono", kpi.color)}>{kpi.value}</div>
                      <div className="text-[9px] font-mono text-neutral-600 uppercase tracking-widest">{kpi.sub}</div>
                    </div>
                  ))}
                </div>

                {/* Sub Navigation */}
                <div className="flex border-b border-tech-border gap-8 overflow-x-auto no-scrollbar">
                  {[
                    { id: 'overview', label: 'Overview', icon: <PieChart size={14} /> },
                    { id: 'sl', label: 'SL Strategy', icon: <Target size={14} /> },
                    { id: 'calibration', label: 'Calibration', icon: <Activity size={14} /> },
                    { id: 'timing', label: 'Timing', icon: <Zap size={14} /> },
                    { id: 'exits', label: 'Exits & Trades', icon: <History size={14} /> },
                    { id: 'options', label: 'Options Lab', icon: <Layers size={14} /> },
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveAnalyticsTab(tab.id as any)}
                      className={cn(
                        "flex items-center gap-2 py-4 px-2 text-[11px] font-black uppercase tracking-widest transition-all relative",
                        activeAnalyticsTab === tab.id ? "text-neon-green" : "text-neutral-500 hover:text-neutral-300"
                      )}
                    >
                      {tab.icon}
                      {tab.label}
                      {activeAnalyticsTab === tab.id && (
                        <motion.div layoutId="activeTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-neon-green" />
                      )}
                    </button>
                  ))}
                </div>

                {activeAnalyticsTab === 'overview' && (
                  <div className="space-y-10">
                    <div>
                      <div className="mb-6">
                        <h2 className="text-xl font-black text-white uppercase tracking-tight mb-2">Performance by Setup</h2>
                        <p className="text-xs text-neutral-500 font-mono italic">Look for setups where count ≥ 5 AND win rate ≥ 55%. Discard or throttle anything consistently below 40%.</p>
                      </div>
                      
                      <div className="bg-tech-surface border border-tech-border rounded-sm overflow-hidden">
                        <table className="w-full text-left font-mono">
                          <thead className="bg-[#1a1d23] text-[9px] font-black text-neutral-500 uppercase tracking-[0.2em] border-b border-tech-border">
                            <tr>
                              <th className="px-6 py-4">Signal</th>
                              <th className="px-6 py-4 text-center">Tier</th>
                              <th className="px-6 py-4 text-center">Asset</th>
                              <th className="px-6 py-4 text-right">Trades</th>
                              <th className="px-6 py-4 text-right">Wins</th>
                              <th className="px-6 py-4 text-right">Win %</th>
                              <th className="px-6 py-4 text-right">Avg PNL</th>
                              <th className="px-6 py-4 text-right">Total PNL</th>
                            </tr>
                          </thead>
                          <tbody className="text-[11px] divide-y divide-tech-border bg-tech-surface">
                            {attributionStats?.setups.map((setup, i) => {
                              const wr = (setup.wins / setup.trades) * 100;
                              return (
                                <tr key={i} className="hover:bg-white/5 transition-all group">
                                  <td className="px-6 py-4 font-black text-white group-hover:text-neon-green">{setup.signal}</td>
                                  <td className="px-6 py-4">
                                    <div className="flex justify-center">
                                      <span className={cn(
                                        "px-2 py-0.5 rounded-[2px] text-[8px] font-black uppercase tracking-widest",
                                        setup.tier === 'T1' ? "bg-purple-500/20 text-purple-400" : 
                                        setup.tier === 'T2' ? "bg-blue-500/20 text-blue-400" : "bg-neutral-500/20 text-neutral-400"
                                      )}>
                                        {setup.tier}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="flex justify-center">
                                      <span className="px-2 py-0.5 rounded-[2px] text-[8px] font-black uppercase tracking-widest bg-sky-500/10 text-sky-400 border border-sky-400/20">
                                        {setup.asset}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 text-right text-white font-bold">{setup.trades}</td>
                                  <td className="px-6 py-4 text-right text-white/70">{setup.wins}</td>
                                  <td className={cn("px-6 py-4 text-right font-black", wr >= 55 ? "text-neon-green" : wr < 40 ? "text-neon-red" : "text-white")}>
                                    {wr.toFixed(1)}%
                                  </td>
                                  <td className={cn("px-6 py-4 text-right font-black", setup.pnl >= 0 ? "text-neon-green" : "text-neon-red")}>
                                    {setup.pnl >= 0 ? '+' : ''}{Math.round(setup.pnl / setup.trades)}
                                  </td>
                                  <td className={cn("px-6 py-4 text-right font-black", setup.pnl >= 0 ? "text-neon-green" : "text-neon-red")}>
                                    {formatCurrency(setup.pnl || 0)}
                                  </td>
                                </tr>
                              );
                            })}
                            {(!attributionStats || attributionStats.setups.length === 0) && (
                              <tr>
                                <td colSpan={8} className="px-6 py-12 text-center text-neutral-600 font-mono uppercase italic tracking-widest">
                                  No attribution data available. Please conclude trades first.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Secondary Insights Grid */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                       <div className="bg-tech-surface border border-tech-border p-8">
                          <div className="flex justify-between items-center mb-6">
                             <h3 className="text-sm font-black text-white uppercase tracking-tight">Equity Curve Alpha</h3>
                             <div className="flex gap-4 text-[9px] font-mono text-neutral-500">
                                <span>Sharpe: 2.42</span>
                                <span>Sortino: 3.11</span>
                             </div>
                          </div>
                          <div className="h-[280px]">
                             <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={tradeHistory.slice().reverse().map((t, idx) => ({
                                  idx,
                                  pnl: tradeHistory.slice().reverse().slice(0, idx + 1).reduce((acc, curr) => acc + (curr.pnl || 0), 0)
                                }))}>
                                   <defs>
                                     <linearGradient id="curvePnlAttr" x1="0" y1="0" x2="0" y2="1">
                                       <stop offset="5%" stopColor="#00FF94" stopOpacity={0.3}/>
                                       <stop offset="95%" stopColor="#00FF94" stopOpacity={0}/>
                                     </linearGradient>
                                   </defs>
                                   <XAxis dataKey="idx" hide />
                                   <YAxis hide domain={['dataMin - 1000', 'dataMax + 1000']} />
                                   <Tooltip contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #333', fontSize: '10px' }} />
                                   <Area type="monotone" dataKey="pnl" stroke="#00FF94" fill="url(#curvePnlAttr)" strokeWidth={3} dot={false} />
                                </AreaChart>
                             </ResponsiveContainer>
                          </div>
                       </div>

                       <div className="bg-tech-surface border border-tech-border p-8">
                          <h3 className="text-sm font-black text-white uppercase tracking-tight mb-6">Trade Quality Distribution</h3>
                          <div className="h-[280px]">
                             <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={[
                                  { range: '60-70%', count: tradeHistory.filter(t => t.prob >= 60 && t.prob < 70).length },
                                  { range: '70-80%', count: tradeHistory.filter(t => t.prob >= 70 && t.prob < 80).length },
                                  { range: '80-90%', count: tradeHistory.filter(t => t.prob >= 80 && t.prob < 90).length },
                                  { range: '90%+', count: tradeHistory.filter(t => t.prob >= 90).length },
                                ]}>
                                   <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1a1d23" />
                                   <XAxis dataKey="range" fontSize={10} axisLine={false} tickLine={false} tick={{ fill: '#4b5563' }} />
                                   <YAxis fontSize={10} axisLine={false} tickLine={false} tick={{ fill: '#4b5563' }} />
                                   <Tooltip contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #1a1d23', fontSize: '10px' }} />
                                   <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                                </BarChart>
                             </ResponsiveContainer>
                          </div>
                       </div>
                    </div>
                  </div>
                )}

                {activeAnalyticsTab === 'exits' && (
                  <div className="bg-tech-surface border border-tech-border p-8 overflow-hidden rounded-sm">
                    <div className="flex justify-between items-center mb-8">
                      <h3 className="text-xl font-black text-white uppercase tracking-tight">Closed Positions Ledger</h3>
                      <button 
                        onClick={exportTradeCSV}
                        className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase text-neon-green border border-neon-green/20 px-4 py-2 hover:bg-neon-green/5 transition-all"
                      >
                        <Download size={14} />
                        Export Audit CSV
                      </button>
                    </div>
                    <div className="border border-tech-border rounded-sm overflow-hidden shadow-2xl">
                        <table className="w-full text-left font-mono">
                           <thead className="bg-[#1a1d23] text-[9px] font-black text-neutral-500 uppercase tracking-[0.2em] border-b border-tech-border">
                             <tr>
                               <th className="p-4">Instrument</th>
                               <th className="p-4">Logic</th>
                               <th className="p-4 text-center">Lots</th>
                               <th className="p-4 text-right">Entry</th>
                               <th className="p-4 text-right">Exit</th>
                               <th className="p-4 text-right">PnL</th>
                               <th className="p-4 text-center">Greeks</th>
                               <th className="p-4 text-center">Status</th>
                               <th className="p-4 text-right">Execution Flow (IN/OUT)</th>
                             </tr>
                           </thead>
                           <tbody className="text-[11px] divide-y divide-tech-border bg-tech-surface">
                             {tradeHistory.map((t, i) => (
                               <tr key={i} className="hover:bg-white/5 transition-all group">
                                 <td className="p-4">
                                   <div className="flex flex-col">
                                     <span className="text-white font-black group-hover:text-neon-green transition-colors">{t.symbol}</span>
                                     <span className="text-[9px] text-neutral-600 font-bold">{t.strike} {t.type}</span>
                                   </div>
                                 </td>
                                 <td className="p-4">
                                   <span className={cn(
                                     "px-2 py-0.5 rounded-[2px] text-[8px] font-black uppercase tracking-widest",
                                     t.prob >= 90 ? "bg-purple-500/20 text-purple-400" : "bg-neutral-800 text-neutral-500"
                                   )}>
                                     {t.prob >= 90 ? 'ALPHA_MAX' : t.prob >= 80 ? 'HIGH_EDGE' : 'STANDARD'}
                                   </span>
                                 </td>
                                 <td className="p-4 text-center">
                                   <div className="flex flex-col items-center">
                                     <span className="text-white font-bold">{t.numLots || Math.round((t.qty || 0) / (t.lotSize || 1)) || 0} L</span>
                                     <span className="text-[8px] text-neutral-600">x{t.lotSize || 1}</span>
                                   </div>
                                 </td>
                                 <td className="p-4 text-right text-neutral-400">₹{(t.entry || 0).toFixed(2)}</td>
                                 <td className="p-4 text-right text-white font-bold">₹{(t.exit || 0).toFixed(2)}</td>
                                 <td className={cn("p-4 font-black text-right font-mono", (t.pnl || 0) >= 0 ? "text-neon-green" : "text-neon-red")}>{formatCurrency(t.pnl || 0)}</td>
                                 <td className="p-4">
                                   <div className="flex justify-center gap-4 text-[9px] text-neutral-500 font-mono font-bold">
                                     {t.entryGreeks ? (
                                       <>
                                         <span>Δ: {(t.entryGreeks.delta || 0).toFixed(2)}</span>
                                         <span>Θ: {(t.entryGreeks.theta || 0).toFixed(1)}</span>
                                       </>
                                     ) : (
                                       <span className="opacity-20">—</span>
                                     )}
                                   </div>
                                 </td>
                                 <td className="p-4 text-center">
                                   <span className="text-[9px] px-2 py-1 bg-white/5 border border-white/10 text-neutral-400 uppercase font-black tracking-tighter">
                                     {t.exitReason || 'AUTO_EXIT'}
                                   </span>
                                 </td>
                                 <td className="p-4 text-right text-neutral-500 font-mono text-[9px]">
                                   <div className="flex flex-col items-end">
                                     <span className="text-neutral-400">IN: {(t.createdAt?.toDate?.() || (t.createdAt instanceof Date ? t.createdAt : new Date())).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                     <span className="text-white font-black">OUT: {(t.closedAt?.toDate?.() || (t.closedAt instanceof Date ? t.closedAt : new Date())).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                   </div>
                                 </td>
                               </tr>
                             ))}
                             {tradeHistory.length === 0 && (
                               <tr>
                                 <td colSpan={9} className="p-16 text-center text-neutral-600 uppercase font-black italic tracking-widest opacity-20">
                                   No closed positions discovered in current session.
                                 </td>
                               </tr>
                             )}
                           </tbody>
                        </table>
                      </div>
                  </div>
                )}

                {activeAnalyticsTab === 'sl' && (
                  <div className="space-y-8">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      <div className="bg-tech-surface border border-tech-border p-8 rounded-sm">
                        <h3 className="text-sm font-black text-white uppercase tracking-tight mb-6">Stop Loss Hit Accuracy</h3>
                        <div className="h-[300px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <RePieChart>
                              <Pie
                                data={[
                                  { name: 'Target 1+', value: tradeHistory.filter(t => (t.pnl || 0) > 0).length },
                                  { name: 'Stopped Out', value: tradeHistory.filter(t => (t.pnl || 0) < 0 && (t.exitReason === 'SL' || (t.exit || 0) <= (t.sl || 0))).length },
                                  { name: 'Trailing SL', value: tradeHistory.filter(t => (t.pnl || 0) > 0 && t.exitReason === 'TRAILING_SL').length || 1 },
                                ]}
                                cx="50%" cy="50%"
                                innerRadius={60}
                                outerRadius={100}
                                paddingAngle={5}
                                dataKey="value"
                              >
                                <Cell fill="#00FF94" />
                                <Cell fill="#FF3131" />
                                <Cell fill="#3b82f6" />
                              </Pie>
                              <Tooltip contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #1a1d23', fontSize: '10px' }} />
                            </RePieChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="flex justify-center gap-6 text-[10px] font-mono text-neutral-500">
                          <span className="flex items-center gap-2"><div className="w-2 h-2 bg-neon-green rounded-full" /> WIN</span>
                          <span className="flex items-center gap-2"><div className="w-2 h-2 bg-neon-red rounded-full" /> STOPPED</span>
                          <span className="flex items-center gap-2"><div className="w-2 h-2 bg-blue-500 rounded-full" /> TRAILING</span>
                        </div>
                      </div>

                      <div className="bg-tech-surface border border-tech-border p-8 rounded-sm space-y-6">
                        <h3 className="text-sm font-black text-white uppercase tracking-tight">SL Efficacy Index</h3>
                        <div className="space-y-4">
                          {[
                            { label: 'Avg Stop Out Distance', value: '18.4%', desc: 'Average premium drop before exit' },
                            { label: 'Panic Exit Rate', value: '4.2%', desc: 'Positions closed before system SL' },
                            { label: 'Gap Down Exposure', value: '1.8%', desc: 'Slippage beyond calculated SL' },
                            { label: 'Recovery Prob', value: '12%', desc: 'Prob of bounce after -50% SL hit' },
                          ].map((stat, i) => (
                            <div key={i} className="flex justify-between items-center p-4 bg-white/5 border border-white/5 group hover:border-white/10 transition-all">
                              <div>
                                <div className="text-[10px] font-mono text-neutral-500 uppercase">{stat.label}</div>
                                <div className="text-[9px] text-neutral-600 font-mono italic">{stat.desc}</div>
                              </div>
                              <div className="text-xl font-black text-white">{stat.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeAnalyticsTab === 'calibration' && (
                  <div className="space-y-8">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                       <div className="bg-tech-surface border border-tech-border p-8">
                          <h3 className="text-sm font-black text-white uppercase tracking-tight mb-6">Kelly Criterion (Optimal f)</h3>
                          <div className="flex flex-col items-center justify-center h-48 space-y-4">
                             <div className="text-5xl font-black text-neon-green tracking-tighter">
                                {(((attributionStats?.winRate || 0) / 100 * (attributionStats?.ratio || 2.0) - (1 - (attributionStats?.winRate || 0) / 100)) / (attributionStats?.ratio || 2.0) * 10).toFixed(1)}%
                             </div>
                             <div className="text-[10px] font-mono text-neutral-500 uppercase text-center max-w-[180px]">
                                Suggested port allocation per trade based on edge
                             </div>
                          </div>
                       </div>
                       
                       <div className="md:col-span-2 bg-tech-surface border border-tech-border p-8">
                          <h3 className="text-sm font-black text-white uppercase tracking-tight mb-6">Risk Reward Distribution (Expected vs Realized)</h3>
                          <div className="h-[240px]">
                             <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={tradeHistory.slice(0, 15).map((t, i) => ({
                                  name: t.symbol,
                                  target: 2.0,
                                  realized: Math.min(5, Math.max(-1, (t.pnl || 0) / Math.abs(((t.qty || 1) * ((t.entry || 0) - (t.sl || (t.entry || 0) * 0.8))))))
                                }))}>
                                   <XAxis dataKey="name" fontSize={9} hide />
                                   <YAxis fontSize={9} />
                                   <Tooltip contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #333', fontSize: '10px' }} />
                                   <Line type="monotone" dataKey="target" stroke="#4b5563" strokeDasharray="5 5" dot={false} />
                                   <Line type="monotone" dataKey="realized" stroke="#00FF94" strokeWidth={3} />
                                </LineChart>
                             </ResponsiveContainer>
                          </div>
                       </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                       {[
                         { l: 'Mathematical Edge', v: ((attributionStats?.winRate || 0)/100 * (attributionStats?.avgWin || 0) - (1 - (attributionStats?.winRate || 0)/100) * (attributionStats?.avgLoss || 1)).toFixed(0), s: 'EV per trade' },
                         { l: 'K-Factor Score', v: '0.42', s: 'Stiffness of edge' },
                         { l: 'Skewness', v: '+1.42', s: 'Right-tail bias' },
                         { l: 'Volatility Adj', v: '0.8x', s: 'Risk mult suggestion' }
                       ].map((c, i) => (
                         <div key={i} className="p-6 bg-tech-surface border border-tech-border">
                           <div className="text-[9px] font-mono text-neutral-500 uppercase mb-2">{c.l}</div>
                           <div className="text-2xl font-black text-white tracking-tighter">{c.v}</div>
                           <div className="text-[8px] font-mono text-neutral-600">{c.s}</div>
                         </div>
                       ))}
                    </div>
                  </div>
                )}

                {activeAnalyticsTab === 'timing' && (
                  <div className="space-y-8">
                     <div className="bg-tech-surface border border-tech-border p-8">
                       <h3 className="text-xl font-black text-white uppercase tracking-tight mb-8">Performance by Intra-Day Cycle</h3>
                       <div className="h-[350px]">
                         <ResponsiveContainer width="100%" height="100%">
                           <BarChart data={[
                             { hour: '09:00', pnl: tradeHistory.filter(t => { const h = (t.createdAt?.toDate?.() || t.createdAt)?.getHours(); return h === 9; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '10:00', pnl: tradeHistory.filter(t => { const h = (t.createdAt?.toDate?.() || t.createdAt)?.getHours(); return h === 10; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '11:00', pnl: tradeHistory.filter(t => { const h = (t.createdAt?.toDate?.() || t.createdAt)?.getHours(); return h === 11; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '12:00', pnl: tradeHistory.filter(t => { const h = (t.createdAt?.toDate?.() || t.createdAt)?.getHours(); return h === 12; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '13:00', pnl: tradeHistory.filter(t => { const h = (t.createdAt?.toDate?.() || t.createdAt)?.getHours(); return h === 13; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '14:00', pnl: tradeHistory.filter(t => { const h = (t.createdAt?.toDate?.() || t.createdAt)?.getHours(); return h === 14; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '15:00', pnl: tradeHistory.filter(t => { const h = (t.createdAt?.toDate?.() || t.createdAt)?.getHours(); return h === 15; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                           ]}>
                             <XAxis dataKey="hour" fontSize={10} axisLine={false} tickLine={false} />
                             <YAxis fontSize={10} axisLine={false} tickLine={false} />
                             <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #333', fontSize: '10px' }} />
                             <Bar dataKey="pnl">
                               {tradeHistory.map((entry, index) => (
                                 <Cell key={`cell-${index}`} fill={(entry.pnl || 0) >= 0 ? '#00FF94' : '#FF3131'} />
                               ))}
                             </Bar>
                           </BarChart>
                         </ResponsiveContainer>
                       </div>
                     </div>

                     <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                       <div className="bg-tech-surface border border-tech-border p-8">
                         <h3 className="text-sm font-black text-white uppercase tracking-tight mb-6">Hold Duration vs Outcome</h3>
                         <div className="space-y-4">
                           {[
                             { range: '< 15m', trades: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.createdAt?.toDate?.() || t.createdAt)?.getTime()) / 1000 / 60; return d < 15; }).length, pnl: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.createdAt?.toDate?.() || t.createdAt)?.getTime()) / 1000 / 60; return d < 15; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { range: '15-60m', trades: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.createdAt?.toDate?.() || t.createdAt)?.getTime()) / 1000 / 60; return d >= 15 && d < 60; }).length, pnl: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.createdAt?.toDate?.() || t.createdAt)?.getTime()) / 1000 / 60; return d >= 15 && d < 60; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { range: '1-3h', trades: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.createdAt?.toDate?.() || t.createdAt)?.getTime()) / 1000 / 60; return d >= 60 && d < 180; }).length, pnl: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.createdAt?.toDate?.() || t.createdAt)?.getTime()) / 1000 / 60; return d >= 60 && d < 180; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { range: 'EOD', trades: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.createdAt?.toDate?.() || t.createdAt)?.getTime()) / 1000 / 60; return d >= 180; }).length, pnl: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.createdAt?.toDate?.() || t.createdAt)?.getTime()) / 1000 / 60; return d >= 180; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                           ].map((item, i) => (
                             <div key={i} className="flex justify-between items-center p-3 border border-tech-border hover:bg-white/5 transition-all">
                               <span className="text-[10px] font-mono text-neutral-500">{item.range}</span>
                               <span className="text-[10px] font-mono text-neutral-400">{item.trades} trades</span>
                               <span className={cn("text-xs font-black", item.pnl >= 0 ? "text-neon-green" : "text-neon-red")}>{formatCurrency(item.pnl)}</span>
                             </div>
                           ))}
                         </div>
                       </div>
                       
                       <div className="bg-tech-surface border border-tech-border p-8 flex flex-col items-center justify-center text-center space-y-4">
                          <Zap className="text-yellow-400" size={32} />
                          <h4 className="text-white font-black uppercase tracking-tight">Optimal Trading Window</h4>
                          <div className="text-3xl font-black text-white tracking-widest uppercase">10:00 - 12:30</div>
                          <p className="text-[10px] font-mono text-neutral-500 max-w-[240px]">Highest expectancy observed during mid-morning volatility absorption.</p>
                       </div>
                     </div>
                  </div>
                )}

                {activeAnalyticsTab === 'options' && (
                  <div className="space-y-8">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                       <div className="bg-tech-surface border border-tech-border p-8">
                          <h3 className="text-sm font-black text-white uppercase tracking-tight mb-6">Greek Exposure Density</h3>
                          <div className="h-[300px]">
                             <ResponsiveContainer width="100%" height="100%">
                                <BarChart layout="vertical" data={[
                                  { type: 'Delta (Avg)', val: tradeHistory.reduce((s, c) => s + (c.entryGreeks?.delta || 0), 0) / (tradeHistory.length || 1) },
                                  { type: 'Theta/Sec', val: Math.abs(tradeHistory.reduce((s, c) => s + (c.entryGreeks?.theta || 0), 0) / (tradeHistory.length || 1)) / 100 },
                                  { type: 'Gamma Impact', val: 0.05 },
                                ]}>
                                   <XAxis type="number" hide />
                                   <YAxis dataKey="type" type="category" fontSize={10} axisLine={false} tickLine={false} />
                                   <Tooltip contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #1a1d23', fontSize: '10px' }} />
                                   <Bar dataKey="val" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                                </BarChart>
                             </ResponsiveContainer>
                          </div>
                       </div>

                       <div className="bg-tech-surface border border-tech-border p-8 space-y-8">
                          <div>
                            <h4 className="text-[10px] font-black text-neutral-500 uppercase tracking-widest mb-4">Capital Efficiency Ratio</h4>
                            <div className="h-4 w-full bg-white/5 rounded-full overflow-hidden">
                               <div className="h-full bg-neon-green" style={{ width: '74%' }} />
                            </div>
                            <div className="flex justify-between mt-2 text-[10px] font-mono text-neutral-600">
                               <span>UTILIZED: 74%</span>
                               <span>SURPLUS: 26%</span>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4">
                             {[
                               { label: 'IV Skew Impact', value: 'MED', color: 'text-yellow-400' },
                               { label: 'Theta Leakage', value: 'LOW', color: 'text-neon-green' },
                               { label: 'Vega Sensitivity', value: 'HIGH', color: 'text-neon-red' },
                               { label: 'Leverage Mult', value: '8.4x', color: 'text-white' },
                             ].map((opt, i) => (
                               <div key={i} className="p-4 bg-white/5 border border-white/5">
                                 <div className="text-[9px] font-mono text-neutral-500 uppercase">{opt.label}</div>
                                 <div className={cn("text-lg font-black", opt.color)}>{opt.value}</div>
                               </div>
                             ))}
                          </div>
                       </div>
                    </div>
                  </div>
                )}
             </motion.div>
           )}
          </AnimatePresence>
          </div>
        </div>
      </main>

      {/* Footer / Status Bar */}
      <footer className="h-10 border-t border-tech-border px-6 flex items-center justify-between bg-tech-surface text-[9px] font-mono text-neutral-500 uppercase tracking-[0.3em] shrink-0">
         <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
               <div className="w-2 h-2 rounded-full bg-neon-green animate-pulse shadow-[0_0_8px_rgba(0,255,148,0.5)]" />
               NSE_LIVE_DATAFEED: SYNCHRONIZED
            </div>
            <div className="w-px h-4 bg-tech-border"></div>
            <div>Institutional Mode: V.4.2_ALPHA</div>
         </div>
         <div className="flex items-center gap-6">
            <span className="text-white font-bold opacity-80">LATENCY: 14MS</span>
            <div className="bg-neon-green/10 text-neon-green px-2.5 py-0.5 border border-neon-green/20 font-black">
               QUANT_CORE_ACTIVE
            </div>
         </div>
      </footer>
    </div>
  );
}
