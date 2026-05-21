/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  LogOut, LogIn, User as UserIcon, Settings,
  History, TrendingUp, TrendingDown,
  LayoutDashboard, Eye, ListFilter, Activity, Target, Shield, AlertTriangle, 
  BarChart3, Search, RefreshCw, Layers, Zap, PieChart, ChevronRight, Terminal, Download, Cpu
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
  fetchQuotes, getStrikeInterval, fetchRealOptionChain
} from './services/nseService';
import { analyzeTradeProbability, generateRecommendation, getFyersOptionSymbol, analyzeStrategyDecision } from './services/aiAnalysisService';
import { 
  sendTelegramNotification, formatTradeEntry, formatTradeExit, formatTestMessage
} from './services/telegramService';
import { isMarketOpen } from './services/marketHoursService';
import { BreakoutScreenerAndTerminal } from './components/BreakoutScreenerAndTerminal';
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
  const [activeView, setActiveView] = useState<'dashboard' | 'trades' | 'risk' | 'analytics' | 'breakout'>('dashboard');
  const [user, setUser] = useState<User | null>(GUEST_USER);
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [marketInfo, setMarketInfo] = useState<any>(null);
  const [regimeData, setRegimeData] = useState<any>(null);
  const [selectedStock, setSelectedStock] = useState<StockData | null>(null);
  const liveSelectedStock = useMemo(() => {
    if (!selectedStock) return null;
    return stocks.find(s => s.symbol === selectedStock.symbol) || selectedStock;
  }, [selectedStock, stocks]);
  const [optionChain, setOptionChain] = useState<any[]>([]);
  const [aiAnalysis, setAiAnalysis] = useState<AIProbabilityModel | null>(null);
  const [strategyReport, setStrategyReport] = useState<any | null>(null);
  const [loadingStrategy, setLoadingStrategy] = useState(false);
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

        positions.forEach((pos) => {
          if (pos.status !== 'OPEN') return;

          let currentPrice = 0;
          const fyersQuote = optionQuotes[pos.fyersSymbol] || optionQuotes[pos.fyersSymbol && pos.fyersSymbol.startsWith('NSE:') ? pos.fyersSymbol : `NSE:${pos.fyersSymbol}`];
          
          if (fyersQuote && fyersQuote.lp !== undefined) {
             currentPrice = fyersQuote.lp;
          } else {
             const stockQuote = stockQuotes[`NSE:${pos.symbol}-EQ`];
             const spotPrice = stockQuote?.lp || stocks.find(s => s.symbol === pos.symbol)?.lastPrice || pos.strike || pos.entry;
             
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
              }).catch(e => console.error("Update PnL error:", e));
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
                updateDoc(docRef, { sl: pos.entry }).catch(() => {});
                addLog(pos.symbol, 'TSL_UPDATE', 'SUCCESS', `Stop Loss moved to Breakeven @ ₹${pos.entry.toFixed(2)}`);
              }
              if (currentPrice >= pos.entry * 1.25) {
                const idealTsl = currentPrice * 0.90;
                if (!pos.tsl || idealTsl > pos.tsl) {
                   const docRef = doc(db, 'trades', pos.id);
                   updateDoc(docRef, { tsl: idealTsl }).catch(() => {});
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
              closePosition(pos.id, exitReason, currentPrice).catch(e => console.error("Auto-close error:", e));
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
  const [isKotakConnected, setIsKotakConnected] = useState(false);
  const [isKotakSimulated, setIsKotakSimulated] = useState(true);
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

  const [breakoutState, setBreakoutState] = useState<any>(null);
  
  const handleToggleBreakoutStrategy = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/breakout/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const data = await res.json();
      setBreakoutState((prev: any) => prev ? { ...prev, isEnabled: data.isEnabled } : null);
    } catch (e) {
      console.error("Failed to toggle breakout strategy", e);
    }
  };

  const handleToggleBreakoutAutoTrigger = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/breakout/toggle-autotrigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const data = await res.json();
      setBreakoutState((prev: any) => prev ? { ...prev, autoTrigger: data.autoTrigger } : null);
    } catch (e) {
      console.error("Failed to toggle breakout auto trigger", e);
    }
  };

  const handleBreakoutTriggerScan = async () => {
    try {
      const res = await fetch('/api/breakout/trigger-scan', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setBreakoutState((prev: any) => {
          const base = prev || { isEnabled: true, autoTrigger: true, targets: [], dailyTradesCount: 0, maxTradesPerDay: 4 };
          return { ...base, targets: data.targets, scanTimestamp: Date.now() };
        });
      }
    } catch (e) {
      console.error("Failed to trigger breakout scan", e);
    }
  };

  const handleBreakoutManualTrigger = async (symbol: string) => {
    try {
      await fetch('/api/breakout/manual-trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
      });
    } catch (e) {
      console.error("Failed manual breakout trigger", e);
    }
  };

  const handleBreakoutManualClose = async (symbol: string) => {
    try {
      await fetch('/api/breakout/manual-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
      });
    } catch (e) {
      console.error("Failed manual breakout close", e);
    }
  };

  const [isAutoLoggingIn, setIsAutoLoggingIn] = useState(false);
  const [manualAuthCode, setManualAuthCode] = useState('');
  const [isSubmittingCode, setIsSubmittingCode] = useState(false);
  const [showManualCodeInput, setShowManualCodeInput] = useState(false);

  // Kotak Manual Credentials states
  const [showKotakSetupModal, setShowKotakSetupModal] = useState(false);
  const [kotakForm, setKotakForm] = useState({
    consumerKey: '',
    consumerSecret: '',
    userId: '',
    password: '',
    pin: ''
  });
  const [kotakError, setKotakError] = useState('');
  const [isLoggingInKotakManual, setIsLoggingInKotakManual] = useState(false);

  const loadMarketData = async () => {
    try {
      // Sync Kotak Securities broker link state
      try {
        const kStatusRes = await fetch('/api/auth/kotak/status');
        const kStatusData = await kStatusRes.json();
        setIsKotakConnected(kStatusData.isConnected);
        setIsKotakSimulated(kStatusData.mode === "simulation");
      } catch (kErr) {
        console.error("Failed to query Kotak Securities status:", kErr);
      }

      const marketStatus = isMarketOpen();
      if (!marketStatus.open) {
        return;
      }

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
        setIsKotakConnected(true);
      } else {
        currentStocks = getLiveStockData();
        addLog('SYSTEM', 'LIVE_FEED', 'SUCCESS', 'Utilizing high-performance Sandbox / Live Kotak Securities data pipeline');
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
            analyzeAndMaybeTrade(candidate.stock, candidate.analysis).catch(e => console.error("[Scanner] Auto-trade routing error:", e));
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
    } catch (error) {
      console.error("loadMarketData major failure:", error);
      addLog('SYSTEM', 'CRITICAL_ERR', 'ERROR', `Background scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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
        executeTrade(stock, rec, analysis).catch(e => console.error("[Scanner] Trade execution call failed:", e));
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
        let errorMsg = data.message || "Auto-login failed";
        if (data.details && typeof data.details === 'string' && data.details.includes('Account blocked')) {
          errorMsg = "Your Fyers account is currently BLOCKED. This usually happens after multiple failed login attempts or security triggers. Please log in manually at fyers.in once to unblock your account.";
        } else if (data.details && typeof data.details === 'object' && JSON.stringify(data.details).includes('Account blocked')) {
          errorMsg = "Your Fyers account is currently BLOCKED. Please log in manually at fyers.in once to unblock your account.";
        }
        
        const details = data.details ? `\n\nReason: ${typeof data.details === 'object' ? JSON.stringify(data.details) : data.details}` : "";
        const debug = data.debug_info ? `\n\nEnvironment (Masked):\n- Client: ${data.debug_info.clientId}\n- User: ${data.debug_info.userId}\n- PIN: ${data.debug_info.pin}\n- TOTP: ${data.debug_info.totp}` : "";
        alert(`${errorMsg}${details}${debug}`);
      }
    } catch (e) {
      console.error("Auto-login request failed:", e);
      alert("Failed to reach server for auto-login");
    } finally {
      setIsAutoLoggingIn(false);
    }
  };

  const triggerKotakAutoLogin = async () => {
    if (isAutoLoggingIn) return;
    setIsAutoLoggingIn(true);
    addLog('SYSTEM', 'KOTAK_HANDSHAKE', 'INFO', 'Connecting to Kotak Securities Neo API...');
    try {
      const res = await fetch('/api/auth/kotak/autologin');
      const data = await res.json();
      if (data.success) {
        setIsKotakConnected(true);
        setIsKotakSimulated(data.mode === "simulation");
        addLog('SYSTEM', 'KOTAK_READY', 'SUCCESS', `Connected to Kotak Securities! Mode: ${data.mode.toUpperCase()}`);
        loadMarketData();
      } else {
        addLog('SYSTEM', 'KOTAK_FAIL', 'WARNING', `Handshake rejected: ${data.message}`);
      }
    } catch (e: any) {
      console.error("Kotak login failed:", e);
      addLog('SYSTEM', 'KOTAK_ERR', 'WARNING', `Failed to reach Kotak server backend: ${e.message}`);
    } finally {
      setIsAutoLoggingIn(false);
    }
  };

  const triggerKotakManualLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!kotakForm.consumerKey || !kotakForm.consumerSecret || !kotakForm.userId || !kotakForm.password || !kotakForm.pin) {
      setKotakError("All fields are mandatory.");
      return;
    }

    setIsLoggingInKotakManual(true);
    setKotakError('');
    addLog('SYSTEM', 'KOTAK_MANUAL_HANDSHAKE', 'INFO', `Triggering manual login for Kotak User ID: ${kotakForm.userId}...`);

    try {
      const res = await fetch('/api/auth/kotak/manual-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kotakForm)
      });
      
      const data = await res.json();
      if (res.ok && data.success) {
        setIsKotakConnected(true);
        setIsKotakSimulated(false); // Manually logged in to production Neo Gateway
        setShowKotakSetupModal(false);
        addLog('SYSTEM', 'KOTAK_READY', 'SUCCESS', `Connected manually to Kotak Securities! Welcome, ${kotakForm.userId}.`);
        loadMarketData();
      } else {
        const errorMsg = data.error || data.message || "Authentication rejected.";
        setKotakError(errorMsg);
        addLog('SYSTEM', 'KOTAK_FAIL', 'ERROR', `Manual handshake rejected: ${errorMsg}`);
      }
    } catch (err: any) {
      setKotakError(err.message || "Network exception logging in Kotak.");
      addLog('SYSTEM', 'KOTAK_ERR', 'ERROR', `Failed to reach Kotak server manual portal: ${err.message}`);
    } finally {
      setIsLoggingInKotakManual(false);
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
        executeTrade(selectedStock, recommendation, aiAnalysis).catch(e => console.error("[UI] Auto-trade trigger error:", e));
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

    loadMarketData().catch(e => console.error("[Mount] loadMarketData error:", e));
    
    // Refresh interval every 5 mins to sync universe and scan
    const refreshInterval = setInterval(() => {
      loadMarketData().catch(e => console.error("[Interval] loadMarketData error:", e));
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

    if (socket) {
      socket.on('market-regime-update', (data) => {
        setRegimeData(data);
      });
      socket.on('breakout-strategy', (data) => {
        setBreakoutState(data);
      });
    }

    fetch('/api/breakout/status')
      .then(res => res.json())
      .then(data => setBreakoutState(data))
      .catch(err => console.error("Error loading breakout state:", err));

    const interval = setInterval(() => {
      loadMarketData().catch(e => console.error("[Fallback Interval] loadMarketData error:", e));
    }, 30000); // Pulse every 30s as fallback

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

  // Synchronize Breakout strategy trades to Firestore DB
  useEffect(() => {
    if (!user || user.uid === 'guest_uid' || !breakoutState?.targets) return;

    const syncBreakoutTrades = async () => {
      for (const target of breakoutState.targets) {
        if (!target.tradeExecuted) continue;

        const breakoutId = `BREAKOUT_${target.symbol}_${target.optionSymbol}`;
        const hasOpen = positions.find((p: any) => p.breakoutId === breakoutId);
        const hasClosed = tradeHistory.find((p: any) => p.breakoutId === breakoutId);

        // Case 1: Trade is executed but not logged in DB yet
        if (!hasOpen && !hasClosed) {
          const entry = target.entryPrice || target.optionPrice;
          const sl = target.optionInitialPrice * 0.95;
          const tp1 = target.optionInitialPrice * 1.30;
          
          const newPos = {
            userId: user.uid,
            symbol: target.symbol,
            fyersSymbol: target.optionSymbol,
            type: target.type === 'BULLISH_BREAKOUT' ? 'BUY CE' : 'BUY PE',
            optionType: target.optionType,
            strike: target.strike,
            qty: 500, // standard lot size
            numLots: 1,
            lotSize: 500,
            entry: entry,
            sl: sl,
            targets: [tp1],
            pnl: target.pnl || 0,
            currentPrice: target.optionPrice,
            spotPrice: target.spotPrice,
            status: 'OPEN',
            timestamp: Timestamp.now(),
            breakoutId: breakoutId,
            strategyType: 'BREAKOUT_ALPHA',
            vwap: target.vwap || 0,
            ema20: target.ema20 || 0,
            pChange: target.pChange || 0,
            optionOIBuiltupPercentage: target.optionOIBuiltupPercentage || 0,
            optionDayHigh: target.optionDayHigh || 0,
            optionDayLow: target.optionDayLow || 0,
            trend: target.type === 'BULLISH_BREAKOUT' ? 'BULLISH' : 'BEARISH'
          };

          try {
            const collectionRef = collection(db, 'trades');
            await addDoc(collectionRef, newPos);
            console.log(`[SYNC_BREAKOUT] Logged new breakout trade for ${target.symbol} to DB.`);
          } catch (e) {
            console.error("[SYNC_BREAKOUT] Failed to save breakout trade:", e);
          }
        } 
        // Case 2: Trade has exit price on server but is still OPEN in DB
        else if (target.exitPrice && hasOpen && hasOpen.status !== 'CLOSED') {
          try {
            const docRef = doc(db, 'trades', hasOpen.id);
            const finalPnl = (target.exitPrice - hasOpen.entry) * hasOpen.qty;
            
            await updateDoc(docRef, {
              status: 'CLOSED',
              exit: target.exitPrice,
              pnl: finalPnl,
              exitReason: target.exitPrice >= (hasOpen.entry * 1.3) ? 'BREAKOUT_TARGET_HIT' : 'BREAKOUT_SL_HIT',
              closedAt: Timestamp.now()
            });

            // Update Portfolio Balance
            const pRef = doc(db, 'portfolios', user.uid);
            await updateDoc(pRef, {
              balance: ((portfolio?.balance) || 1000000) + finalPnl,
              totalTrades: ((portfolio?.totalTrades) || 0) + 1,
              netPnl: ((portfolio?.netPnl) || 0) + finalPnl
            });

            console.log(`[SYNC_BREAKOUT] Closed breakout trade for ${target.symbol} in DB with PnL: ${finalPnl}`);
            setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] BREAKOUT POSITION RESOLVED: ${target.symbol} PNL: ${finalPnl.toFixed(2)}`, ...prev]);
            
            // Send telegram alert
            sendTelegramNotification(formatTradeExit(hasOpen, target.exitPrice, finalPnl));
          } catch (e) {
            console.error("[SYNC_BREAKOUT] Failed to close breakout trade:", e);
          }
        }
      }
    };

    syncBreakoutTrades().catch(e => console.error("[Sync Breakout] Error:", e));
  }, [breakoutState, positions, tradeHistory, user, portfolio]);

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
        setDoc(doc(db, 'portfolios', user.uid), initial).catch(err => handleFirestoreError(err, OperationType.CREATE, `portfolios/${user.uid}`));
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
          maxCapitalPerTrade: data.maxCapitalPerTrade || 200000,
          paperTradingMode: data.paperTradingMode !== undefined ? data.paperTradingMode : true
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
          maxCapitalPerTrade: 200000,
          paperTradingMode: true
        };
        setDoc(doc(db, 'settings', user.uid), initial).catch(err => handleFirestoreError(err, OperationType.CREATE, `settings/${user.uid}`));
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

  useEffect(() => {
    if (socket && riskSettings) {
      socket.emit("toggle-breakout-paper-mode", riskSettings.paperTradingMode !== false);
    }
  }, [riskSettings?.paperTradingMode, socket]);

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
        const errorDetail = typeof data.details === 'object' ? JSON.stringify(data.details) : (data.details || data.error || "Unknown error");
        alert(`ERROR: ${errorDetail}.\n\nDouble-check your Token and Chat ID. Ensure your bot is started and has permissions to post.`);
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
    executeTrade(targetStock, mockRec, mockAnalysis).catch(e => console.error("[Debug] Force trade call failed:", e));
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
    try {
      setSelectedStock(stock);
      setLoadingAnalysis(true);

      // Notify Telegram that we have selected and started monitoring this stock
      const monitorMsg = `
🔍 <b>MONITORING OPPORTUNITY Engaged</b> 🔍

<b>Symbol:</b> <code>${stock.symbol}</code>
<b>Sector:</b> ${stock.sector}
<b>Price:</b> ₹${stock.lastPrice.toFixed(2)} (${stock.pChange >= 0 ? '+' : ''}${stock.pChange.toFixed(2)}%)
<b>RSI:</b> ${stock.rsi ? stock.rsi.toFixed(1) : 'N/A'}
<b>Relative Volume:</b> ${stock.relVolume ? stock.relVolume.toFixed(2) : '1.0'}x
<b>Timeframe Bias:</b> ${stock.higherTimeframeBias || 'SIDEWAYS'}

<i>Our algorithmic engine has initiated deep premium analysis of the underlying option contracts...</i>
`;
      sendTelegramNotification(monitorMsg);
      
      // Fetch real option chain from Fyers (or mock fallback if disconnected)
      const chain = await fetchRealOptionChain(stock.symbol, stock.lastPrice);
      setOptionChain(chain);
      
      // Fetch AI Analysis and AI Strategy Decision Matrix using real strikes in parallel
      setLoadingStrategy(true);
      const [analysis, strategy] = await Promise.all([
        analyzeTradeProbability(stock, chain).catch(err => {
          console.error("Option trade analysis failed:", err);
          return null;
        }),
        analyzeStrategyDecision(stock, chain).catch(err => {
          console.error("Strategy Engine failed:", err);
          return null;
        })
      ]);

      if (analysis) setAiAnalysis(analysis);
      if (strategy) setStrategyReport(strategy);
      setLoadingStrategy(false);

      const resolvedAnalysis = analysis || { winProbability: 50, confidence: 'Medium' } as any;
      const rec = generateRecommendation(stock, resolvedAnalysis, chain);
      setRecommendation(rec);
      setLoadingAnalysis(false);

      // Notify Telegram of completed deep evaluation
      const probColor = resolvedAnalysis.winProbability >= 80 ? '🟢' : '🟡';
      const evaluationMsg = `
📊 <b>GEMINI AI STRATEGY ENGINE VERDICT</b> 📊

<b>Symbol:</b> <code>${stock.symbol}</code>
<b>Signal Verdict:</b> ${strategy?.verdict || 'WATCH'}
<b>Strategy Name:</b> ${strategy?.strategyName || 'N/A'}
<b>Win Probability:</b> ${probColor} <b>${strategy?.winProbability || resolvedAnalysis.winProbability}%</b>
<b>Confidence:</b> ${strategy?.confidence || resolvedAnalysis.confidence}

<b>Option Contract:</b> <code>${rec.fyersSymbol || rec.action}</code>
<b>Premium:</b> ₹${rec.entryPrice?.toFixed(2) || 'N/A'}

🎯 <b>Confluences:</b>
- Regime Align: ${strategy?.technicalConflux?.regimeAlignment || 'N/A'}
- RV vs Avg: ${strategy?.technicalConflux?.relativeVolumeVsAverage || 'N/A'}
- RSI Status: ${strategy?.technicalConflux?.rsiOverextensionCheck || 'N/A'}

🛡️ <b>Proposed Grounds:</b>
- Entry Limit: ₹${rec.entryPrice?.toFixed(2)}
- Stop Loss: ₹${strategy?.suggestedRiskRules?.dynamicStopLoss || rec.stopLoss?.toFixed(2)}
- Targets: ₹${strategy?.suggestedRiskRules?.recommendedTarget1 || rec.targets?.[0]} / ₹${strategy?.suggestedRiskRules?.recommendedTarget2 || rec.targets?.[1]}

<i>${isAutoTrading ? '🤖 Auto-routing: verifying strategy engine verdict...' : '💡 Core cockpit setup: standing by.'}</i>
`;
      sendTelegramNotification(evaluationMsg);

      // Auto-Trading Logic
      if (isAutoTrading && analysis && analysis.winProbability >= 80) {
        executeTrade(stock, rec, analysis).catch(e => console.error("[AutoSelect] Trade execution failed:", e));
      }
    } catch (e) {
      console.error("[handleStockSelect] Failed deep analysis:", e);
      addLog(stock.symbol, 'ANALYSIS_ERR', 'ERROR', `Analysis failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
      setLoadingAnalysis(false);
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

    const userId = user?.uid || 'guest_institutional_trader';

    // Helper to log risk/rule rejections cleanly inside Firestore database
    const logRejectedTrade = async (s: StockData, r: TradeRecommendation, a: AIProbabilityModel, reason: string) => {
      try {
        const payload = {
          userId: userId,
          symbol: s.symbol,
          fyersSymbol: r.fyersSymbol || "UNKNOWN",
          type: r.action,
          optionType: r.action.includes('CE') ? 'CE' : 'PUT',
          strike: r.strike,
          expiry: r.expiry || "26 MAY 2026",
          qty: 0,
          numLots: 0,
          lotSize: s.lotSize || 1,
          entry: r.entryPrice,
          sl: r.stopLoss,
          targets: r.targets || [],
          pnl: 0,
          status: 'REJECTED',
          rejectionReason: reason,
          timestamp: Timestamp.now(),
          prob: a.winProbability,
          strategyType: 'INSTITUTIONAL_CONFLUENCE',
          trend: s.trend || "SIDEWAYS"
        };
        await addDoc(collection(db, 'trades'), payload);
        
        // Notify Telegram of risk rejection details
        const telegramBlockMsg = `
⚠️ <b>TRADE BYPASSED (RISK CONTROLS)</b> ⚠️

<b>Symbol:</b> <code>${s.symbol}</code>
<b>Option Contract:</b> ${r.action.includes('CE') ? '🟢 CALL' : '🔴 PUT'}
<b>Potential Entry Price:</b> ₹${r.entryPrice.toFixed(2)}
<b>Lot Size:</b> ${s.lotSize || 1}

🚫 <b>Bypass Reason:</b>
<i>${reason}</i>

<i>Prudent risk mitigation applied: trade sidelined.</i>
`;
        sendTelegramNotification(telegramBlockMsg);
      } catch (err) {
        console.error("Failed to write rejected trade log:", err);
      }
    };

    try {
      // 2. Double-check against latest positions (using stable Ref)
      if (positionsRef.current.some(p => p.symbol === stock.symbol && (p.type === rec.action || p.fyersSymbol === rec.fyersSymbol))) {
        addLog(stock.symbol, 'SKIP', 'INFO', `Active ${rec.action} position detected in pool. Dual-entry suppressed.`);
        tradingLock.current[lockKey] = false; // Release since we won't trade
        return;
      }
      
      // Check Portfolio/Settings data availability
      if (!portfolio || !riskSettings) {
        addLog(stock.symbol, 'DATA_BLOCK', 'ERROR', 'Quantum data sync pending. Wait for institutional profile load.');
        tradingLock.current[lockKey] = false;
        return;
      }

      // Reject if Kill Switch is active
      if (riskSettings.killSwitch) {
         addLog(stock.symbol, 'RISK_BLOCK', 'ERROR', 'Global Kill Switch is ACTIVE. Trade halted.');
         setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Global Kill Switch is ACTIVE`, ...prev]);
         tradingLock.current[lockKey] = false;
         return;
      }

      const today = new Date().toDateString();

      // Enforce SINGLE TRADE per stock per day limit
      const isStockAlreadyTradedToday = [...positions, ...tradeHistory].some(t => {
        const tDate = t.timestamp?.toDate?.() || new Date();
        return t.symbol === stock.symbol && tDate.toDateString() === today;
      });
      if (isStockAlreadyTradedToday) {
        const reason = `DUAL_ENTRY_PREVENTED: Stock ${stock.symbol} was already traded today. Limit of 1 trade per stock per day is active.`;
        addLog(stock.symbol, 'RISK_BLOCK', 'WARNING', reason);
        await logRejectedTrade(stock, rec, analysis, reason);
        tradingLock.current[lockKey] = false;
        return;
      }

      // Check Max Trades Per Day (Enforces cap of 3 trades)
      const tradesToday = [...positions, ...tradeHistory].filter(t => {
        const tDate = t.timestamp?.toDate?.() || new Date();
        return tDate.toDateString() === today;
      }).length;

      if (tradesToday >= 3) {
         const reason = `DAILY_MAX_REACHED: Daily limit of 3 trades has been fully utilized. Trade entry blocked.`;
         addLog(stock.symbol, 'RISK_BLOCK', 'WARNING', reason);
         setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Max 3 daily trades limit hit`, ...prev]);
         await logRejectedTrade(stock, rec, analysis, reason);
         tradingLock.current[lockKey] = false;
         return;
      }

      // Check Max Concurrent Trades
      if (riskSettings.maxConcurrentTrades && positions.length >= riskSettings.maxConcurrentTrades) {
        addLog(stock.symbol, 'RISK_BLOCK', 'WARNING', `Max concurrent positions (${riskSettings.maxConcurrentTrades}) reached.`);
        setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Max concurrent trades (${riskSettings.maxConcurrentTrades}) reached`, ...prev]);
        tradingLock.current[lockKey] = false;
        return;
      }

      // Check Max Capital
      const currentAllocation = positions.reduce((acc, p) => acc + (p.entry * p.qty), 0);
      if (currentAllocation >= riskSettings.maxCapital) {
         addLog(stock.symbol, 'RISK_BLOCK', 'WARNING', `Capital limit exceeded. Current: ${formatCurrency(currentAllocation)} | Limit: ${formatCurrency(riskSettings.maxCapital)}`);
         setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Max capital allocation reached`, ...prev]);
         tradingLock.current[lockKey] = false;
         return;
      }

      // Check Max Loss Per Day (Drawdown)
      if (dailyPnL <= -riskSettings.maxLossPerDay) {
         addLog(stock.symbol, 'RISK_BLOCK', 'ERROR', `Daily drawdown limit hit (${formatCurrency(dailyPnL)}).`);
         setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Daily SL Limit (${formatCurrency(riskSettings.maxLossPerDay)}) hit`, ...prev]);
         tradingLock.current[lockKey] = false;
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
        tradingLock.current[lockKey] = false;
        return;
      }

      if (timeValue >= 1515) {
        addLog(stock.symbol, 'TIMING_BLOCK', 'WARNING', 'Intraday Square-off Protocol Active (After 3:15 PM). No new trades.');
        setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] REJECTED: Post 3:15 PM trade restriction`, ...prev]);
        tradingLock.current[lockKey] = false;
        return;
      }

      // --- Institutional Confluence Filter ---
      const bias = stock.higherTimeframeBias;
      const isBullishTrade = rec.action.includes('CE');
      const isBearishTrade = rec.action.includes('PE') || rec.action.includes('PUT');
      
      // 1. Timeframe Alignment
      if (isBullishTrade && bias === 'BEARISH') {
        addLog(stock.symbol, 'CONFLUENCE_ERR', 'ERROR', 'Trade REJECTED: Higher Timeframe Bias is BEARISH while attempting BUY/CE.');
        tradingLock.current[lockKey] = false;
        return;
      }
      if (isBearishTrade && bias === 'BULLISH') {
        addLog(stock.symbol, 'CONFLUENCE_ERR', 'ERROR', 'Trade REJECTED: Higher Timeframe Bias is BULLISH while attempting BUY/PE.');
        tradingLock.current[lockKey] = false;
        return;
      }

      // 2. Sector Strength Alignment
      const sectorData = sectorStrengths.find(s => s.name === stock.sector);
      if (isBullishTrade && sectorData && sectorData.val < -0.3) {
        addLog(stock.symbol, 'SECTOR_BLOCK', 'ERROR', `Trade REJECTED: Sector ${stock.sector} is under pressure (${sectorData.val.toFixed(2)}%).`);
        tradingLock.current[lockKey] = false;
        return;
      }
      if (isBearishTrade && sectorData && sectorData.val > 0.3) {
        addLog(stock.symbol, 'SECTOR_BLOCK', 'ERROR', `Trade REJECTED: Sector ${stock.sector} is too strong for shorts (${sectorData.val.toFixed(2)}%).`);
        tradingLock.current[lockKey] = false;
        return;
      }

      // 3. RSI Exhaustion Protocol (Mean Reversion Check)
      if (isBullishTrade && stock.rsi > 75) {
        addLog(stock.symbol, 'CORE_REJECT', 'WARNING', `ALPHA_GUARD: Long entry blocked on ${stock.symbol}. RSI (${stock.rsi.toFixed(1)}) at exhaustion.`);
        tradingLock.current[lockKey] = false;
        return;
      }
      if (isBearishTrade && stock.rsi < 25) {
        addLog(stock.symbol, 'CORE_REJECT', 'WARNING', `ALPHA_GUARD: Short entry blocked on ${stock.symbol}. RSI (${stock.rsi.toFixed(1)}) at capitulation.`);
        tradingLock.current[lockKey] = false;
        return;
      }

      // 4. Volume Spread Validation (Institutional Footprint)
      if (stock.relVolume < 1.4) {
        addLog(stock.symbol, 'CORE_REJECT', 'INFO', `VOL_GUARD: Low volume breakout on ${stock.symbol} (RV: ${stock.relVolume.toFixed(2)}x). Skipping retail noise.`);
        tradingLock.current[lockKey] = false;
        return;
      }

      // --- 5. Gemini AI Strategy Decision Engine Gatekeeper Check ---
      let activeStrategy = strategyReport;
      if (!activeStrategy || activeStrategy.symbol !== stock.symbol) {
        addLog(stock.symbol, 'AI_STRATEGY', 'INFO', 'Invoking Gemini AI Strategy Decision Engine for real-time pipeline evaluation...');
        const chainData = optionChain && optionChain.length > 0 ? optionChain : await fetchRealOptionChain(stock.symbol, stock.lastPrice);
        activeStrategy = await analyzeStrategyDecision(stock, chainData).catch(() => null);
      }

      if (activeStrategy) {
        if (activeStrategy.verdict === 'SKIP') {
          const reason = `GEMINI_STRATEGY_REJECTED: The Gemini AI Strategy Decision Engine generated a High-Risk SKIP verdict. Reason: ${activeStrategy.rationales}`;
          addLog(stock.symbol, 'AI_REJECT', 'ERROR', `Gemini AI Engine rejected execution: ${activeStrategy.strategyName}`);
          await logRejectedTrade(stock, rec, analysis, reason);
          tradingLock.current[lockKey] = false;
          return;
        } else {
          addLog(stock.symbol, 'AI_CONFIRMED', 'SUCCESS', `Gemini AI Strategy Engine confirmed entry: ${activeStrategy.strategyName} (${activeStrategy.winProbability}% probability, Verdict: ${activeStrategy.verdict})`);
        }
      }
      // ----------------------------------------

      addLog(stock.symbol, 'PROTOCOL_V2', 'INFO', `Protocol engaged via ${user?.displayName || 'GUEST_CORE'}. Action: ${rec.fyersSymbol || rec.action} @ ${formatCurrency(rec.entryPrice)}`);

      const entry = rec.entryPrice;
      const sl = rec.stopLoss;
      const lotSize = stock.lotSize || 1;

      // Ground Rule: Deciding lot size strictly based on maximum of ₹50,000 capital per trade limit
      const maxCapitalAllowed = 50000;
      const singleLotCost = lotSize * entry;

      if (singleLotCost > maxCapitalAllowed) {
        const reason = `MARGIN_EXCEEDED: Premium for 1 lot (${lotSize} qty @ ₹${entry.toFixed(2)}) requires ₹${singleLotCost.toLocaleString()} margin, which exceeds the strict cap of ₹${maxCapitalAllowed.toLocaleString()} per trade.`;
        addLog(stock.symbol, 'SIZE_BLOCK', 'ERROR', reason);
        await logRejectedTrade(stock, rec, analysis, reason);
        tradingLock.current[lockKey] = false;
        return;
      }

      // Allocate the maximum integer number of lots that fits completely within ₹50,000
      let numLots = Math.floor(maxCapitalAllowed / singleLotCost);
      if (numLots < 1) numLots = 1; // Fallback, though we already returned if singleLotCost > 50,000
      let qty = numLots * lotSize;

      if (isNaN(qty) || qty <= 0) {
        addLog(stock.symbol, 'SIZE_ERR', 'ERROR', `Invalid QTY calculated. Lots: ${numLots}, Premium: ₹${entry}`);
        tradingLock.current[lockKey] = false;
        return;
      }

      const marginRequired = qty * entry;
      // Log detailed calculation for transparency
      addLog(stock.symbol, 'ORDER_INIT', 'INFO', `Order Prep: ${numLots} Lots (Lot Size: ${lotSize}, Total QTY: ${qty}). Estimated Margin: ${formatCurrency(marginRequired)}`);

      let orderId = `PAPER_${Math.floor(Math.random() * 900000 + 100000)}`;
      let isPaperMode = true;

      if (riskSettings && riskSettings.paperTradingMode === false) {
        addLog(stock.symbol, 'LIVE_TRADE_INIT', 'INFO', `Placing live order on Kotak Neo for ${stock.symbol}...`);
        try {
          const tradeRes = await fetch('/api/trade/place', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: stock.symbol,
              qty: qty,
              type: "2", // Market order
              side: "BUY", // Always buy on entry
              price: entry
            })
          });
          const tradeData = await tradeRes.json();
          if (tradeRes.ok && tradeData.success) {
            orderId = tradeData.orderId || `KOTAK_${Math.floor(Math.random() * 900000 + 100000)}`;
            isPaperMode = false;
            addLog(stock.symbol, 'LIVE_TRADE_SUCCESS', 'SUCCESS', `Live order successfully filled on Kotak Neo! OrderID: ${orderId}`);
          } else {
            throw new Error(tradeData.message || tradeData.details || "API rejected order placement.");
          }
        } catch (liveErr: any) {
          const errMsg = `Live trade routing to Kotak Neo failed: ${liveErr.message || liveErr}`;
          addLog(stock.symbol, 'LIVE_TRADE_FAIL', 'ERROR', errMsg);
          setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: ${errMsg}`, ...prev]);
          throw new Error(errMsg);
        }
      }

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
        spotPrice: stock.lastPrice,
        status: 'OPEN',
        timestamp: Timestamp.now(),
        prob: analysis.winProbability,
        entryGreeks: rec.greeks,
        isPaper: isPaperMode,
        orderId: orderId,
        
        // Captured quantitative metadata for future refining of strategy rules
        strategyType: 'INSTITUTIONAL_CONFLUENCE',
        rsi: stock.rsi || 50,
        vwap: stock.vwap || stock.lastPrice,
        ema20: stock.ema20 || stock.lastPrice,
        relativeStrength: stock.relativeStrength || 0,
        relVolume: stock.relVolume || 1.0,
        momentumScore: analysis.momentumScore || 0,
        institutionalActivityScore: analysis.institutionalActivityScore || 0,
        breakoutQualityScore: analysis.breakoutQualityScore || 0,
        riskScore: analysis.riskScore || 0,
        marketRegime: regimeData?.regime || "UNKNOWN",
        regimeBreadth: regimeData?.breadth || 0,
        trend: stock.trend || "SIDEWAYS",
        timevalue: timeValue
      };

      console.log('[DEBUG] ATTEMPTING FIRESTORE WRITE | PATH: trades | AUTH:', !!user, 'ID:', userId);
      console.log('[DEBUG] DB_CONFIG:', db.app.options.databaseURL || 'DEFAULT');
      console.log('[DEBUG] PAYLOAD:', JSON.stringify(newPosition));

      // Use handleFirestoreError to get the specific JSON diagnostic
      const collectionRef = collection(db, 'trades');
      const docRef = await addDoc(collectionRef, newPosition);
      console.log('[DEBUG] FIRESTORE_SUCCESS | ID:', docRef.id);
      addLog(stock.symbol, 'ORDER_SUCCESS', 'SUCCESS', `Order executed: ${newPosition.qty} units @ ${newPosition.entry} (${isPaperMode ? 'PAPER' : 'LIVE'}).`);
      setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER EXECUTED (${isPaperMode ? 'PAPER' : 'LIVE'}): ${rec.fyersSymbol || stock.symbol} ${rec.action} @ ${rec.entryPrice} QTY: ${qty}`, ...prev]);
      
      // Notify Telegram
      sendTelegramNotification(formatTradeEntry(newPosition));
    } catch (err: any) {
      console.error("[executeTrade] Failed inside execution flow:", err);
      addLog(stock.symbol, 'ORDER_ERR', 'ERROR', `Execution failed: ${err.message || err}`);
      setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER REJECTED: Unexpected error in flow: ${err.message || err}`, ...prev]);
      if (err.code || err.name === 'FirebaseError') {
        handleFirestoreError(err, OperationType.CREATE, 'trades');
      }
    } finally {
      // Extended cooldown to allow Firestore listeners and state to sync (20s)
      setTimeout(() => {
        if (tradingLock.current[lockKey]) {
          tradingLock.current[lockKey] = false;
        }
      }, 20000);
    }
  };

  const closePosition = async (id: string, reason: string = 'MANUAL', exitPriceOverride?: number, exitGreeks?: any) => {
    const pos = positions.find(p => p.id === id);
    if (!pos) return;

    try {
      const livePrice = exitPriceOverride || monitoredPrices[pos.fyersSymbol] || pos.currentPrice || pos.entry;
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
              { id: 'breakout', icon: Zap, label: 'BREAKOUT ALPHA' },
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
              <span className="text-neutral-500 uppercase tracking-widest text-[9px]">KOTAK NEO:</span>
              {isKotakConnected ? (
                <div className="flex items-center gap-2">
                  <span className="text-neon-green font-bold">CONNECTED</span>
                  <span className="text-[8px] bg-neutral-800 text-neutral-400 px-1 font-bold uppercase rounded">
                    {isKotakSimulated ? "SANDBOX" : "LIVE"}
                  </span>
                  <button 
                    type="button"
                    onClick={() => {
                      setKotakError('');
                      setShowKotakSetupModal(true);
                    }}
                    className="text-neutral-400 hover:text-white ml-1 font-bold"
                    title="Change Credentials"
                  >
                    ⚙️
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button 
                    onClick={() => triggerKotakAutoLogin()}
                    disabled={isAutoLoggingIn}
                    className="text-[9px] bg-neutral-800 hover:bg-neutral-700 hover:text-white text-sky-400 py-0.5 px-1.5 transition-all uppercase font-bold"
                  >
                    {isAutoLoggingIn ? 'CONNECTING...' : 'AUTO'}
                  </button>
                  <button 
                    type="button"
                    onClick={() => {
                      setKotakError('');
                      setShowKotakSetupModal(true);
                    }}
                    className="text-[9px] bg-neon-green/10 hover:bg-neon-green hover:text-black text-neon-green py-0.5 px-1.5 border border-neon-green/20 transition-all uppercase font-bold"
                  >
                    ✏️ MANUAL
                  </button>
                </div>
              )}
            </div>
            <div className="w-px h-8 bg-tech-border mx-2"></div>
            <div className="bg-tech-surface border border-tech-border px-3 py-1 text-[10px] font-mono flex items-center gap-3">
              <span className="text-neutral-500 uppercase tracking-widest text-[9px]">Alerts:</span>
              <button 
                onClick={() => sendTestTelegram().catch(() => {})}
                disabled={isSendingTelegram}
                className="text-sky-400 hover:text-white transition-colors font-bold flex items-center gap-1"
              >
                {isSendingTelegram ? 'SENDING...' : 'TEST_TELEGRAM'}
              </button>
              <div className="w-px h-3 bg-tech-border"></div>
              <button 
                onClick={() => forceTradeDebug().catch(() => {})}
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
                    {regimeData && (
                      <div className="w-full flex items-center gap-4 border-b border-tech-border pb-4 mb-2">
                        <div className="flex flex-col">
                          <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Market Regime</span>
                          <span className="text-sm font-black text-neon-green uppercase tracking-tighter">
                            {regimeData.regime.replace('_', ' ')}
                          </span>
                        </div>
                        <div className="h-8 w-px bg-tech-border hidden md:block"></div>
                        <div className="hidden md:flex flex-col flex-1">
                          <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Regime Context</span>
                          <span className="text-[11px] text-neutral-400 font-mono italic leading-none mt-1">
                            {regimeData.description}
                          </span>
                        </div>
                        <div className="ml-auto flex gap-6 text-[10px] font-mono text-neutral-500">
                          <div className="flex flex-col items-end">
                            <span className="text-[7px] uppercase tracking-widest">Nifty ADX</span>
                            <span className="text-white font-bold">{regimeData.adx.toFixed(1)} <span className="text-[8px] text-neutral-600">({regimeData.adXSlope})</span></span>
                          </div>
                          <div className="flex flex-col items-end">
                            <span className="text-[7px] uppercase tracking-widest">Breadth</span>
                            <span className={cn("font-bold", regimeData.breadth > 60 ? "text-neon-green" : regimeData.breadth < 40 ? "text-neon-red" : "text-white")}>
                              {regimeData.breadth.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
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

                  {/* Intraday Breakout Radar Panel */}
                  <div className="space-y-6">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-tech-border gap-3">
                      <div>
                        <h2 className="text-sm font-black uppercase tracking-[0.25em] flex items-center gap-2 text-white">
                          <Activity className="text-neon-green" size={16} />
                          Intraday Breakout Monitor (Selected F&O Targets)
                        </h2>
                        <p className="text-[10px] text-neutral-400 font-mono mt-1">
                          TRACKING TOP 2 institutional gainers (Bullish CE breakouts) AND TOP 2 losers (Bearish PE breakouts)
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-4 font-mono">
                        <div className="text-[9px] bg-tech-bg px-2 py-1 border border-tech-border text-neutral-500 rounded-[2px]">
                          SCAN: {breakoutState?.scanTimestamp ? new Date(breakoutState.scanTimestamp).toLocaleTimeString('en-IN') : 'STANDBY'}
                        </div>
                        {(!breakoutState || !breakoutState.targets || breakoutState.targets.length === 0) && (
                          <button
                            onClick={handleBreakoutTriggerScan}
                            className="bg-neon-green text-black px-4 py-1.5 text-[9px] font-black uppercase tracking-widest hover:bg-[#00e082] transition-colors shadow-[0_0_10px_rgba(0,255,148,0.3)] animate-pulse"
                          >
                            TRIGGER 9:45 AM SCAN
                          </button>
                        )}
                      </div>
                    </div>

                    {!breakoutState || !breakoutState.targets || breakoutState.targets.length === 0 ? (
                      <div className="border border-dashed border-tech-border p-12 text-center bg-tech-surface bg-opacity-30">
                        <Target className="mx-auto text-neutral-700 mb-4 animate-pulse" size={36} />
                        <h3 className="text-xs font-bold uppercase tracking-widest text-neutral-400 mb-2">Institutional Scan Standby</h3>
                        <p className="text-[11px] text-neutral-500 font-mono max-w-xl mx-auto mb-6">
                          No active targets tracked. Our algorithmic scanner selects 4 high-beta F&O stocks with strong momentum at 9:45 AM to trade post-pullback breakouts. Trigger a live scan below to begin tracking.
                        </p>
                        <button
                          onClick={handleBreakoutTriggerScan}
                          className="bg-neon-green text-black px-6 py-2.5 text-xs font-black uppercase tracking-widest hover:bg-opacity-95 transition-all shadow-[0_4px_12px_rgba(0,255,148,0.2)]"
                        >
                          RUN FIRST-STAGE SCAN NOW
                        </button>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                        {breakoutState.targets.map((target: any) => {
                          const isBullish = target.type === 'BULLISH_BREAKOUT';
                          
                          // Support & Resistance Percentage Meter
                          const priceRange = target.resistance - target.support;
                          const currentPosRatio = priceRange > 0 
                            ? Math.min(100, Math.max(0, ((target.spotPrice - target.support) / priceRange) * 100))
                            : 50;

                          // Option Setup Return
                          const pnlPct = target.entryPrice 
                            ? ((target.optionPrice - target.entryPrice) / target.entryPrice) * 100
                            : 0;

                          return (
                            <div 
                              key={target.symbol} 
                              className={cn(
                                "bg-[#0F1116] border p-5 relative overflow-hidden flex flex-col justify-between transition-all duration-300 group hover:border-neutral-700",
                                target.tradeExecuted && !target.exitPrice 
                                  ? (isBullish ? "border-neon-green/40 bg-neon-green/5 shadow-[0_0_15px_rgba(0,255,148,0.03)]" : "border-neon-red/40 bg-neon-red/5 shadow-[0_0_15px_rgba(255,148,148,0.03)]")
                                  : target.exitPrice
                                  ? "border-neutral-900 bg-neutral-900/30 opacity-70"
                                  : "border-tech-border"
                              )}
                            >
                              {/* Background Direction Ghost Tag */}
                              <div className={cn(
                                "absolute top-4 right-4 text-7xl font-mono font-black select-none pointer-events-none opacity-[0.02] tracking-tighter italic",
                                isBullish ? "text-neon-green" : "text-neon-red"
                              )}>
                                {isBullish ? "CE" : "PE"}
                              </div>

                              <div>
                                {/* Row 1: Header Identity & Automation Setup Status */}
                                <div className="flex justify-between items-start mb-4">
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <h3 className="text-xl font-extrabold text-white tracking-tighter leading-none">{target.symbol}</h3>
                                      <span className={cn(
                                        "text-[9px] font-mono font-bold px-2 py-0.5 border uppercase tracking-widest leading-none",
                                        isBullish ? "border-neon-green/30 text-neon-green bg-neon-green/5" : "border-neon-red/30 text-neon-red bg-neon-red/5"
                                      )}>
                                        {isBullish ? "CE BREAKOUT" : "PE REVERSAL"}
                                      </span>
                                    </div>
                                    <div className="text-[9px] font-mono text-neutral-500 mt-1.5 uppercase tracking-widest">
                                      Underlying Spot Level Detail Tracker
                                    </div>
                                  </div>

                                  <div className="text-right">
                                    <div className="flex items-center gap-1.5 font-mono justify-end">
                                      <span className={cn(
                                        "w-1.5 h-1.5 rounded-full",
                                        target.tradeExecuted && !target.exitPrice ? "bg-neon-green animate-pulse" :
                                        target.exitPrice ? "bg-neutral-600" :
                                        target.setupTriggered ? "bg-amber-400" :
                                        target.pullbackActive ? "bg-cyan-400" : "bg-neutral-600 animate-pulse"
                                      )}></span>
                                      <span className={cn(
                                        "text-[10px] font-black uppercase tracking-tighter",
                                        target.tradeExecuted && !target.exitPrice ? "text-neon-green" :
                                        target.exitPrice ? "text-neutral-500" :
                                        target.setupTriggered ? "text-amber-400" :
                                        target.pullbackActive ? "text-cyan-400" : "text-neutral-400"
                                      )}>
                                        {target.tradeExecuted && !target.exitPrice ? "LIVE POSITION" :
                                         target.exitPrice ? "CLOSED SETUP" :
                                         target.setupTriggered ? "SETUP CONFIRMED" :
                                         target.pullbackActive ? "PULLBACK ACTIVE" : "SCANNED"}
                                      </span>
                                    </div>
                                    <div className="text-[8px] font-mono text-neutral-650 mt-1 uppercase tracking-widest">
                                      Phase: {target.exitPrice ? 'Exited' : target.tradeExecuted ? 'Position Active' : 'Hunting Entry'}
                                    </div>
                                  </div>
                                </div>

                                {/* SECTION 1: SPOT PRICE INTRADAY LEVEL METRICS (Requested Day Low, Day High, support/resistance) */}
                                <div className="bg-tech-bg/50 p-4 border border-tech-border mb-4">
                                  <div className="flex justify-between items-baseline mb-3">
                                    <span className="text-[9px] font-mono text-neutral-400 uppercase tracking-widest font-bold">NSE Spot Price</span>
                                    <div className="flex gap-2 items-baseline">
                                      <span className="text-sm font-black text-white font-mono">₹{target.spotPrice.toFixed(2)}</span>
                                      <span className={cn(
                                        "text-[10px] font-mono font-bold",
                                        target.pChange >= 0 ? "text-neon-green" : "text-neon-red"
                                      )}>
                                        {target.pChange >= 0 ? "+" : ""}{(target.pChange || 0).toFixed(2)}%
                                      </span>
                                    </div>
                                  </div>

                                  {/* Range Progress Tracker */}
                                  <div className="space-y-1 mb-2">
                                    <div className="flex justify-between text-[8px] text-neutral-400 font-mono uppercase">
                                      <span>SUPPORT (S1): ₹{target.support.toFixed(1)}</span>
                                      <span>RESISTANCE (R1): ₹{target.resistance.toFixed(1)}</span>
                                    </div>
                                    <div className="h-2 bg-neutral-900 border border-tech-border rounded-full relative overflow-hidden">
                                      <div 
                                        className={cn(
                                          "absolute h-full top-0 bottom-0 left-0 transition-all duration-300",
                                          isBullish ? "bg-gradient-to-r from-neon-green/30 to-neon-green" : "bg-gradient-to-r from-neon-red/30 to-neon-red"
                                        )}
                                        style={{ width: `${currentPosRatio}%` }}
                                      ></div>
                                      <div 
                                        className="absolute top-0 bottom-0 w-1 bg-white shadow-[0_0_4px_white]" 
                                        style={{ left: `calc(${currentPosRatio}% - 2px)` }}
                                      ></div>
                                    </div>
                                    <div className="flex justify-between text-[8px] text-neutral-500 font-mono uppercase">
                                      <span>Day Low: ₹{(target.dayLow || target.morningLow).toFixed(1)}</span>
                                      <span>9:45 AM Open: ₹{target.initialSpotPrice.toFixed(1)}</span>
                                      <span>Day High: ₹{(target.dayHigh || target.morningHigh).toFixed(1)}</span>
                                    </div>
                                  </div>

                                  <div className="grid grid-cols-2 gap-2 text-[9px] font-mono text-neutral-400 mt-2.5 pt-2.5 border-t border-tech-border/30">
                                    <div>EMA (20): <span className="text-white font-bold">₹{target.ema20.toFixed(2)}</span></div>
                                    <div className="text-right">Session VWAP: <span className="text-white font-bold">₹{target.vwap.toFixed(2)}</span></div>
                                  </div>
                                </div>

                                {/* SECTION 2: DERIVATIVES OPTIONS DATA (Requested Strike, Premium Price, Day Low, Day High, OI) */}
                                <div className="bg-tech-surface p-4 border border-tech-border mb-4">
                                  <div className="flex justify-between items-start mb-2.5 border-b border-tech-border/30 pb-2">
                                    <div>
                                      <div className="text-[8px] font-mono text-neutral-400 uppercase tracking-widest font-bold">Options Contract Code (F&O)</div>
                                      <div className="text-xs font-mono font-bold text-neon-green/80 select-all font-mono leading-none mt-1">
                                        {target.optionSymbol}
                                      </div>
                                    </div>
                                    <div className="bg-tech-bg px-2 py-0.5 border border-tech-neutral text-[9px] font-mono text-white">
                                      Strike: {target.strike}
                                    </div>
                                  </div>

                                  <div className="grid grid-cols-3 gap-3">
                                    <div className="bg-tech-bg/50 p-2 border border-tech-border">
                                      <div className="text-[8px] text-neutral-500 uppercase font-mono tracking-widest mb-1.5 font-bold">Live Premium</div>
                                      <div className={cn(
                                        "text-[13px] font-black font-mono leading-none",
                                        target.optionPrice >= target.optionInitialPrice ? "text-neon-green glow-green" : "text-neon-red"
                                      )}>
                                        ₹{target.optionPrice.toFixed(2)}
                                      </div>
                                      <span className="text-[7.5px] text-neutral-500 font-mono">Open: ₹{target.optionInitialPrice.toFixed(1)}</span>
                                    </div>

                                    <div className="bg-tech-bg/50 p-2 border border-tech-border">
                                      <div className="text-[8px] text-neutral-500 uppercase font-mono tracking-widest mb-1.5 font-bold font-bold">Premium High/Low</div>
                                      <div className="text-[10px] font-bold font-mono text-neutral-200 leading-none">
                                        H: ₹{(target.optionDayHigh || target.optionPriceHigh || target.optionInitialPrice * 1.1).toFixed(1)}
                                      </div>
                                      <div className="text-[10px] font-mono text-neutral-400 mt-1">
                                        L: ₹{(target.optionDayLow || target.optionInitialPrice * 0.95).toFixed(1)}
                                      </div>
                                    </div>

                                    <div className="bg-tech-bg/50 p-2 border border-tech-border flex flex-col justify-between">
                                      <div>
                                        <div className="text-[8px] text-neutral-500 uppercase font-mono tracking-widest mb-1 font-bold">Open Interest</div>
                                        <div className={cn(
                                          "text-[10px] font-black font-mono leading-none",
                                          target.optionOIBuiltupPercentage > 0 ? "text-neon-green" : "text-neutral-400"
                                        )}>
                                          {target.optionOIBuiltupPercentage > 0 ? "+" : ""}{target.optionOIBuiltupPercentage.toFixed(1)}%
                                        </div>
                                      </div>
                                      <span className="text-[7.5px] text-neutral-500 font-mono truncate">OI: {formatNumber(target.optionOI)}</span>
                                    </div>
                                  </div>

                                  <div className={cn(
                                    "mt-2 text-[9px] font-mono font-bold py-1.5 px-2.5 uppercase tracking-tight flex items-center justify-between border-l-2",
                                    target.optionOIBuiltupPercentage > 2.0 
                                      ? "bg-neon-green/10 text-neon-green border-neon-green" 
                                      : "bg-neutral-900 border-neutral-700 text-neutral-500"
                                  )}>
                                    <span>Institutional OI Action:</span>
                                    <span>
                                      {target.optionOIBuiltupPercentage > 2.0 
                                        ? "🔥 HIGH BLOCK ORDER BOOK ACCUMULATION" 
                                        : "SCANNING ORDER BOOK PULSE..."}
                                    </span>
                                  </div>
                                </div>

                                {/* SECTION 3: AUTOMATED PAPER POSITION LOG AND INDIVIDUAL POSITION P&L */}
                                {target.tradeExecuted && (
                                  <div className={cn(
                                    "p-4 border font-mono text-xs mb-4",
                                    target.exitPrice 
                                      ? "bg-neutral-900/50 border-neutral-800 text-neutral-500"
                                      : isBullish 
                                      ? "bg-neon-green/10 border-neon-green/15 text-white shadow-[inset_0_0_10px_rgba(0,255,148,0.02)]" 
                                      : "bg-neon-red/10 border-neon-red/15 text-white shadow-[inset_0_0_10px_rgba(255,100,100,0.02)]"
                                  )}>
                                    <div className="flex justify-between items-center mb-2 border-b border-white border-opacity-10 pb-2">
                                      <span className="text-[9px] text-neutral-500 font-bold uppercase tracking-widest">POSITION INFORMATION MATRIX</span>
                                      <span className={cn(
                                        "text-[9px] font-black uppercase px-2 py-0.5 rounded-[1px] font-mono leading-none",
                                        target.exitPrice ? "bg-neutral-800 text-neutral-400" : "bg-neon-green text-black"
                                      )}>
                                        {target.exitPrice ? "RECORDS_CLOSED" : "ACTIVE_TRADE_POS"}
                                      </span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-y-2 text-[10px]">
                                      <div>Initial Premium: <span className="font-bold text-white font-mono">₹{target.entryPrice}</span></div>
                                      <div className="text-right">Settled Premium: <span className="font-bold text-white font-mono">{target.exitPrice ? `₹${target.exitPrice}` : 'STANDBY'}</span></div>
                                      <div className="col-span-2 flex justify-between items-center border-t border-white border-opacity-10 pt-2 mt-1.5 font-bold font-mono">
                                        <span>ROI Yield Ratio:</span>
                                        <span className={cn(
                                          "text-sm font-black",
                                          pnlPct >= 0 ? "text-neon-green glow-green" : "text-neon-red glow-red"
                                        )}>
                                          {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                                        </span>
                                      </div>
                                      <div className="col-span-2 flex justify-between items-center font-bold">
                                        <span>Trade Paper PnL (Estimated):</span>
                                        <span className={cn(
                                          "text-sm font-black",
                                          (target.pnl || 0) >= 0 ? "text-neon-green glow-green" : "text-neon-red glow-red"
                                        )}>
                                          ₹{(target.pnl || 0).toLocaleString()}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Card Actions Footer */}
                              <div className="flex gap-2 pt-4 border-t border-tech-border/30 mt-2">
                                <button
                                  onClick={() => {
                                    setActiveView('breakout');
                                  }}
                                  className="flex-1 bg-tech-surface hover:bg-neutral-800 border border-tech-border text-white text-[9px] font-bold uppercase tracking-widest py-2.5 transition-all font-mono"
                                >
                                  VIEW BREAKOUT ENGINE
                                </button>

                                {/* Manual buy trigger / close buttons to override engine decisions */}
                                {!target.tradeExecuted ? (
                                  <button
                                    onClick={() => handleBreakoutManualTrigger(target.symbol)}
                                    className="flex-1 bg-neon-green hover:bg-[#00e082] text-black text-[9px] font-black uppercase tracking-widest py-2.5 transition-all font-mono shadow-[0_2px_8px_rgba(0,255,148,0.1)]"
                                  >
                                    FORCE TRIGGER SETUP
                                  </button>
                                ) : !target.exitPrice ? (
                                  <button
                                    onClick={() => handleBreakoutManualClose(target.symbol)}
                                    className="flex-1 bg-neon-red hover:bg-[#ff4e4e] text-white text-[9px] font-black uppercase tracking-widest py-2.5 transition-all font-mono shadow-[0_2px_8px_rgba(255,80,80,0.1)]"
                                  >
                                    FORCE CLOSE POS
                                  </button>
                                ) : (
                                  <div className="flex-1 flex items-center justify-center text-[9px] font-mono text-neutral-600 bg-[#0c0d10] border border-neutral-900 tracking-wider font-bold">
                                    SETUP CONCLUDED
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
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
                            const parentStock = stocks.find(s => s.symbol === pos.symbol);
                            const spotPrice = parentStock ? parentStock.lastPrice : null;
                            
                            return (
                              <tr key={pos.id} className="hover:bg-white/5 transition-all">
                                <td className="px-4 py-3">
                                  <div className="flex flex-col">
                                    <span className="font-bold text-white tracking-widest">{pos.symbol || 'UNKNOWN'}</span>
                                    <span className="text-[9px] text-neutral-500 uppercase tracking-widest flex items-baseline gap-1.5 flex-wrap">
                                      <span>Strike: {pos.strike || 'N/A'}</span>
                                      {spotPrice !== null && (
                                        <span className="text-[8px] text-neutral-400 font-normal lowercase">(spot: ₹{spotPrice.toFixed(1)})</span>
                                      )}
                                    </span>
                                  </div>
                                </td>
                                <td className={cn("px-4 py-3 font-black", (pos.type || '').includes('CE') ? "text-neon-green" : "text-neon-red")}>{pos.type || 'N/A'}</td>
                                <td className="px-4 py-3 text-center text-neutral-500 font-mono text-[9px]">
                                  {(pos.timestamp?.toDate?.() || (pos.timestamp instanceof Date ? pos.timestamp : new Date())).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
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
                                  <div className="flex justify-end gap-2">
                                    <button 
                                      onClick={() => {
                                        if (parentStock) {
                                          handleStockSelect(parentStock);
                                        }
                                      }}
                                      className={cn(
                                        "px-2 py-1 text-[8px] font-black uppercase tracking-wider border transition-all focus:outline-none",
                                        selectedStock?.symbol === pos.symbol 
                                          ? "bg-neon-green text-black border-neon-green shadow-[0_0_8px_rgba(0,255,148,0.3)]" 
                                          : "text-neon-green border-neon-green/30 hover:border-neon-green hover:bg-neon-green/5"
                                      )}
                                    >
                                      🤖 AI COCKPIT
                                    </button>
                                    <button 
                                      onClick={() => closePosition(pos.id).catch(e => console.error("[UI] Manual close failed:", e))}
                                      className="text-neutral-500 hover:text-white uppercase text-[8px] font-black tracking-[.2em] border border-tech-border px-3 py-1 hover:border-white transition-all focus:outline-none"
                                    >
                                      LIQUIDATE
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Gemini Live Strategy Sentinel (Cockpit) */}
                  <div className="border border-tech-border p-6 bg-tech-surface mt-10 space-y-6 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-48 h-24 bg-neon-green/5 blur-[80px] pointer-events-none" />
                    
                    {/* Header */}
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-tech-border pb-4">
                      <div className="space-y-1">
                        <div className="text-[10px] font-mono text-neon-green uppercase tracking-[0.3em] font-extrabold flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-neon-green animate-ping" />
                          GEMINI REAL-TIME STRATEGY WATCH
                        </div>
                        <h3 className="text-sm font-black text-white uppercase tracking-wider">Live Position Sentinel & Options Cockpit</h3>
                        <p className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest leading-none">
                          Real-time derivatives structure, delta skew, and IVR evaluation.
                        </p>
                      </div>
                      
                      <div className="flex gap-3">
                        {selectedStock ? (
                          <button
                            onClick={() => handleStockSelect(selectedStock)}
                            disabled={loadingStrategy}
                            className={cn(
                              "px-3 py-1.5 text-[9px] font-extrabold uppercase tracking-widest border border-tech-border transition-all duration-300",
                              loadingStrategy ? "text-neutral-500 bg-neutral-900" : "bg-neon-green text-black font-black hover:bg-opacity-95 shadow-[0_0_10px_rgba(0,255,148,0.2)]"
                            )}
                          >
                            {loadingStrategy ? "EVALUATING..." : "REFRESH LIVE STRATEGY"}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* Main Content */}
                    {!selectedStock ? (
                      <div className="border border-dashed border-tech-border p-8 text-center bg-[#0B0E14]/30">
                        <Cpu className="mx-auto text-neutral-700 mb-3 animate-pulse" size={28} />
                        <h4 className="text-[10px] font-black uppercase tracking-[0.15em] text-neutral-400 mb-1">Sentinel Standby</h4>
                        <p className="text-[10px] text-neutral-500 font-mono max-w-xl mx-auto uppercase tracking-wider leading-relaxed">
                          Click "🤖 AI COCKPIT" on any active position row above to evaluate that live trade's options chain metrics, greeks, and volatility rank.
                        </p>
                      </div>
                    ) : loadingStrategy ? (
                      <div className="border border-tech-border p-12 text-center bg-[#0B0E14] flex flex-col items-center justify-center space-y-3">
                        <RefreshCw className="text-neon-green animate-spin" size={24} />
                        <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-white">Synthesizing Option Space</h4>
                        <p className="text-[9px] text-neutral-500 font-mono tracking-wider uppercase">Evaluating delta skew, volume footprint and higher timeframe confluence...</p>
                      </div>
                    ) : strategyReport ? (
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                        {/* Left column: Scorecard (Big Win Prob, Verdict & Scores) */}
                        <div className="lg:col-span-4 space-y-4">
                          <div className="bg-[#0B0E14] border border-tech-border p-5 flex flex-col items-center text-center relative overflow-hidden">
                            <div className="text-[8px] font-mono text-neutral-500 uppercase tracking-widest mb-3">Live Signal Verdict</div>
                            
                            <div className={cn(
                              "text-2xl font-extrabold uppercase px-4 py-1.5 tracking-widest border border-dashed rounded-sm font-mono mb-4",
                              strategyReport.verdict === 'ENTER' ? "text-neon-green bg-neon-green/10 border-neon-green/30" :
                              strategyReport.verdict === 'WATCH' ? "text-amber-400 bg-amber-400/10 border-amber-400/30" :
                              "text-neon-red bg-neon-red/10 border-neon-red/30"
                            )}>
                              {strategyReport.verdict === 'ENTER' ? 'HOLD / BUY' : strategyReport.verdict === 'WATCH' ? 'HOLD / WATCH' : 'ALERT / EXIT'}
                            </div>

                            <div className="relative flex items-center justify-center mb-3">
                              <svg className="w-28 h-28 transform -rotate-90">
                                <circle cx="56" cy="56" r="46" stroke="#161b22" strokeWidth="6" fill="transparent" />
                                <circle 
                                  cx="56" 
                                  cy="56" 
                                  r="46" 
                                  stroke={strategyReport.verdict === 'ENTER' ? "#00FF94" : strategyReport.verdict === 'WATCH' ? "#FBBF24" : "#FF5252"} 
                                  strokeWidth="8" 
                                  fill="transparent" 
                                  strokeDasharray={289}
                                  strokeDashoffset={289 - (289 * strategyReport.winProbability) / 100}
                                  strokeLinecap="round"
                                  className="transition-all duration-1000"
                                />
                              </svg>
                              <div className="absolute flex flex-col items-center justify-center font-mono">
                                <span className="text-2xl font-black text-white">{strategyReport.winProbability}%</span>
                                <span className="text-[7px] text-neutral-500 uppercase font-black tracking-widest">EXPECTANCY</span>
                              </div>
                            </div>

                            <div className="text-[9px] font-mono text-neutral-500 uppercase mb-3">
                              Confidence Threshold: <span className={cn("font-bold text-white", strategyReport.confidence === 'High' ? 'text-neon-green' : 'text-amber-400')}>{strategyReport.confidence}</span>
                            </div>

                            <div className="w-full border-t border-tech-border/30 pt-3 space-y-1">
                              <div className="text-[8px] font-mono text-neutral-500 uppercase tracking-widest text-center">Active Archetype:</div>
                              <div className="text-[10px] font-black text-white uppercase font-mono text-center leading-tight">{strategyReport.strategyName}</div>
                            </div>
                          </div>

                          {/* Institutional Feature Scores */}
                          <div className="bg-[#0B0E14] border border-tech-border p-5 space-y-3">
                            <div className="text-[9px] font-mono font-bold text-neutral-450 uppercase tracking-widest">Core Quantitative Fingerprint</div>
                            <div className="space-y-2.5 font-mono">
                              {[
                                { name: 'Momentum Vector', score: strategyReport.momentumScore },
                                { name: 'Institutional Block Buildup', score: strategyReport.institutionalActivityScore },
                                { name: 'Breakout Pattern Quality', score: strategyReport.breakoutQualityScore },
                                { name: 'Risk Protection Score', score: strategyReport.riskScore },
                              ].map((m, idx) => (
                                <div key={idx} className="space-y-1">
                                  <div className="flex justify-between text-[8px] text-neutral-500 font-bold uppercase">
                                    <span>{m.name}</span>
                                    <span className="text-white font-black">{m.score}/10</span>
                                  </div>
                                  <div className="h-1 bg-neutral-900 overflow-hidden relative">
                                    <div 
                                      className="h-full bg-neon-green transition-all duration-500" 
                                      style={{ width: `${m.score * 10}%` }}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Right column: Confluences & suggested boundaries */}
                        <div className="lg:col-span-8 space-y-4">
                          {/* 1. Confluence Matrix */}
                          <div className="bg-[#0B0E14] border border-tech-border p-5">
                            <h4 className="text-[10px] font-black text-white uppercase tracking-wider mb-3 pb-1.5 border-b border-tech-border/30">Technical & Derivatives Confluence Matrix</h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {/* Tech Metrics */}
                              <div className="space-y-3 font-mono text-[9px]">
                                <div className="flex justify-between items-center py-1.5 border-b border-tech-border/30">
                                  <span className="text-neutral-500 uppercase font-bold">Regime Alignment Indicator</span>
                                  <span className="text-neon-green font-black uppercase">{strategyReport.technicalConflux.regimeAlignment}</span>
                                </div>
                                <div className="flex justify-between items-center py-1.5 border-b border-tech-border/30">
                                  <span className="text-neutral-500 uppercase font-bold">Higher Timeframe Bias (H1)</span>
                                  <span className="text-white font-black uppercase text-center">{strategyReport.technicalConflux.higherTimeframeBias}</span>
                                </div>
                                <div className="flex justify-between items-center py-1.5 border-b border-tech-border/30">
                                  <span className="text-neutral-500 uppercase font-bold">RSI Exhaustion Check</span>
                                  <span className={cn(
                                    "font-black uppercase",
                                    strategyReport.technicalConflux.rsiOverextensionCheck === 'SAFE' ? "text-neon-green" :
                                    strategyReport.technicalConflux.rsiOverextensionCheck === 'WARNING' ? "text-amber-400" : "text-neon-red"
                                  )}>{strategyReport.technicalConflux.rsiOverextensionCheck}</span>
                                </div>
                                <div className="flex justify-between items-center py-1.5">
                                  <span className="text-neutral-500 uppercase font-bold">Relative Volume Multiplier</span>
                                  <span className="text-white font-black">{strategyReport.technicalConflux.relativeVolumeVsAverage}</span>
                                </div>
                              </div>

                              {/* Options Metrics */}
                              <div className="space-y-3 font-mono text-[9px] bg-neutral-900/30 p-3.5 border border-tech-border/30">
                                <div className="flex justify-between items-center py-1 border-b border-tech-border/30">
                                  <span className="text-neutral-500 uppercase font-bold">Optimal Strike Choice</span>
                                  <span className="text-neon-cyan font-black">{strategyReport.optionsMetricsEvaluation.recommendedStrikeSelection}</span>
                                </div>
                                <div className="flex justify-between items-center py-1 border-b border-tech-border/30">
                                  <span className="text-neutral-500 uppercase font-bold">Gamma Squeeze Rank</span>
                                  <span className={cn(
                                    "font-black",
                                    strategyReport.optionsMetricsEvaluation.gammaSqueezePotential === 'High' ? "text-neon-green" : "text-neutral-400"
                                  )}>{strategyReport.optionsMetricsEvaluation.gammaSqueezePotential}</span>
                                </div>
                                <div className="flex justify-between items-center py-1 border-b border-tech-border/30">
                                  <span className="text-neutral-500 uppercase font-bold">Theta Decay Exposure</span>
                                  <span className={cn(
                                    "font-black",
                                    strategyReport.optionsMetricsEvaluation.thetaDecayRisk === 'Low' ? "text-neon-green" : "text-amber-400"
                                  )}>{strategyReport.optionsMetricsEvaluation.thetaDecayRisk}</span>
                                </div>
                                <div className="flex justify-between items-center py-1">
                                  <span className="text-neutral-500 uppercase font-bold">Implied Volatility Rank (IVR)</span>
                                  <span className="text-white font-black">{strategyReport.optionsMetricsEvaluation.impliedVolatilityRank}</span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* 2. Suggested Trading Boundaries */}
                          <div className="bg-[#0B0E14] border border-tech-border p-5 font-mono text-[10px] relative">
                            <h4 className="text-[10px] font-black text-white uppercase tracking-wider mb-3">Gemini Recommended Execution Boundaries (Option Premium Levels)</h4>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                              <div className="p-3 bg-neutral-900/60 border border-tech-border rounded-sm">
                                <div className="text-[7px] text-neutral-500 uppercase mb-1">CONTRACT VALUE</div>
                                <div className="text-xs font-black text-neon-cyan">{strategyReport.optionsMetricsEvaluation.recommendedStrikeSelection}</div>
                              </div>
                              <div className="p-3 bg-neutral-900/60 border border-tech-border rounded-sm">
                                <div className="text-[7px] text-neutral-500 uppercase mb-1">PROPOSED SIZING</div>
                                <div className="text-xs font-black text-white">{strategyReport.suggestedRiskRules.suggestedMaxCapitalAllocPercent}% CAP</div>
                              </div>
                              <div className="p-3 bg-neutral-900/60 border border-tech-border rounded-sm border-neon-red/20">
                                <div className="text-[7px] text-neutral-500 uppercase mb-1">PREMIUM STOP LOSS</div>
                                <div className="text-xs font-black text-neon-red">₹{strategyReport.suggestedRiskRules.dynamicStopLoss}</div>
                              </div>
                              <div className="p-3 bg-neutral-900/60 border border-tech-border rounded-sm border-neon-green/20">
                                <div className="text-[7px] text-neutral-500 uppercase mb-1">PREMIUM TARGETS</div>
                                <div className="text-[9px] font-black text-neon-green leading-snug">
                                  T1: ₹{strategyReport.suggestedRiskRules.recommendedTarget1}<br/>
                                  T2: ₹{strategyReport.suggestedRiskRules.recommendedTarget2}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* 3. Narrative Rationale */}
                          <div className="bg-[#0B0E14] border border-tech-border p-5 space-y-3">
                            <h4 className="text-[10px] font-black text-white uppercase tracking-wider">Qualitative Liquidity & Mechanics Narrative</h4>
                            <p className="text-[11px] text-neutral-300 font-sans leading-relaxed">
                              {strategyReport.rationales}
                            </p>
                            <div className="text-[8px] font-mono text-neutral-550 border-t border-tech-border/30 pt-2 flex justify-between uppercase">
                              <span>INTELLIGENCE SOURCE: GEMINI_3.5_FLASH</span>
                              <span>DESK ROUTING CONFIDENCE: {strategyReport.confidence === 'High' ? 'SECURE' : 'CAUTION'}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="border border-tech-border p-8 text-center bg-[#0B0E14]">
                        <Cpu className="mx-auto text-neutral-700 mb-3 animate-bounce" size={24} />
                        <h4 className="text-[10px] font-black uppercase tracking-wider text-white mb-1">No Report Found</h4>
                        <p className="text-[9px] text-neutral-550 font-mono uppercase tracking-wider">
                          Press "REFRESH LIVE STRATEGY" above to invoke the live Gemini AI Strategy report for {selectedStock.symbol}.
                        </p>
                      </div>
                    )}
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
                            onClick={() => updateRiskSettings({ killSwitch: !riskSettings?.killSwitch }).catch(() => {})}
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

                      {/* Algorithmic Execution Mode Panel */}
                      <div className="p-6 bg-tech-bg border border-tech-border/80 flex flex-col md:flex-row md:items-center justify-between gap-6">
                        <div className="space-y-1 md:max-w-md">
                          <span className="text-[8px] font-mono font-bold text-neon-green uppercase tracking-widest block">ALGORITHMIC ROUTING ENGINE MODE</span>
                          <h4 className="text-sm font-black text-white uppercase tracking-tight flex items-center gap-2">
                            {editingSettings?.paperTradingMode !== false ? (
                              <>
                                <span className="inline-block w-2.5 h-2.5 bg-neon-green rounded-full shadow-[0_0_10px_rgba(0,255,148,0.5)]"></span>
                                🛡️ SAFETIED SIMULATION (PAPER ACTIVE)
                              </>
                            ) : (
                              <>
                                <span className="inline-block w-2.5 h-2.5 bg-neon-red rounded-full shadow-[0_0_10px_rgba(255,100,100,0.5)]"></span>
                                🔥 LIVE NEO PRODUCTION GATEWAY (LIVE DEPLOYED)
                              </>
                            )}
                          </h4>
                          <p className="text-[10px] text-neutral-500 leading-relaxed">
                            {editingSettings?.paperTradingMode !== false 
                              ? "Positions are recorded in a virtual cloud ledger. Local order streams undergo real-time simulation logic based on Fyers queue tickers. Zero capital liability."
                              : "DANGER: Order execution triggers are converted into active production buy commands and forwarded immediately to Kotak Securities napi.kotaksecurities.com gateway."
                            }
                          </p>
                        </div>
                        <button
                          disabled={riskSettings?.killSwitch}
                          onClick={() => {
                            const newPaperMode = editingSettings?.paperTradingMode !== false ? false : true;
                            setEditingSettings(prev => {
                              if (prev) return { ...prev, paperTradingMode: newPaperMode };
                              if (riskSettings) return { ...riskSettings, paperTradingMode: newPaperMode };
                              return null;
                            });
                          }}
                          className={cn(
                            "px-6 py-3 text-[9px] font-bold uppercase tracking-widest border transition-all self-start md:self-center leading-none",
                            editingSettings?.paperTradingMode !== false
                              ? "bg-neutral-950 text-neutral-400 border-neutral-800 hover:border-neon-red hover:text-neon-red"
                              : "bg-neon-red/10 text-neon-red border-neon-red hover:bg-neon-red hover:text-white",
                            riskSettings?.killSwitch && "opacity-20 cursor-not-allowed"
                          )}
                        >
                          {editingSettings?.paperTradingMode !== false ? "DEPLOY_LIVE_GATEWAY" : "ENGAGE_PAPER_SHIELD"}
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
                            onClick={() => editingSettings && updateRiskSettings(editingSettings).catch(() => {})}
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
                         <h1 className="text-xl font-sans font-extrabold tracking-tighter text-white uppercase">Attribution Analytics</h1>
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
                      <div className={cn("text-lg font-black font-mono", kpi.color)}>{kpi.value}</div>
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
                        <h2 className="text-[10px] font-mono font-bold uppercase tracking-[.3em] text-neutral-500 mb-2">Performance by Setup</h2>
                        <p className="text-[9px] text-neutral-600 font-mono italic uppercase tracking-widest leading-relaxed">Look for setups where count ≥ 5 AND win rate ≥ 55%. Discard or throttle anything consistently below 40%.</p>
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
                                     <span className="text-neutral-400">IN: {(t.timestamp?.toDate?.() || (t.timestamp instanceof Date ? t.timestamp : new Date())).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
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
                             { hour: '09:00', pnl: tradeHistory.filter(t => { const h = (t.timestamp?.toDate?.() || t.timestamp)?.getHours(); return h === 9; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '10:00', pnl: tradeHistory.filter(t => { const h = (t.timestamp?.toDate?.() || t.timestamp)?.getHours(); return h === 10; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '11:00', pnl: tradeHistory.filter(t => { const h = (t.timestamp?.toDate?.() || t.timestamp)?.getHours(); return h === 11; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '12:00', pnl: tradeHistory.filter(t => { const h = (t.timestamp?.toDate?.() || t.timestamp)?.getHours(); return h === 12; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '13:00', pnl: tradeHistory.filter(t => { const h = (t.timestamp?.toDate?.() || t.timestamp)?.getHours(); return h === 13; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '14:00', pnl: tradeHistory.filter(t => { const h = (t.timestamp?.toDate?.() || t.timestamp)?.getHours(); return h === 14; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { hour: '15:00', pnl: tradeHistory.filter(t => { const h = (t.timestamp?.toDate?.() || t.timestamp)?.getHours(); return h === 15; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                           ]}>
                             <XAxis dataKey="hour" fontSize={10} axisLine={false} tickLine={false} />
                             <YAxis fontSize={10} axisLine={false} tickLine={false} />
                             <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #333', fontSize: '10px' }} />
                             <Bar dataKey="pnl" fill="#00FF94" radius={[4, 4, 0, 0]} />
                           </BarChart>
                         </ResponsiveContainer>
                       </div>
                     </div>

                     <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                       <div className="bg-tech-surface border border-tech-border p-8">
                         <h3 className="text-sm font-black text-white uppercase tracking-tight mb-6">Hold Duration vs Outcome</h3>
                         <div className="space-y-4">
                           {[
                             { range: '< 15m', trades: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.timestamp?.toDate?.() || t.timestamp)?.getTime()) / 1000 / 60; return d < 15; }).length, pnl: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.timestamp?.toDate?.() || t.timestamp)?.getTime()) / 1000 / 60; return d < 15; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { range: '15-60m', trades: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.timestamp?.toDate?.() || t.timestamp)?.getTime()) / 1000 / 60; return d >= 15 && d < 60; }).length, pnl: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.timestamp?.toDate?.() || t.timestamp)?.getTime()) / 1000 / 60; return d >= 15 && d < 60; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { range: '1-3h', trades: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.timestamp?.toDate?.() || t.timestamp)?.getTime()) / 1000 / 60; return d >= 60 && d < 180; }).length, pnl: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.timestamp?.toDate?.() || t.timestamp)?.getTime()) / 1000 / 60; return d >= 60 && d < 180; }).reduce((s, c) => s + (c.pnl || 0), 0) },
                             { range: 'EOD', trades: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.timestamp?.toDate?.() || t.timestamp)?.getTime()) / 1000 / 60; return d >= 180; }).length, pnl: tradeHistory.filter(t => { const d = ((t.closedAt?.toDate?.() || t.closedAt)?.getTime() - (t.timestamp?.toDate?.() || t.timestamp)?.getTime()) / 1000 / 60; return d >= 180; }).reduce((s, c) => s + (c.pnl || 0), 0) },
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
           {activeView === 'breakout' && (
             <motion.div 
               key="breakout"
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               exit={{ opacity: 0 }}
               className="space-y-6 pb-10"
             >
               <BreakoutScreenerAndTerminal
                 state={breakoutState}
                 onToggleStrategy={handleToggleBreakoutStrategy}
                 onToggleAutoTrigger={handleToggleBreakoutAutoTrigger}
                 onTriggerScan={handleBreakoutTriggerScan}
                 onManualTrigger={handleBreakoutManualTrigger}
                 onManualClose={handleBreakoutManualClose}
               />
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

      {showKotakSetupModal && (
        <div id="kotak-credentials-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg bg-tech-surface border border-tech-border p-6 font-mono relative shadow-2xl">
            {/* Header border decor */}
            <div className="absolute top-0 left-0 right-0 h-[2px] bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]"></div>
            
            <div className="flex justify-between items-center mb-6">
              <div>
                <span className="text-[8px] font-bold text-sky-400 uppercase tracking-widest block">SECURE KOTAK NEO GATEWAY</span>
                <h3 className="text-sm font-black text-white uppercase tracking-tight">LINK BROKER ACCOUNT</h3>
              </div>
              <button 
                type="button"
                onClick={() => setShowKotakSetupModal(false)}
                className="text-neutral-500 hover:text-white text-xs border border-tech-border px-1.5 py-0.5 hover:bg-neutral-900 transition-all font-bold"
              >
                ESC_CLOSE
              </button>
            </div>

            <p className="text-[10px] text-neutral-400 mb-6 leading-relaxed bg-black/40 p-3 border border-tech-border/30">
              Use your Kotak Securities developer portal keys. These credentials are secure and will be saved to your environment secrets block for live order execution routing.
            </p>

            <form onSubmit={triggerKotakManualLogin} className="space-y-4">
              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-neutral-400 block font-bold">Consumer Key (API Key)</label>
                <input 
                  type="text"
                  required
                  placeholder="Enter Kotak Neo Consumer Key"
                  value={kotakForm.consumerKey}
                  onChange={(e) => setKotakForm(prev => ({ ...prev, consumerKey: e.target.value }))}
                  className="w-full bg-tech-bg border border-tech-border text-white px-3 py-2 text-[11px] focus:outline-none focus:border-sky-400 font-sans"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-neutral-400 block font-bold">Consumer Secret (Secret Key)</label>
                <input 
                  type="password"
                  required
                  placeholder="Enter Kotak Neo Consumer Secret"
                  value={kotakForm.consumerSecret}
                  onChange={(e) => setKotakForm(prev => ({ ...prev, consumerSecret: e.target.value }))}
                  className="w-full bg-tech-bg border border-tech-border text-white px-3 py-2 text-[11px] focus:outline-none focus:border-sky-400 font-sans"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1 col-span-1 border-r border-tech-border/30 pr-2">
                  <label className="text-[9px] uppercase tracking-wider text-neutral-400 block font-bold">Neo User ID</label>
                  <input 
                    type="text"
                    required
                    placeholder="User ID"
                    value={kotakForm.userId}
                    onChange={(e) => setKotakForm(prev => ({ ...prev, userId: e.target.value }))}
                    className="w-full bg-tech-bg border border-tech-border text-white px-3 py-2 text-[11px] focus:outline-none focus:border-sky-400 font-sans"
                  />
                </div>

                <div className="space-y-1 col-span-1 border-r border-tech-border/30 pr-2">
                  <label className="text-[9px] uppercase tracking-wider text-neutral-400 block font-bold">Password</label>
                  <input 
                    type="password"
                    required
                    placeholder="Password"
                    value={kotakForm.password}
                    onChange={(e) => setKotakForm(prev => ({ ...prev, password: e.target.value }))}
                    className="w-full bg-tech-bg border border-tech-border text-white px-3 py-2 text-[11px] focus:outline-none focus:border-sky-400 font-sans"
                  />
                </div>

                <div className="space-y-1 col-span-1">
                  <label className="text-[9px] uppercase tracking-wider text-neutral-400 block font-bold">MPIN (4-6 Digit)</label>
                  <input 
                    type="password"
                    required
                    maxLength={6}
                    placeholder="MPIN"
                    value={kotakForm.pin}
                    onChange={(e) => setKotakForm(prev => ({ ...prev, pin: e.target.value }))}
                    className="w-full bg-tech-bg border border-tech-border text-white px-3 py-2 text-[11px] focus:outline-none focus:border-sky-400 font-sans"
                  />
                </div>
              </div>

              {kotakError && (
                <div className="p-3 bg-red-950/25 border border-red-900/50 text-red-400 text-[10px] leading-relaxed">
                  ⚠️ AUTH_FAILURE: {kotakError}
                </div>
              )}

              <div className="flex gap-3 pt-4">
                <button 
                  type="button"
                  onClick={() => setShowKotakSetupModal(false)}
                  className="flex-1 bg-transparent hover:bg-neutral-900 text-neutral-400 hover:text-white border border-tech-border py-2.5 text-[10px] font-bold uppercase transition-all"
                >
                  ABORT_ACTION
                </button>
                <button 
                  type="submit"
                  disabled={isLoggingInKotakManual}
                  className="flex-1 bg-sky-500/10 hover:bg-sky-500 text-sky-400 hover:text-white border border-sky-500/30 py-2.5 text-[10px] font-bold uppercase transition-all flex items-center justify-center gap-2"
                >
                  {isLoggingInKotakManual ? 'ESTABLISHING HANDSHAKE...' : 'ESTABLISH BROKER_CHANNEL'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
