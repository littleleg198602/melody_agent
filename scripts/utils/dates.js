const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

export function parseCliArgs(args = process.argv.slice(2)) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--week') parsed.week = args[++i];
    else if (args[i] === '--from') parsed.from = args[++i];
    else if (args[i] === '--to') parsed.to = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  return parsed;
}

function parseDate(value, label) {
  if (!DATE_RE.test(value ?? '')) throw new Error(`Invalid ${label}; expected YYYY-MM-DD, got ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return date;
}

function formatDate(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + days); return d; }

export function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function datesFromIsoWeek(weekId) {
  const match = WEEK_RE.exec(weekId ?? '');
  if (!match) throw new Error(`Invalid ISO week; expected YYYY-Www, got ${weekId}`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) throw new Error(`Invalid ISO week number in ${weekId}`);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = addDays(jan4, 1 - jan4Day);
  const monday = addDays(week1Monday, (week - 1) * 7);
  if (getIsoWeek(monday) !== weekId) throw new Error(`Invalid ISO week for year: ${weekId}`);
  return { week: weekId, date_from: formatDate(monday), date_to: formatDate(addDays(monday, 6)) };
}

export function resolveTargetWeek(args = process.argv.slice(2)) {
  const parsed = Array.isArray(args) ? parseCliArgs(args) : args;
  if ((parsed.from && !parsed.to) || (!parsed.from && parsed.to)) throw new Error('Both --from and --to must be provided together.');
  if (parsed.from && parsed.to) {
    const from = parseDate(parsed.from, '--from');
    const to = parseDate(parsed.to, '--to');
    if (to < from) throw new Error('--to must be on or after --from.');
    return { week: getIsoWeek(from), date_from: formatDate(from), date_to: formatDate(to) };
  }
  if (parsed.week) return datesFromIsoWeek(parsed.week);
  const today = new Date();
  const utcToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const day = utcToday.getUTCDay() || 7;
  const nextMonday = addDays(utcToday, 8 - day);
  return { week: getIsoWeek(nextMonday), date_from: formatDate(nextMonday), date_to: formatDate(addDays(nextMonday, 6)) };
}
