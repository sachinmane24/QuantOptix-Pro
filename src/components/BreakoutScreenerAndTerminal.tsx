import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Zap, Compass, Target, ArrowUpRight, CheckCircle, AlertTriangle, 
  TrendingUp, TrendingDown, RefreshCw, Layers, ShieldAlert, Play, Hourglass, BarChart3, Flame
} from 'lucide-react';
import { 
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';
import { cn, formatCurrency } from '../lib/utils';

export interface BreakoutTarget {
  symbol: string;
  type: 'BULLISH_BREAKOUT' | 'BEARISH_BREAKOUT';
  spotPrice: number;
  initialSpotPrice: number;
  morningHigh: number;
  morningLow: number;
  pChange: number;
  vwap: number;
  ema20: number;

  support: number;
  resistance: number;
  dayHigh: number;
  dayLow: number;

  optionSymbol: string;
  optionType: 'CE' | 'PE';
  strike: number;
  optionPrice: number;
  optionInitialPrice: number;
  optionPriceHigh: number;
  optionOI: number;
  optionOIPeak: number;
  optionOIBuiltupPercentage: number;
  historicalOI: { time: string; oi: number; price: number }[];
  optionDayHigh: number;
  optionDayLow: number;

  pullbackActive: boolean;
  pullbackPrice: number;
  setupTriggered: boolean;
  tradeExecuted: boolean;
  triggerReason: string;
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
}

interface BreakoutState {
  isEnabled: boolean;
  autoTrigger: boolean;
  targets: BreakoutTarget[];
  dailyTradesCount: number;
  maxTradesPerDay: number;
  scanTimestamp: number;
}

interface BreakoutScreenerAndTerminalProps {
  state: BreakoutState | null;
  onToggleStrategy: (enabled: boolean) => void;
  onToggleAutoTrigger: (enabled: boolean) => void;
  onTriggerScan: () => Promise<void>;
  onManualTrigger: (symbol: string) => void;
  onManualClose: (symbol: string) => void;
}

export const BreakoutScreenerAndTerminal: React.FC<BreakoutScreenerAndTerminalProps> = ({
  state,
  onToggleStrategy,
  onToggleAutoTrigger,
  onTriggerScan,
  onManualTrigger,
  onManualClose
}) => {
  const [scanning, setScanning] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  const handleScan = async () => {
    setScanning(true);
    try {
      await onTriggerScan();
    } catch (err) {
      console.error("Scan error inside component:", err);
    } finally {
      setScanning(false);
    }
  };

  const getStatusLabel = (t: BreakoutTarget) => {
    if (t.exitPrice) return "TRADE_CLOSED";
    if (t.tradeExecuted) return "POSITION_ACTIVE";
    if (t.setupTriggered) return "CONFIRMED_ENTRY";
    if (t.pullbackActive) return "PULLBACK_ZONE";
    return "MONITORING_ORB";
  };

  const selectedTargetData = state?.targets.find(t => t.symbol === selectedTarget) || state?.targets[0] || null;

  return (
    <div className="space-y-6">
      {/* 1. STATE STRATEGIC CONTROL PANEL */}
      <div className="bg-[#0B0E14] border border-tech-border p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-48 h-24 bg-neon-green/5 blur-[80px] pointer-events-none" />
        
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-neon-green animate-ping" />
            <h2 className="text-sm font-black text-white uppercase tracking-[0.2em] flex items-center gap-2">
              <Flame size={16} className="text-neon-green" />
              9:30 AM Breakout Pullback Engine
            </h2>
          </div>
          <p className="text-neutral-500 font-mono text-[9px] uppercase tracking-wider max-w-xl">
            Auto-Scans F&O at 09:30 AM for extreme outliers. Tracks pullback down to EMA20 and confirms
            long option chain buildup before execution. Max 3 trades daily.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {/* Strategy Live Toggle */}
          <div className="flex flex-col gap-1">
            <label className="text-[8px] font-mono font-bold text-neutral-500 tracking-widest uppercase">Strategy Core State</label>
            <div className="flex bg-tech-bg/60 border border-tech-border p-0.5 rounded-sm">
              <button
                onClick={() => onToggleStrategy(true)}
                className={cn(
                  "px-3 py-1 text-[8px] font-bold uppercase transition-all tracking-wider",
                  state?.isEnabled ? "bg-neon-green text-black" : "text-neutral-500 hover:text-white"
                )}
              >
                Active
              </button>
              <button
                onClick={() => onToggleStrategy(false)}
                className={cn(
                  "px-3 py-1 text-[8px] font-bold uppercase transition-all tracking-wider",
                  !state?.isEnabled ? "bg-neon-red text-white font-black" : "text-neutral-500 hover:text-white"
                )}
              >
                Standby
              </button>
            </div>
          </div>

          {/* Auto Entry Toggle */}
          <div className="flex flex-col gap-1">
            <label className="text-[8px] font-mono font-bold text-neutral-500 tracking-widest uppercase">Auto order proxy</label>
            <div className="flex bg-tech-bg/60 border border-tech-border p-0.5 rounded-sm">
              <button
                onClick={() => onToggleAutoTrigger(true)}
                className={cn(
                  "px-3 py-1 text-[8px] font-bold uppercase transition-all tracking-wider",
                  state?.autoTrigger ? "bg-white/10 text-white font-black" : "text-neutral-500 hover:text-white"
                )}
              >
                Auto-On
              </button>
              <button
                onClick={() => onToggleAutoTrigger(false)}
                className={cn(
                  "px-3 py-1 text-[8px] font-bold uppercase transition-all tracking-wider",
                  !state?.autoTrigger ? "bg-amber-500/20 text-amber-500 font-bold" : "text-neutral-500 hover:text-white"
                )}
              >
                Manual
              </button>
            </div>
          </div>

          {/* Trigger Scan Button */}
          <button
            onClick={handleScan}
            disabled={scanning}
            className={cn(
              "px-4 py-2 border text-[9px] font-black uppercase tracking-[0.2em] transition-all flex items-center gap-2",
              scanning 
                ? "bg-white/5 border-tech-border text-neutral-500 cursor-not-allowed" 
                : "bg-neon-green/10 border-neon-green text-neon-green hover:bg-neon-green hover:text-black hover:shadow-[0_0_15px_rgba(0,255,148,0.3)]"
            )}
          >
            <RefreshCw size={12} className={cn("inline", scanning && "animate-spin")} />
            {state?.targets && state.targets.length > 0 ? "Reset & Re-Scan F&O" : "Run 9:30 Breakout Scan"}
          </button>
        </div>
      </div>

      {/* 2. SUMMARY STRATEGY CARD PROGRESS METADATA */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { 
            label: 'Identified Breakout Targets', 
            val: state?.targets ? `${state.targets.length} Stocks` : 'Unscanned', 
            sub: state?.scanTimestamp ? `Scanned: ${new Date(state.scanTimestamp).toLocaleTimeString()}` : 'Click run to start',
            theme: 'border-tech-border'
          },
          { 
            label: 'Today Active Trades Used', 
            val: `${state?.dailyTradesCount || 0} / ${state?.maxTradesPerDay || 3}`, 
            sub: 'Maximum Daily Target Risk Cap',
            theme: (state?.dailyTradesCount || 0) >= (state?.maxTradesPerDay || 3) ? 'border-neon-red/30' : 'border-tech-border'
          },
          { 
            label: 'Sizing Parameters', 
            val: '1 Lot Option ATM', 
            sub: 'Default Fyers Paper-sizing Mode',
            theme: 'border-tech-border'
          },
          { 
            label: 'Execution Time Window', 
            val: '9:30 AM - 11:30 AM', 
            sub: 'Morning Momentum High Probability Period',
            theme: 'border-tech-border'
          },
        ].map((card, idx) => (
          <div key={idx} className={cn("bg-tech-surface border p-4 relative overflow-hidden", card.theme)}>
            <div className="text-[8px] font-mono font-bold text-neutral-500 uppercase tracking-widest mb-1">{card.label}</div>
            <div className="text-lg font-black text-white font-mono tracking-tight">{card.val}</div>
            <div className="text-[9px] text-neutral-400 mt-1">{card.sub}</div>
          </div>
        ))}
      </div>

      {state?.targets && state.targets.length === 0 ? (
        <div className="bg-tech-surface border border-dashed border-tech-border p-12 text-center">
          <Layers size={32} className="mx-auto text-neutral-600 mb-3 animate-pulse" />
          <h3 className="text-xs font-black text-white uppercase tracking-widest mb-1">No Breakout Targets Loaded</h3>
          <p className="text-[10px] text-neutral-500 font-mono max-w-sm mx-auto mb-4">
            The strategy scans at 09:30 AM to isolate extreme price breakouts with matching option volume. Click the scan button above to launch candidate detection.
          </p>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="px-4 py-1.5 bg-white/5 border border-white/15 text-[9px] text-white hover:border-white transition-all font-mono uppercase tracking-widest"
          >
            Initiate Breakout Scan Simulation
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* TRACKED CANDIDATE COLUMNS (LEFT / MID) */}
          <div className="lg:col-span-2 space-y-4">
            <h3 className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest flex items-center gap-2">
              <Compass size={14} className="text-neon-green" />
              Primary Breakout Candidate Monitors
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {state?.targets.map((target) => {
                const step = target.exitPrice ? 4 : target.tradeExecuted ? 3 : target.setupTriggered ? 3 : target.pullbackActive ? 2 : 1;
                const sign = target.type === 'BULLISH_BREAKOUT' ? 1 : -1;
                const distToEma = ((target.spotPrice - target.ema20) / target.spotPrice) * 100;

                return (
                  <div 
                    key={target.symbol}
                    className={cn(
                      "bg-[#0B0E14] border p-4 cursor-pointer hover:border-white/30 transition-all relative flex flex-col justify-between",
                      selectedTarget === target.symbol ? "border-neon-green shadow-[0_0_15px_rgba(0,128,74,0.1)]" : "border-tech-border"
                    )}
                    onClick={() => setSelectedTarget(target.symbol)}
                  >
                    {/* Top Section */}
                    <div>
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-black text-white tracking-tighter">{target.symbol}</span>
                          <span className={cn(
                            "text-[8px] font-black px-1.5 py-0.5",
                            target.type === 'BULLISH_BREAKOUT' ? "bg-neon-green/15 text-neon-green" : "bg-neon-red/15 text-neon-red"
                          )}>
                            {target.type === 'BULLISH_BREAKOUT' ? "CE LONG" : "PE LONG"}
                          </span>
                        </div>
                        
                        <div className={cn(
                          "text-[8px] font-black px-1 border uppercase tracking-wider",
                          getStatusLabel(target) === 'TRADE_CLOSED' ? "border-neutral-700 text-neutral-400 bg-neutral-900" :
                          getStatusLabel(target) === 'POSITION_ACTIVE' ? "border-neon-green bg-neon-green text-black" :
                          getStatusLabel(target) === 'PULLBACK_ZONE' ? "border-amber-500 text-amber-500 bg-amber-500/5 animate-pulse" :
                          "border-tech-border text-white bg-white/5"
                        )}>
                          {getStatusLabel(target)}
                        </div>
                      </div>

                      {/* Detail Metric Columns */}
                      <div className="grid grid-cols-3 gap-2 py-3 border-y border-tech-border/50 text-[10px] font-mono mt-3">
                        <div>
                          <div className="text-neutral-500 text-[8px] uppercase">Spot Price</div>
                          <div className="text-white font-black">₹{target.spotPrice.toFixed(2)}</div>
                          <div className={cn("text-[8px]", target.pChange >= 0 ? "text-neon-green" : "text-neon-red")}>
                            {target.pChange >= 0 ? '+' : ''}{target.pChange.toFixed(2)}%
                          </div>
                        </div>
                        <div>
                          <div className="text-neutral-500 text-[8px] uppercase">9:30 AM Spot</div>
                          <div className="text-neutral-300 font-bold">₹{target.initialSpotPrice.toFixed(2)}</div>
                          <div className="text-[8px] text-neutral-500">Base Reference</div>
                        </div>
                        <div>
                          <div className="text-neutral-500 text-[8px] uppercase">Distance EMA20</div>
                          <div className={cn("font-bold", distToEma <= 0 ? "text-neon-red" : "text-neon-green")}>
                            {distToEma.toFixed(2)}%
                          </div>
                          <div className="text-[8px] text-neutral-500">Pullback Anchor</div>
                        </div>
                      </div>

                      {/* Side Option Chain Details Preview */}
                      <div className="p-2 bg-tech-surface border border-tech-border/80 rounded-sm mt-3 flex justify-between items-center whitespace-nowrap overflow-hidden">
                        <div className="min-w-0">
                          <div className="text-[8px] font-mono text-neutral-500 uppercase">ATM Options Track</div>
                          <div className="font-sans font-bold text-neutral-200 text-[11px] truncate">{target.optionSymbol}</div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="text-[8px] font-mono text-neutral-500 uppercase">Premium (OI % Change)</div>
                          <div className="font-mono text-xs font-black text-neon-green">
                            ₹{target.optionPrice.toFixed(2)}{' '} 
                            <span className="text-[8px] font-normal text-neutral-400">
                              ({target.optionOIBuiltupPercentage >= 0 ? '+' : ''}{target.optionOIBuiltupPercentage.toFixed(1)}%)
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Phase Timelines bar */}
                      <div className="mt-4 space-y-1.5">
                        <div className="flex justify-between text-[8px] font-mono uppercase tracking-widest text-neutral-500">
                          <span>Timeline Stage</span>
                          <span>{step}/4 Completed</span>
                        </div>
                        <div className="grid grid-cols-4 gap-1 h-1.5">
                          {[1, 2, 3, 4].map(idx => (
                            <div 
                              key={idx} 
                              className={cn(
                                "h-full rounded-full transition-colors",
                                idx <= step 
                                  ? (target.type === 'BULLISH_BREAKOUT' ? "bg-neon-green" : "bg-neon-red") 
                                  : "bg-white/5"
                              )} 
                            />
                          ))}
                        </div>
                        <div className="flex justify-between text-[7px] font-mono tracking-tighter text-neutral-400 uppercase">
                          <span className={cn(step >= 1 ? "text-white" : "")}>1. Scanned</span>
                          <span className={cn(step >= 2 ? "text-white" : "")}>2. Pullback</span>
                          <span className={cn(step >= 3 ? "text-white" : "")}>3. Setup Zone</span>
                          <span className={cn(step >= 4 ? "text-white block truncate max-w-[40px]" : "")}>4. Closed</span>
                        </div>
                      </div>
                    </div>

                    {/* Footer Actions */}
                    <div className="border-t border-tech-border mt-4 pt-3 flex items-center justify-between gap-2">
                      <span className="text-[8px] font-mono text-neutral-500 uppercase select-none">
                        ORB Ref High: ₹{target.morningHigh.toFixed(1)}
                      </span>
                      
                      <div className="flex gap-2">
                        {!target.setupTriggered ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); onManualTrigger(target.symbol); }}
                            className="px-2 py-1 text-[8px] font-black uppercase text-amber-500 border border-amber-500/30 hover:bg-amber-500/10 hover:border-amber-500 transition-all flex items-center gap-1"
                          >
                            <Play size={10} />
                            Force Setup
                          </button>
                        ) : target.tradeExecuted && !target.exitPrice ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); onManualClose(target.symbol); }}
                            className="px-2 py-1 text-[8px] font-black uppercase text-neon-red border border-neon-red/30 hover:bg-neon-red/10 hover:border-neon-red transition-all flex items-center gap-1"
                          >
                            <ShieldAlert size={10} />
                            Force Close
                          </button>
                        ) : (
                          <div className="text-[8px] font-mono text-neutral-500 italic uppercase">
                            State Terminated
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* BREAKOUT ACTIVE POSITION REAL-TIME PLACEMENT LIST */}
            <div className="bg-[#0B0E14] border border-tech-border p-4">
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-[10px] font-black text-white uppercase tracking-[0.2em] flex items-center gap-2">
                  <Target size={14} className="text-neon-green" />
                  Active Momentum Contract Monitor
                </h3>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-tech-border/60 text-[8px] font-mono text-neutral-500 uppercase tracking-wider">
                      <th className="pb-2">Underlying</th>
                      <th className="pb-2">Option Instrument</th>
                      <th className="pb-2">Type</th>
                      <th className="pb-2">Entry Premium</th>
                      <th className="pb-2">Current Premium</th>
                      <th className="pb-2">P&L Status (Est.)</th>
                      <th className="pb-2 text-right">Target (+30%) / SL (-15%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state?.targets.filter(t => t.tradeExecuted).length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center py-6 text-neutral-500 font-mono text-[9px] uppercase tracking-[0.1em]">
                          No active trades running under 9:30 AM breakout framework.
                        </td>
                      </tr>
                    ) : (
                      state?.targets.filter(t => t.tradeExecuted).map((target) => {
                        const isWin = target.exitPrice && target.exitPrice > (target.entryPrice || 0);
                        const pointsGained = target.optionPrice - (target.entryPrice || 0);
                        const pctGain = target.entryPrice ? (pointsGained / target.entryPrice) * 100 : 0;
                        const lotMultiplier = 500; // standard simulated lot size
                        const currentPnL = pointsGained * lotMultiplier;

                        return (
                          <tr key={target.symbol} className="border-b border-tech-border/30 text-[10px] font-mono">
                            <td className="py-3 font-bold text-white">{target.symbol}</td>
                            <td className="py-3 text-neutral-300 font-mono">{target.optionSymbol}</td>
                            <td className="py-3">
                              <span className={cn(
                                "px-1 text-[8px] font-bold",
                                target.optionType === 'CE' ? "bg-neon-green/10 text-neon-green" : "bg-neon-red/10 text-neon-red"
                              )}>
                                {target.optionType}
                              </span>
                            </td>
                            <td className="py-3 text-neutral-400">₹{(target.entryPrice || 0).toFixed(2)}</td>
                            <td className="py-3 font-bold text-white">₹{target.optionPrice.toFixed(2)}</td>
                            <td className={cn("py-3 font-bold", currentPnL >= 0 ? "text-neon-green" : "text-neon-red")}>
                              {currentPnL >= 0 ? '+' : ''}₹{currentPnL.toFixed(1)}{' '}
                              <span className="text-[8px] font-normal">
                                ({pctGain.toFixed(1)}%)
                              </span>
                            </td>
                            <td className="py-3 text-right text-[9px] text-neutral-500">
                              {target.exitPrice ? (
                                <span className={cn("font-black uppercase", isWin ? "text-neon-green" : "text-neon-red")}>
                                  CLOSED @ ₹{target.exitPrice.toFixed(1)}
                                </span>
                              ) : (
                                <span>
                                  ₹{((target.entryPrice || 0) * 1.3).toFixed(1)} / ₹{((target.entryPrice || 0) * 0.85).toFixed(1)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* SIDE STUDY SCREEN: OPTION CHAIN ANALYSIS & OI DECK */}
          <div className="bg-[#0B0E14] border border-tech-border p-4 h-full flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center border-b border-tech-border/60 pb-3 mb-4">
                <h3 className="text-[10px] font-black text-white uppercase tracking-[0.2em] flex items-center gap-1">
                  <BarChart3 size={14} className="text-neon-green" />
                  Real-time OI Chain Analysis
                </h3>
              </div>

              {selectedTargetData ? (
                <div className="space-y-4">
                  <div>
                    <h4 className="text-[10px] font-black text-neutral-200 uppercase tracking-widest">{selectedTargetData.symbol} {selectedTargetData.optionSymbol}</h4>
                    <p className="text-[9px] text-neutral-500 font-mono uppercase mt-0.5">
                      Strike Interval ATM Study Base (Strike: {selectedTargetData.strike})
                    </p>
                  </div>

                  {/* Highlight of Option Metrics */}
                  <div className="grid grid-cols-2 gap-2 text-[10px] font-mono bg-tech-surface p-3 border border-tech-border/80">
                    <div>
                      <span className="text-neutral-500 text-[8px] block uppercase">Current Open Interest</span>
                      <span className="text-white font-extrabold font-mono text-xs">{selectedTargetData.optionOI.toLocaleString()} Contracts</span>
                    </div>
                    <div>
                      <span className="text-neutral-500 text-[8px] block uppercase">OI Change from Peak</span>
                      <span className={cn("font-extrabold font-mono text-xs", selectedTargetData.optionOIBuiltupPercentage >= 0 ? "text-neon-green" : "text-neon-red")}>
                        {selectedTargetData.optionOIBuiltupPercentage >= 0 ? '+' : ''}{selectedTargetData.optionOIBuiltupPercentage.toFixed(2)}%
                      </span>
                    </div>
                  </div>

                  {/* CHART OF HISTORICAL OI BUILDFORM */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-[8px] font-mono text-neutral-500 uppercase tracking-widest">
                      <span>Historical OI Trend Accumulation</span>
                      <span className="text-neutral-400">9:30 AM - Live</span>
                    </div>
                    
                    <div className="h-44 w-full bg-tech-bg/50 border border-tech-border flex items-center justify-center relative p-1">
                      {selectedTargetData.historicalOI.length < 2 ? (
                        <div className="text-[8px] font-mono uppercase tracking-[0.15em] text-neutral-600">
                          Accumulating chain coordinates...
                        </div>
                      ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={selectedTargetData.historicalOI} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                            <defs>
                              <linearGradient id="colorOi" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={selectedTargetData.type === 'BULLISH_BREAKOUT' ? "#00FF94" : "#FF3131"} stopOpacity={0.2}/>
                                <stop offset="95%" stopColor={selectedTargetData.type === 'BULLISH_BREAKOUT' ? "#00FF94" : "#FF3131"} stopOpacity={0.0}/>
                              </linearGradient>
                            </defs>
                            <XAxis dataKey="time" stroke="#2a2f3a" fontSize={8} tickLine={false} />
                            <YAxis domain={['auto', 'auto']} stroke="#2a2f3a" fontSize={8} width={30} tickLine={false} />
                            <Tooltip
                              contentStyle={{ backgroundColor: '#0B0E14', border: '1px solid #1a1d23', fontSize: '9px', fontFamily: 'monospace' }}
                              labelStyle={{ color: '#00FF94', fontWeight: 'bold' }}
                            />
                            <Area
                              type="monotone"
                              dataKey="oi"
                              name="Open Interest"
                              stroke={selectedTargetData.type === 'BULLISH_BREAKOUT' ? "#00FF94" : "#FF3131"}
                              strokeWidth={1.5}
                              fillOpacity={1}
                              fill="url(#colorOi)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  </div>

                  {/* Logic explanation box */}
                  <div className="p-3 bg-white/5 border border-white/5 rounded-sm">
                    <div className="text-[8px] font-mono text-neutral-500 uppercase font-black mb-1 flex items-center gap-1">
                      <Hourglass size={10} className="text-neon-green" />
                      Dynamic Strategy Logic
                    </div>
                    <ul className="text-[9px] font-mono text-neutral-400 space-y-1 text-left list-decimal pl-3">
                      <li>Once the ORB High/Low level is isolated by F&O momentum scanners, a breakout is mapped.</li>
                      <li>We monitor a dip (pullback). <strong>Bullish pullbacks</strong> must return towards EMA20/VWAP.</li>
                      <li>During the pullback, we expect smart-money <strong>Option OI Buildup (&gt;2.0%)</strong> to accumulate.</li>
                      <li>The cross-back over EMA20 confirms the swing entry, taking 1 Lot ATM option contract with 30% take-profit target and 15% stop-loss barrier.</li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 text-neutral-600 font-mono text-[9px] uppercase">
                  Select a candidate on the left to analyze real-time Option Chain metrics.
                </div>
              )}
            </div>
            
            <div className="mt-4 pt-3 border-t border-tech-border/50 text-[8px] font-mono text-neutral-500 uppercase text-center leading-relaxed">
              Paper Trading Simulator Active. Sourced via real-time Fyers data structures.
            </div>
          </div>

        </div>
      )}
    </div>
  );
};
