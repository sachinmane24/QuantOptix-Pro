/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  LogOut, LogIn, User as UserIcon, Settings,
  History, TrendingUp, TrendingDown,
  LayoutDashboard, Eye, ListFilter, Activity, Target, Shield, AlertTriangle, 
  BarChart3, Search, RefreshCw, Layers, Zap, PieChart, ChevronRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, BarChart, Bar, Cell, PieChart as RePieChart, Pie,
  LineChart, Line
} from 'recharts';
import { cn, formatCurrency, formatNumber } from './lib/utils';
import { 
  getLiveStockData, getMarketOverview, getOptionChain 
} from './services/nseService';
import { analyzeTradeProbability, generateRecommendation } from './services/aiAnalysisService';
import { 
  StockData, OptionAction, Trend, MarketRegime, 
  AIProbabilityModel, TradeRecommendation 
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

// --- Main App Component ---

export default function App() {
  const [activeView, setActiveView] = useState<'dashboard' | 'screener' | 'analysis' | 'portfolio' | 'risk' | 'analytics'>('dashboard');
  const [user, setUser] = useState<User | null>(null);
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [marketInfo, setMarketInfo] = useState<any>(null);
  const [selectedStock, setSelectedStock] = useState<StockData | null>(null);
  const [optionChain, setOptionChain] = useState<any[]>([]);
  const [aiAnalysis, setAiAnalysis] = useState<AIProbabilityModel | null>(null);
  const [recommendation, setRecommendation] = useState<TradeRecommendation | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Scanners
  const [filter, setFilter] = useState<'all' | 'bullish' | 'bearish' | 'breakout'>('all');

  // Paper Trading State
  const [portfolio, setPortfolio] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [tradeHistory, setTradeHistory] = useState<any[]>([]);
  const [isAutoTrading, setIsAutoTrading] = useState(false);
  const [tradeLogs, setTradeLogs] = useState<string[]>([]);

  // NSE / Fyers Data flow
  useEffect(() => {
    const data = getLiveStockData();
    setStocks(data);
    setMarketInfo(getMarketOverview());

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    return () => unsubscribe();
  }, []);

  // Firebase Real-time Sync
  useEffect(() => {
    if (!user) return;

    // Sync Portfolio
    const unsubPort = onSnapshot(doc(db, 'portfolios', user.uid), (snap) => {
      if (snap.exists()) {
        setPortfolio(snap.data());
      } else {
        // Initial Portfolio
        setDoc(doc(db, 'portfolios', user.uid), {
          userId: user.uid,
          balance: 1000000,
          totalTrades: 0,
          winRate: 0,
          netPnl: 0
        });
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
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'trades'));

    return () => {
      unsubPort();
      unsubTrades();
    };
  }, [user]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error(err);
    }
  };

  const handleLogout = () => auth.signOut();

  const handleStockSelect = async (stock: StockData) => {
    setSelectedStock(stock);
    setOptionChain(getOptionChain(stock.symbol, stock.lastPrice));
    setActiveView('analysis');
    setLoadingAnalysis(true);
    
    // Fetch AI Analysis
    const analysis = await analyzeTradeProbability(stock, getOptionChain(stock.symbol, stock.lastPrice));
    setAiAnalysis(analysis);
    const rec = generateRecommendation(stock, analysis, getOptionChain(stock.symbol, stock.lastPrice));
    setRecommendation(rec);
    setLoadingAnalysis(false);

    // Auto-Trading Logic
    if (isAutoTrading && analysis.winProbability >= 80) {
      executeTrade(stock, rec, analysis);
    }
  };

  const executeTrade = async (stock: StockData, rec: TradeRecommendation, analysis: AIProbabilityModel) => {
    if (!user || !portfolio) return;

    // Check if already in position
    if (positions.find(p => p.symbol === stock.symbol)) return;

    const riskPerTrade = (portfolio?.balance || 1000000) * 0.01; // 1% Risk
    const entry = rec.entryPrice;
    const sl = rec.stopLoss;
    const stopLossPoints = Math.abs(entry - sl);
    const qty = Math.floor(riskPerTrade / (stopLossPoints || 1));

    if (qty <= 0) return;

    const newPosition = {
      userId: user.uid,
      symbol: stock.symbol,
      type: rec.action,
      entry: entry,
      sl: sl,
      targets: rec.targets,
      qty: qty,
      pnl: 0,
      status: 'OPEN',
      timestamp: Timestamp.now(),
      prob: analysis.winProbability
    };

    try {
      await addDoc(collection(db, 'trades'), newPosition);
      setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] ORDER EXECUTED: ${stock.symbol} ${rec.action} @ ${rec.entryPrice} QTY: ${qty}`, ...prev]);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'trades');
    }
  };

  const closePosition = async (id: string) => {
    const pos = positions.find(p => p.id === id);
    if (!pos) return;

    try {
      const docRef = doc(db, 'trades', id);
      await updateDoc(docRef, {
        status: 'CLOSED',
        exit: pos.entry + (pos.pnl / pos.qty), // Simulated exit
        closedAt: Timestamp.now()
      });

      // Update Portfolio (Simplified)
      const pRef = doc(db, 'portfolios', user!.uid);
      await updateDoc(pRef, {
        balance: (portfolio.balance || 0) + pos.pnl,
        totalTrades: (portfolio.totalTrades || 0) + 1,
        netPnl: (portfolio.netPnl || 0) + pos.pnl
      });

      setTradeLogs(prev => [`[${new Date().toLocaleTimeString()}] POSITION CLOSED: ${pos.symbol} PNL: ${pos.pnl.toFixed(2)}`, ...prev]);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'trades');
    }
  };

  const filteredStocks = stocks.filter(s => {
    const matchesSearch = s.symbol.toLowerCase().includes(searchQuery.toLowerCase());
    if (filter === 'bullish') {
      return matchesSearch && 
             s.lastPrice > s.vwap && 
             s.lastPrice > s.ema20 && 
             s.relVolume > 1.5 && 
             s.oiChange > 2;
    }
    if (filter === 'bearish') {
      return matchesSearch && 
             s.lastPrice < s.vwap && 
             s.lastPrice < s.ema20 && 
             s.oiChange > 2;
    }
    if (filter === 'breakout') {
      return matchesSearch && 
             s.marketRegime === MarketRegime.BREAKOUT && 
             s.relVolume > 2;
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
            <h1 className="text-xl font-sans font-extrabold tracking-tighter text-white">QUANTA<span className="text-neon-green">NSE</span> AI</h1>
          </div>
          
          <div className="hidden xl:flex gap-8 text-[10px] font-mono uppercase text-neutral-500">
            {marketInfo && (
              <>
                <div>NIFTY 50 <span className={cn("font-bold ml-1", marketInfo.nifty.pChange >= 0 ? "text-neon-green" : "text-neon-red")}>{marketInfo.nifty.price} ({marketInfo.nifty.pChange >= 0 ? "+" : ""}{marketInfo.nifty.pChange}%)</span></div>
                <div>BANK NIFTY <span className={cn("font-bold ml-1", marketInfo.bankNifty.pChange >= 0 ? "text-neon-green" : "text-neon-red")}>{marketInfo.bankNifty.price} ({marketInfo.bankNifty.pChange >= 0 ? "+" : ""}{marketInfo.bankNifty.pChange}%)</span></div>
                <div>F&O UNIVERSE <span className="text-white font-bold ml-1">{stocks.length} ACTIVE</span></div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-6">
          <nav className="flex items-center gap-1 bg-tech-surface p-1 border border-tech-border">
            {[
              { id: 'dashboard', icon: LayoutDashboard, label: 'DASHBOARD' },
              { id: 'screener', icon: ListFilter, label: 'SCREENER' },
              { id: 'portfolio', icon: Activity, label: 'PORTFOLIO' },
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
            {user ? (
               <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-[8px] text-neutral-500 uppercase font-mono tracking-widest">{user.displayName}</div>
                    <div className="text-white text-[10px] font-mono font-bold leading-none">{formatCurrency(portfolio?.balance || 0)}</div>
                  </div>
                  <button onClick={handleLogout} className="text-neutral-500 hover:text-white transition-colors">
                    <LogOut size={16} />
                  </button>
               </div>
            ) : (
              <button 
                onClick={handleLogin}
                className="bg-neon-green text-black px-4 py-1.5 text-[10px] font-black uppercase tracking-tighter flex items-center gap-2"
              >
                <LogIn size={14} /> SIGN_IN
              </button>
            )}
            <div className="w-px h-8 bg-tech-border mx-2"></div>
            <div className="bg-tech-surface border border-tech-border px-3 py-1 text-[10px] font-mono flex items-center gap-3">
              <span className="text-neutral-500">AUTO-TRADE:</span>
              <button 
                onClick={() => setIsAutoTrading(!isAutoTrading)}
                className={cn(
                  "px-2 py-0.5 font-black uppercase tracking-tighter transition-all",
                  isAutoTrading ? "bg-neon-green text-black shadow-[0_0_8px_rgba(0,255,148,0.5)]" : "bg-neutral-800 text-neutral-500"
                )}
              >
                {isAutoTrading ? "ON" : "OFF"}
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
              {[
                { name: 'NIFTY IT', val: 8.5, color: 'bg-neon-green' },
                { name: 'NIFTY BANK', val: 7.2, color: 'bg-neon-green' },
                { name: 'NIFTY AUTO', val: 4.1, color: 'bg-neon-green' },
                { name: 'NIFTY PHARMA', val: 3.5, color: 'bg-neutral-600' },
                { name: 'NIFTY ENERGY', val: -2.1, color: 'bg-neon-red' },
              ].map(s => (
                <div key={s.name} className="group">
                  <div className="flex justify-between text-[11px] mb-1.5 font-mono">
                    <span className="text-neutral-400">{s.name}</span>
                    <span className={cn(s.val > 0 ? "text-neon-green" : "text-neon-red")}>{s.val > 0 ? "+" : ""}{s.val}%</span>
                  </div>
                  <div className="h-1 bg-tech-border relative overflow-hidden">
                    <div className={cn("absolute h-full top-0 left-0 transition-all duration-1000", s.color)} style={{ width: `${Math.abs(s.val) * 10}%` }}></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="flex-1 p-6 overflow-y-auto">
            <h3 className="text-[10px] uppercase text-neutral-500 font-bold mb-4 tracking-[0.2em]">AI Probability Feed</h3>
            <div className="space-y-3">
              {stocks.filter(s => s.trend !== Trend.SIDEWAYS).slice(0, 6).map(s => (
                <div 
                  key={s.symbol} 
                  className={cn(
                    "p-3 bg-tech-surface border-l-2 cursor-pointer hover:bg-neutral-800 transition-colors",
                    s.trend === Trend.BULLISH ? "border-neon-green" : "border-neon-red"
                  )}
                  onClick={() => handleStockSelect(s)}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="text-xs font-bold text-white">{s.symbol}</span>
                    <span className={cn(
                      "text-[9px] px-1.5 py-0.5 font-bold font-mono tracking-tighter",
                      s.trend === Trend.BULLISH ? "bg-neon-green/20 text-neon-green" : "bg-neon-red/20 text-neon-red"
                    )}>
                      {(70 + Math.random() * 25).toFixed(0)}% PROB
                    </span>
                  </div>
                  <div className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">
                    {s.trend === Trend.BULLISH ? "Long Buildup Confirmed" : "Short Buildup Detected"}
                  </div>
                </div>
              ))}
            </div>
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
                  {/* High Prob Alpha Opportunities */}
                  <div className="space-y-6">
                    <div className="flex justify-between items-center">
                      <h2 className="text-sm font-bold uppercase tracking-[0.2em] flex items-center gap-3">
                        <div className="w-2 h-2 bg-neon-green"></div>
                        High Probability Alpha Opportunities (NSE F&O)
                      </h2>
                      <div className="flex bg-tech-surface border border-tech-border p-1">
                        <button className="px-5 py-1 text-[10px] font-bold uppercase tracking-tighter bg-neon-green text-black">CE BUYING</button>
                        <button className="px-5 py-1 text-[10px] font-bold uppercase tracking-tighter text-neutral-500">PE BUYING</button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                      {stocks.filter(s => s.trend === Trend.BULLISH && s.relVolume > 1.5).slice(0, 2).map(s => (
                        <div key={s.symbol} className="bg-tech-surface border border-tech-border p-6 relative overflow-hidden group cursor-pointer hover:border-neon-green/50 transition-colors" onClick={() => handleStockSelect(s)}>
                          <div className="absolute top-0 right-0 p-4 opacity-5 font-black text-6xl italic uppercase pointer-events-none group-hover:opacity-10 transition-opacity">CE BUY</div>
                          <div className="flex justify-between items-start mb-6">
                            <div>
                              <h1 className="text-3xl font-black leading-none tracking-tighter text-white">{s.symbol}</h1>
                              <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest">Sector: {s.sector}</span>
                            </div>
                            <div className="text-right">
                              <div className="text-neon-green text-2xl font-mono font-black glow-green">BUY CE</div>
                              <div className="text-[10px] font-mono text-neutral-400 mt-1 uppercase tracking-widest">Strike: {Math.round(s.lastPrice/50)*50} | EXP: 28 MAR</div>
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-4 gap-2 mb-6">
                            {[
                              { label: 'Prob Score', val: `${(85 + Math.random() * 10).toFixed(1)}%`, highlight: true },
                              { label: 'IV Percentile', val: (20 + Math.random() * 30).toFixed(1) },
                              { label: 'Delta (Tgt)', val: '0.58' },
                              { label: 'Mtm Strength', val: 'HIGH' },
                            ].map((stat, i) => (
                              <div key={i} className="bg-tech-bg p-2.5 border border-tech-border">
                                <div className="text-[8px] text-neutral-500 uppercase font-mono tracking-widest mb-1">{stat.label}</div>
                                <div className={cn("text-sm font-bold", stat.highlight ? "text-neon-green glow-green" : "text-white")}>{stat.val}</div>
                              </div>
                            ))}
                          </div>

                          <div className="flex justify-between items-center bg-neon-green/5 border border-neon-green/20 p-3">
                            <span className="text-[10px] font-bold text-neon-green font-mono uppercase tracking-widest">
                              Entry: {(s.lastPrice * 0.02).toFixed(2)} | SL: {(s.lastPrice * 0.015).toFixed(2)} | TGT: {(s.lastPrice * 0.03).toFixed(2)}
                            </span>
                            <span className="text-[10px] font-bold text-neon-green px-2 py-0.5 border border-neon-green/50 bg-neon-green/10 uppercase tracking-tighter">
                              Active Breakout
                            </span>
                          </div>
                        </div>
                      ))}
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
                            <th className="px-4 py-3 tracking-widest">PCR</th>
                            <th className="px-4 py-3 tracking-widest text-right">Signal</th>
                          </tr>
                        </thead>
                        <tbody className="text-[11px] divide-y divide-tech-border">
                          {stocks.slice(0, 8).map(stock => (
                            <tr key={stock.symbol} className="hover:bg-white/5 transition-colors cursor-pointer" onClick={() => handleStockSelect(stock)}>
                              <td className="px-4 py-3 font-bold text-white">{stock.symbol}</td>
                              <td className="px-4 py-3">{formatCurrency(stock.lastPrice)}</td>
                              <td className={cn("px-4 py-3 font-bold", stock.pChange >= 0 ? "text-neon-green" : "text-neon-red")}>
                                {stock.pChange >= 0 ? "+" : ""}{stock.pChange.toFixed(2)}%
                              </td>
                              <td className="px-4 py-3 text-neutral-400">+{Math.abs(stock.oiChange).toFixed(1)}%</td>
                              <td className={cn("px-4 py-3 font-bold", stock.trend === Trend.BULLISH ? "text-neon-green" : "text-neon-red")}>
                                {stock.trend === Trend.BULLISH ? "LONG BUILDUP" : stock.trend === Trend.BEARISH ? "SHORT BUILDUP" : "NEUTRAL"}
                              </td>
                              <td className="px-4 py-3 text-neutral-500">{(0.6 + Math.random() * 0.8).toFixed(2)}</td>
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
                    {filteredStocks.map(stock => (
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
                            {stock.pChange >= 0 ? "+" : ""}{stock.pChange.toFixed(2)}%
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
                          {stock.relVolume.toFixed(2)}X
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

          {activeView === 'analysis' && selectedStock && (
            <motion.div 
              key="analysis"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid grid-cols-1 lg:grid-cols-4 gap-6"
            >
              <div className="lg:col-span-1 space-y-6">
                 <div className="bg-tech-surface border border-tech-border p-6 shadow-2xl">
                    <div className="flex items-center justify-between mb-6">
                       <h2 className="text-3xl font-black tracking-tighter text-white">{selectedStock.symbol}</h2>
                       <span className={cn(
                         "px-2 py-1 text-[10px] font-black font-mono",
                         selectedStock.trend === Trend.BULLISH ? "bg-neon-green text-black" : "bg-neon-red text-white"
                       )}>
                         {selectedStock.trend}
                       </span>
                    </div>
                    <div className="space-y-4 font-mono">
                       <div className="flex justify-between items-baseline">
                         <span className="text-[10px] text-neutral-500 uppercase tracking-widest">SPOT PRICE</span>
                         <span className="text-lg font-bold text-white tracking-tighter">{formatCurrency(selectedStock.lastPrice)}</span>
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
                              <span className="text-sm font-bold text-white tracking-widest">{recommendation?.entryPrice}</span>
                           </div>
                           <div className="p-3 bg-tech-bg border border-neon-red/20 text-neon-red">
                              <span className="text-[8px] block mb-1">Stop Loss</span>
                              <span className="text-sm font-bold tracking-widest">{recommendation?.stopLoss}</span>
                           </div>
                        </div>

                        <div className="space-y-2 mb-8 font-mono">
                           {recommendation?.targets.map((tgt: number, i: number) => (
                             <div key={i} className="flex justify-between items-center bg-tech-bg p-2.5 border border-neon-green/20">
                                <span className="text-[10px] text-neon-green font-bold uppercase tracking-widest">TARGET_{i+1}</span>
                                <span className="text-sm font-bold text-white tracking-widest">{tgt}</span>
                             </div>
                           ))}
                        </div>

                        <div className="flex items-center justify-between text-[10px] font-mono font-bold tracking-widest uppercase py-4 border-t border-tech-border">
                           <span className="text-neutral-500">PROB: <span className="text-white">{aiAnalysis?.winProbability}%</span></span>
                           <span className="text-neon-green">R:R {recommendation?.riskReward.toFixed(2)}</span>
                        </div>

                        <button 
                          onClick={() => executeTrade(selectedStock, recommendation!, aiAnalysis!)}
                          disabled={!user || isAutoTrading}
                          className={cn(
                            "w-full py-4 font-black uppercase tracking-[.3em] text-xs transition-all flex items-center justify-center gap-3",
                            recommendation?.action === OptionAction.BUY_CE 
                              ? "bg-neon-green text-black hover:bg-white shadow-[0_0_20px_rgba(0,255,148,0.3)]" 
                              : "bg-neon-red text-white hover:bg-white hover:text-black shadow-[0_0_20px_rgba(255,49,49,0.3)]",
                            (!user || isAutoTrading) && "opacity-50 cursor-not-allowed grayscale"
                          )}
                        >
                          {isAutoTrading ? "QUANT_BOT_HANDLING" : user ? "INITIALIZE_INSTITUTIONAL_ORDER" : "SIGN_IN_TO_TRADE"}
                        </button>
                     </>
                   )}
                 </div>
              </div>

              <div className="lg:col-span-3 space-y-6">
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
                          <button className="text-[10px] font-mono font-bold text-neon-green tracking-[0.2em] uppercase border-b-2 border-neon-green pb-1 shadow-neon-green">IV_VECTOR</button>
                          <button className="text-[10px] font-mono font-bold text-neutral-500 tracking-[0.2em] uppercase hover:text-white transition-colors pb-1">OI_DELTA</button>
                       </div>
                       <div className="flex-1 p-8 h-[400px]">
                          <ResponsiveContainer width="100%" height="100%">
                             <AreaChart data={[
                               { time: '10:00', iv: 18.2 },
                               { time: '11:00', iv: 19.5 },
                               { time: '12:00', iv: 18.8 },
                               { time: '13:00', iv: 20.4 },
                               { time: '14:00', iv: 22.1 },
                               { time: '15:00', iv: 21.8 },
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
                                <Area type="stepAfter" dataKey="iv" stroke="#00FF94" fillOpacity={1} fill="url(#colorIv)" strokeWidth={2} />
                             </AreaChart>
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
                      { label: 'RSI(14)_INDEX', value: selectedStock.rsi.toFixed(2), status: selectedStock.rsi > 70 ? 'OVERBOUGHT' : selectedStock.rsi < 30 ? 'OVERSOLD' : 'STABLE' },
                      { label: 'VWAP_VECTOR', value: formatCurrency(selectedStock.vwap), status: selectedStock.lastPrice > selectedStock.vwap ? 'BULLISH' : 'BEARISH' },
                      { label: 'EMA_20_SIG', value: formatCurrency(selectedStock.ema20), status: selectedStock.lastPrice > selectedStock.ema20 ? 'SUPP_ENABLED' : 'RES_ACTIVE' },
                      { label: 'PCR_L_VOL', value: '1.24', status: 'C_UNWINDING' },
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
            </motion.div>
          )}
          {activeView === 'portfolio' && (
            <motion.div 
              key="portfolio"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-6"
            >
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <StatCard title="Capital Deployed" value={formatCurrency(portfolio?.balance || 0)} />
                <StatCard title="Active PnL" value={formatCurrency(positions.reduce((acc, p) => acc + p.pnl, 0))} change={1.2} />
                <StatCard title="Total Gain/Loss" value={formatCurrency(portfolio?.netPnl || 0)} />
                <StatCard title="Alpha Efficiency" value="82.4" suffix="%" />
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
                          <th className="px-4 py-3 tracking-widest">Entry</th>
                          <th className="px-4 py-3 tracking-widest text-center">Qty</th>
                          <th className="px-4 py-3 tracking-widest">PnL</th>
                          <th className="px-4 py-3 tracking-widest text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="text-[11px] divide-y divide-tech-border">
                        {positions.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-4 py-24 text-center text-neutral-600 uppercase tracking-widest italic font-mono">
                               <div className="flex flex-col items-center gap-4">
                                  <RefreshCw className="animate-spin opacity-20" size={32} />
                                  Scanning Universe for Alpha Entry...
                               </div>
                            </td>
                          </tr>
                        ) : (
                          positions.map(pos => (
                            <tr key={pos.id} className="hover:bg-white/5 transition-colors">
                              <td className="px-4 py-3 font-bold text-white tracking-widest">{pos.symbol}</td>
                              <td className={cn("px-4 py-3 font-black", pos.type.includes('CE') ? "text-neon-green" : "text-neon-red")}>{pos.type}</td>
                              <td className="px-4 py-3 text-neutral-400">{pos.entry}</td>
                              <td className="px-4 py-3 text-white text-center font-bold bg-white/5">{pos.qty}</td>
                              <td className={cn("px-4 py-3 font-black", pos.pnl >= 0 ? "text-neon-green glow-green" : "text-neon-red glow-red")}>
                                {formatCurrency(pos.pnl)}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <button 
                                  onClick={() => closePosition(pos.id)}
                                  className="text-neutral-500 hover:text-white uppercase text-[8px] font-black tracking-[.2em] border border-tech-border px-3 py-1 hover:border-white transition-all"
                                >
                                  LIQUIDATE
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <h2 className="text-[10px] font-mono font-bold uppercase tracking-[.3em] text-neutral-500 mt-10">Institutional Execution Logs</h2>
                  <div className="bg-[#0b0e14] border border-tech-border p-5 h-[300px] overflow-y-auto font-mono text-[9px] space-y-3 custom-scrollbar">
                    {tradeLogs.length === 0 && <div className="text-neutral-700 italic uppercase">System ready. Waiting for order triggers...</div>}
                    {tradeLogs.map((log, i) => (
                      <div key={i} className="text-neutral-400 flex gap-4 items-start border-b border-white/5 pb-2">
                        <span className="text-neon-green font-black shrink-0">[EXEC_OK]</span>
                        <span>{log}</span>
                      </div>
                    ))}
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
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                   <div className="bg-tech-surface border border-tech-border p-8 space-y-8">
                      <div className="flex items-center gap-4 mb-4">
                         <Shield className="text-neon-green" size={24} />
                         <h2 className="text-xl font-black uppercase tracking-tighter">Global Risk Management</h2>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                         <div className="p-4 bg-tech-bg border border-tech-border space-y-2">
                            <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Max Risk Per Trade</span>
                            <div className="text-lg font-bold text-white font-mono">1.0%</div>
                         </div>
                         <div className="p-4 bg-tech-bg border border-tech-border space-y-2">
                            <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Daily SL Limit</span>
                            <div className="text-lg font-bold text-neon-red font-mono">3.0%</div>
                         </div>
                      </div>

                      <div className="space-y-6 pt-4">
                         <h3 className="text-[10px] font-mono font-bold uppercase tracking-widest text-neutral-500">Auto-Liquidation Thresholds</h3>
                         {[
                           { label: 'Drawdown Circuit Breaker', val: '5%', status: 'ARMED', color: 'bg-neon-green' },
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
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
                   <div className="bg-tech-surface border border-tech-border p-8">
                      <h2 className="text-xl font-black uppercase tracking-tighter mb-8">Equity Curve Alpha</h2>
                      <div className="h-[350px]">
                         <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={[
                              { day: 'M1', val: 0 },
                              { day: 'M2', val: 5000 },
                              { day: 'M3', val: 3000 },
                              { day: 'M4', val: 12000 },
                              { day: 'M5', val: 8000 },
                              { day: 'M6', val: 25000 },
                              { day: 'M7', val: 42000 },
                            ]}>
                               <defs>
                                 <linearGradient id="curvePnl" x1="0" y1="0" x2="0" y2="1">
                                   <stop offset="5%" stopColor="#00FF94" stopOpacity={0.3}/>
                                   <stop offset="95%" stopColor="#00FF94" stopOpacity={0}/>
                                 </linearGradient>
                               </defs>
                               <Tooltip contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #333' }} />
                               <Area type="monotone" dataKey="val" stroke="#00FF94" fill="url(#curvePnl)" strokeWidth={4} />
                            </AreaChart>
                         </ResponsiveContainer>
                      </div>
                   </div>

                   <div className="grid grid-cols-2 gap-4 h-full">
                      <div className="bg-tech-surface border border-tech-border p-6 flex flex-col justify-center items-center gap-2">
                         <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest">Expectancy</span>
                         <div className="text-4xl font-black text-white glow-green">0.42</div>
                         <span className="text-[8px] text-neon-green font-mono">POSITIVE ALPHA</span>
                      </div>
                      <div className="bg-tech-surface border border-tech-border p-6 flex flex-col justify-center items-center gap-2">
                         <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest">Avg RR Ratio</span>
                         <div className="text-4xl font-black text-white">1:2.4</div>
                         <span className="text-[8px] text-neutral-500 font-mono italic uppercase">Optimized via AI</span>
                      </div>
                      <div className="bg-tech-surface border border-tech-border p-6 flex flex-col justify-center items-center gap-2">
                         <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest">Max Winning Streak</span>
                         <div className="text-4xl font-black text-neon-green">8</div>
                      </div>
                      <div className="bg-tech-surface border border-tech-border p-6 flex flex-col justify-center items-center gap-2">
                         <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest">Max Losing Streak</span>
                         <div className="text-4xl font-black text-neon-red">3</div>
                      </div>
                   </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                   <div className="bg-tech-surface border border-tech-border p-6">
                      <h3 className="text-[10px] font-mono font-bold uppercase text-neutral-500 tracking-widest mb-6">Execution Accuracy</h3>
                      <div className="space-y-4">
                         {[
                           { l: 'Perfect Entry', v: 92 },
                           { l: 'Exit Discipline', v: 78 },
                           { l: 'SL Adherence', v: 100 }
                         ].map(v => (
                           <div key={v.l} className="space-y-2">
                              <div className="flex justify-between text-[9px] font-mono">
                                 <span className="text-neutral-500 uppercase">{v.l}</span>
                                 <span className="text-white">{v.v}%</span>
                              </div>
                              <div className="h-1 bg-tech-border">
                                 <div className="h-full bg-neon-green" style={{ width: `${v.v}%` }}></div>
                              </div>
                           </div>
                         ))}
                      </div>
                   </div>
                   <div className="lg:col-span-2 bg-tech-surface border border-tech-border p-6 overflow-hidden">
                      <h3 className="text-[10px] font-mono font-bold uppercase text-neutral-500 tracking-widest mb-6">Historical Trade Breakdown</h3>
                      <div className="border border-tech-border overflow-hidden">
                        <table className="w-full text-left font-mono">
                           <thead className="bg-[#1a1d23] text-[9px] font-bold text-neutral-500">
                             <tr>
                               <th className="p-3">Symbol</th>
                               <th className="p-3">Date</th>
                               <th className="p-3">PnL</th>
                               <th className="p-3">Efficiency</th>
                             </tr>
                           </thead>
                           <tbody className="text-[10px] divide-y divide-tech-border">
                             {tradeHistory.slice(0, 5).map((t, i) => (
                               <tr key={i} className="hover:bg-white/5 transition-all">
                                 <td className="p-3 text-white font-bold">{t.symbol}</td>
                                 <td className="p-3 text-neutral-500">{(t.closedAt?.toDate?.() || new Date()).toLocaleDateString()}</td>
                                 <td className={cn("p-3 font-bold", t.pnl >= 0 ? "text-neon-green" : "text-neon-red")}>{formatCurrency(t.pnl)}</td>
                                 <td className="p-3"><div className="h-1 w-12 bg-neon-green/20 overflow-hidden"><div className="h-full bg-neon-green" style={{ width: '85%' }}></div></div></td>
                               </tr>
                             ))}
                             {tradeHistory.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-neutral-600 uppercase italic">No closed trades recorded yet.</td></tr>}
                           </tbody>
                        </table>
                      </div>
                   </div>
                </div>
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
