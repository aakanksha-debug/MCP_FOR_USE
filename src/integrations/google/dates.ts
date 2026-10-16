/** YYYY-MM-DD in UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A date range ending `lagDays` ago. Search Console data usually lags 2-3
 * days, so ranges that end today undercount the last days.
 */
export function recentRange(days: number, lagDays = 3, offsetDays = 0): { startDate: string; endDate: string } {
  const end = new Date(Date.now() - (lagDays + offsetDays) * 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}
