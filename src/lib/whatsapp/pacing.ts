/**
 * Pure WhatsApp pacing math and Africa/Casablanca time calculations.
 * Unit-testable without database or network I/O.
 */

/**
 * Returns date as "YYYY-MM-DD" and minutes from midnight (0..1439)
 * for the given instant in Africa/Casablanca timezone.
 */
export function casablancaParts(now: Date): { date: string; minutes: number } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Casablanca",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(dtf.formatToParts(now).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const minutes = hour * 60 + minute;
  return { date, minutes };
}

/**
 * Parses "YYYY-MM-DD" and "HH:MM" in Africa/Casablanca timezone into a UTC Date object.
 */
export function casablancaDateTimeToDate(dateStr: string, timeStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, min] = timeStr.split(":").map(Number);
  let d = new Date(Date.UTC(year, month - 1, day, hour, min, 0, 0));
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Casablanca",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(dtf.formatToParts(d).map((p) => [p.type, p.value]));
    const diffMin =
      (Date.UTC(year, month - 1, day, hour, min) -
        Date.UTC(
          Number(parts.year),
          Number(parts.month) - 1,
          Number(parts.day),
          Number(parts.hour),
          Number(parts.minute),
        )) /
      60000;
    if (diffMin === 0) break;
    d = new Date(d.getTime() + diffMin * 60000);
  }
  return d;
}

/**
 * Checks if `now` falls in `[start, end)` in Africa/Casablanca time.
 * Supports start < end; if start >= end, treats as always-open (returns true).
 */
export function inWindow(now: Date, start: string, end: string): boolean {
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;

  if (startMin >= endMin) {
    return true;
  }

  const { minutes } = casablancaParts(now);
  return minutes >= startMin && minutes < endMin;
}

/**
 * Next instant when Casablanca local time == start
 * (today if still ahead, else tomorrow).
 */
export function nextWindowOpen(now: Date, start: string): Date {
  const [startH, startM] = start.split(":").map(Number);
  const startMin = startH * 60 + startM;
  const { date, minutes } = casablancaParts(now);

  let targetDate = date;
  if (minutes >= startMin) {
    const [y, m, d] = date.split("-").map(Number);
    const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
    targetDate = nextDay.toISOString().slice(0, 10);
  }

  return casablancaDateTimeToDate(targetDate, start);
}

/**
 * Tomorrow's instant when Casablanca local time == start.
 * Used when daily outbound cap is reached today.
 */
export function tomorrowWindowOpen(now: Date, start: string): Date {
  const { date } = casablancaParts(now);
  const [y, m, d] = date.split("-").map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrowDate = nextDay.toISOString().slice(0, 10);
  return casablancaDateTimeToDate(tomorrowDate, start);
}

/**
 * Generates random gap in milliseconds for integer seconds in [minS, maxS].
 * Takes optional `rnd` function returning [0, 1) for deterministic unit testing.
 */
export function randomGapMs(minS: number, maxS: number, rnd: () => number = Math.random): number {
  if (minS >= maxS) return minS * 1000;
  const r = rnd();
  const sec = Math.min(maxS, Math.max(minS, Math.floor(minS + r * (maxS - minS + 1))));
  return sec * 1000;
}
