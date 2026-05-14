import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Zap, AlertTriangle, TrendingUp, TrendingDown, Target } from 'lucide-react';
import { cn } from '../lib/utils';

interface Signal {
  id: string;
  symbol: string;
  type: 'RSI_BREAKOUT_UP' | 'RSI_BREAKOUT_DOWN' | 'BULLISH_DIVERGENCE' | 'BEARISH_DIVERGENCE';
  price: number;
  time: string;
  strength: number;
}

interface ScannerAlertsProps {
  signals: Signal[];
  onSelect?: (symbol: string) => void;
}

export const ScannerAlerts: React.FC<ScannerAlertsProps> = ({ signals, onSelect }) => {
  return (
    <div className="bg-tech-surface border border-tech-border flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b border-tech-border bg-[#1a1d23] flex justify-between items-center">
        <h3 className="text-[10px] font-bold text-white uppercase tracking-[0.3em] flex items-center gap-2">
          <Zap size={14} className="text-neon-green fill-neon-green" />
          Real-time Alpha Scanner
        </h3>
        <div className="text-[8px] font-mono text-neutral-500 uppercase tracking-widest bg-tech-bg px-2 py-0.5 border border-tech-border">
          {signals.length} Signals Active
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2">
        <AnimatePresence initial={false}>
          {signals.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-neutral-600 gap-2">
              <div className="w-1 h-1 bg-neutral-800 rounded-full animate-ping" />
              <span className="text-[9px] font-mono uppercase tracking-[0.2em] italic">Scanning F&O Universe...</span>
            </div>
          ) : (
            signals.map((signal) => (
              <motion.div
                key={signal.id}
                initial={{ x: -20, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 20, opacity: 0 }}
                className={cn(
                  "p-3 border cursor-pointer hover:bg-neutral-800 transition-colors relative group",
                  signal.type.includes('BREAKOUT_UP') || signal.type.includes('BULLISH') 
                    ? "border-neon-green/20 bg-neon-green/5" 
                    : "border-neon-red/20 bg-neon-red/5"
                )}
                onClick={() => onSelect?.(signal.symbol)}
              >
                <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity">
                  {signal.type.includes('UP') || signal.type.includes('BULLISH') ? <TrendingUp size={24} /> : <TrendingDown size={24} />}
                </div>

                <div className="flex justify-between items-start mb-2">
                  <div className="flex flex-col">
                    <span className="text-sm font-black text-white tracking-tighter">{signal.symbol}</span>
                    <span className="text-[8px] font-mono text-neutral-500">{signal.time}</span>
                  </div>
                  <div className={cn(
                    "text-[8px] font-black px-1.5 py-0.5 uppercase tracking-tighter",
                    signal.type.includes('UP') || signal.type.includes('BULLISH') ? "bg-neon-green text-black" : "bg-neon-red text-white"
                  )}>
                    {signal.type.replace(/_/g, ' ')}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-mono text-neutral-300">
                    PRICE: <span className="text-white font-bold">₹{signal.price.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex gap-0.5">
                      {[1, 2, 3].map(i => (
                        <div 
                          key={i} 
                          className={cn(
                            "w-1 h-1 rounded-full",
                            i <= signal.strength 
                              ? (signal.type.includes('UP') || signal.type.includes('BULLISH') ? "bg-neon-green" : "bg-neon-red")
                              : "bg-neutral-700"
                          )} 
                        />
                      ))}
                    </div>
                    <span className="text-[8px] font-mono text-neutral-500 font-bold ml-1">STRENGTH</span>
                  </div>
                </div>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>
      
      <div className="p-3 border-t border-tech-border bg-tech-bg/50">
        <button className="w-full py-1.5 text-[8px] font-black uppercase tracking-[.3em] text-neutral-500 border border-dashed border-tech-border hover:text-white hover:border-white transition-all">
          Clear History
        </button>
      </div>
    </div>
  );
};
