import crypto from 'node:crypto';

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Offset (ms) of timezone `tz` at the given UTC instant: wallClockAsUtc - utc
export function tzOffsetMs(tz, utcDate) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(utcDate).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcDate.getTime();
}

// Wall-clock time in `tz` -> UTC Date
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(tz, new Date(guess));
    guess = Date.UTC(y, mo - 1, d, h, mi, s) - off;
  }
  return new Date(guess);
}

// End of local day (23:59:59.999 in tz) for a YYYY-MM-DD date, as UTC Date
export function endOfDayUtc(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return zonedToUtc(y, m, d, 23, 59, 59, tz);
}

export function formatInTz(iso, tz) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate + normalize the due fields of a task/todo block. Throws ApiError(422).
export function normalizeDue({ due_kind, due_date, due_at, due_tz }) {
  const kind = due_kind || 'none';
  if (!['none', 'date', 'datetime'].includes(kind)) {
    throw new ApiError(422, 'due_kind_invalid', `未知截止类型: ${kind}`);
  }
  if (kind === 'none') return { due_kind: 'none', due_date: null, due_at: null, due_tz: null };
  const tz = due_tz || 'Asia/Shanghai';
  if (!isValidTz(tz)) throw new ApiError(422, 'due_tz_invalid', `未知时区: ${tz}`);
  if (kind === 'date') {
    if (!due_date || !DATE_RE.test(due_date)) {
      throw new ApiError(422, 'due_date_invalid', '日期型截止需要 YYYY-MM-DD');
    }
    return { due_kind: 'date', due_date, due_at: null, due_tz: tz };
  }
  // datetime
  if (!due_at || Number.isNaN(Date.parse(due_at))) {
    throw new ApiError(422, 'due_at_invalid', '时刻型截止需要合法时间');
  }
  return { due_kind: 'datetime', due_date: null, due_at: new Date(due_at).toISOString(), due_tz: tz };
}

// Is the task overdue at instant `now`?
// date  -> overdue only after end of that local day in due_tz
// datetime -> overdue after the exact instant
export function isOverdue(task, now = new Date()) {
  if (task.due_kind === 'date') return now > endOfDayUtc(task.due_date, task.due_tz);
  if (task.due_kind === 'datetime') return now > new Date(task.due_at);
  return false;
}

// Human readable due label with explicit timezone semantics
export function dueLabel(task) {
  if (task.due_kind === 'date') return `${task.due_date}（日期型，${task.due_tz} 当日 23:59 截止）`;
  if (task.due_kind === 'datetime') return `${formatInTz(task.due_at, task.due_tz)}（时刻型，${task.due_tz}）`;
  return '未设置';
}
