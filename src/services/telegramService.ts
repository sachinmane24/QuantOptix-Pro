export async function sendTelegramNotification(message: string) {
  try {
    const response = await fetch('/api/notify/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Failed to send Telegram notification:", errorData);
    }
  } catch (error) {
    console.error("Error sending Telegram notification:", error);
  }
}

export function formatTradeEntry(trade: any) {
  return `
🚀 <b>NEW TRADE EXECUTED</b> 🚀

<b>Symbol:</b> <code>${trade.symbol}</code>
<b>Type:</b> ${trade.type.includes('CE') ? '🟢 CALL' : '🔴 PUT'}
<b>Strike:</b> ${trade.strike}
<b>Entry Price:</b> ₹${trade.entry.toFixed(2)}
<b>Quantity:</b> ${trade.qty}
<b>Capital Deployed:</b> ₹${(trade.entry * trade.qty).toLocaleString()}

🛡 <b>Risk Management:</b>
<b>Stop Loss:</b> ₹${trade.sl.toFixed(2)}
<b>Target 1:</b> ₹${trade.targets[0].toFixed(2)}
<b>Target 2:</b> ₹${trade.targets[1].toFixed(2)}
<b>Target 3:</b> ₹${trade.targets[2].toFixed(2)}

<i>Logic: AI Institutional Breakout detected with high momentum score.</i>
`;
}

export function formatTradeExit(trade: any, exitPrice: number, pnl: number) {
  const isProfit = pnl >= 0;
  return `
🏁 <b>TRADE CLOSED</b> 🏁

<b>Symbol:</b> <code>${trade.symbol}</code>
<b>Status:</b> ${isProfit ? '💰 PROFIT' : '🛑 STOP LOSS / EXIT'}
<b>Entry:</b> ₹${trade.entry.toFixed(2)}
<b>Exit Price:</b> ₹${exitPrice.toFixed(2)}
<b>Net PnL:</b> <b>${isProfit ? '+' : ''}₹${pnl.toLocaleString()}</b>

<b>Session Performance:</b>
Updates available on the Quant Dashboard.
`;
}
