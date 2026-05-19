
// NSE Holidays 2024/2025 (Partial list of main ones)
const MARKET_HOLIDAYS = [
  '2024-01-26', // Republic Day
  '2024-03-08', // Mahashivratri
  '2024-03-25', // Holi
  '2024-03-29', // Good Friday
  '2024-04-11', // Eid-ul-Fitr
  '2024-04-17', // Ram Navami
  '2024-05-01', // Maharashtra Day
  '2024-06-17', // Bakri Id
  '2024-07-17', // Muharram
  '2024-08-15', // Independence Day
  '2024-10-02', // Gandhi Jayanti
  '2024-11-01', // Diwali Laxmi Pujan (Special Muhurat Trading happens, but treated as holiday for full day)
  '2024-11-15', // Gurunanak Jayanti
  '2024-12-25', // Christmas
  // 2025
  '2025-01-26',
  '2025-08-15',
  '2025-10-02',
];

export function isMarketOpen(date: Date = new Date()): { open: boolean, reason: string } {
  // Convert current time to IST components
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = istFormatter.formatToParts(date);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hours = parseInt(getPart('hour'));
  const minutes = parseInt(getPart('minute'));
  const datePart = `${year}-${month}-${day}`;
  const dayName = istFormatter.formatToParts(date).find(p => p.type === 'weekday')?.value || '';

  // Check Weekends
  const dayOfWeek = date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  if (dayOfWeek === 'Sat' || dayOfWeek === 'Sun') {
    return { open: false, reason: 'Weekend' };
  }

  // Check Holidays
  if (MARKET_HOLIDAYS.includes(datePart)) {
    return { open: false, reason: 'Market Holiday' };
  }

  // Check Hours (9:15 AM to 3:30 PM IST)
  const currentTime = hours * 100 + minutes;
  if (currentTime < 915) {
    return { open: false, reason: 'Market not yet open (Opens at 09:15 IST)' };
  }
  if (currentTime >= 1530) {
    return { open: false, reason: 'Market closed (Closes at 15:30 IST)' };
  }

  return { open: true, reason: 'Market session active' };
}

export function isLoginTime(date: Date = new Date()): boolean {
  const istTime = date.toLocaleTimeString('en-US', { 
    timeZone: 'Asia/Kolkata', 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  return istTime === '08:55';
}
