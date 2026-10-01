'use strict';
// 截止日期的两种语义：
//  - date：仅日期。表示一个"日历日"，按会议时区解释，没有具体时刻，也不存在 UTC 换算。
//          例如 2026-10-05 于 Asia/Shanghai，即该日全天；对其他时区的人也仍是这张日历日。
//  - datetime：日期+时刻+IANA 时区。录入的是"某地墙上时钟"，服务端归一化为 UTC 时刻存储，
//          导出时可用同一时区还原；比较与逾期判断一律用 UTC 时刻。
const { badRequest } = require('../errors');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

// 输入: { due: '2026-10-05' } 或 { due: '2026-10-05T18:00', tz: 'Asia/Shanghai' }
// 输出: { due_kind, due_date, due_at_utc, due_tz } 或全 null（显式无截止）
function normalizeDeadline(input, meetingTz) {
  if (input == null || input === '' ) return { due_kind: null, due_date: null, due_at_utc: null, due_tz: null };

  const tz = input.tz || meetingTz;
  if (!isValidZone(tz)) throw badRequest(`无效时区: ${tz}`);

  if (DATE_RE.test(input.due)) {
    // 仅日期：不做时刻换算
    return { due_kind: 'date', due_date: input.due, due_at_utc: null, due_tz: null };
  }

  // 带时刻：接受 YYYY-MM-DDTHH:mm(:ss)?
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input.due || '');
  if (!m) throw badRequest(`截止时间格式无效: ${input.due}（应为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm）`);
  const [, ymd, hh, mm, ss] = m;

  // 用当地墙上时钟求 UTC：构造该时区当天 UTC 偏移，处理 DST 回退/跳空。
  const utcMs = wallTimeToUtcMs(ymd, +hh, +mm, +(ss || 0), tz);
  const d = new Date(utcMs);
  return { due_kind: 'datetime', due_date: null, due_at_utc: d.toISOString(), due_tz: tz };
}

// 将某 IANA 时区的墙上时钟稳健地换算为 UTC 毫秒（兼容 DST）
function wallTimeToUtcMs(ymd, hh, mm, ss, tz) {
  const [Y, Mo, D] = ymd.split('-').map(Number);
  // 先按 UTC 拼一个候选，再用该时区的实际偏移校正
  let guess = Date.UTC(Y, Mo - 1, D, hh, mm, ss);
  const offset1 = zoneOffsetMs(guess, tz);
  let corrected = guess - offset1;
  const offset2 = zoneOffsetMs(corrected, tz);
  if (offset2 !== offset1) corrected = guess - offset2; // DST 边界二次校正
  return corrected;
}

function zoneOffsetMs(utcMs, tz) {
  // 取该 UTC 时刻在 tz 的墙上时间，与 UTC 的差
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs));
  const get = t => Number(parts.find(p => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - utcMs;
}

// 展示/导出：把存储行还原为带明确时区解释的字符串
function explainDeadline(task, meetingTz) {
  if (!task.due_kind) return { kind: 'none', text: '无截止日期' };
  if (task.due_kind === 'date') {
    return {
      kind: 'date',
      date: task.due_date,
      text: `${task.due_date}（仅日期，按会议时区 ${meetingTz} 的日历日解释，无具体时刻）`,
    };
  }
  // datetime：用录入时区（缺省退回会议时区）还原墙上时钟
  const tz = task.due_tz || meetingTz;
  const d = new Date(task.due_at_utc);
  const wall = new Intl.DateTimeFormat('sv-SE', { // sv-SE ≈ ISO 风格
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(d).replace(' ', 'T');
  return {
    kind: 'datetime',
    utc: task.due_at_utc,
    tz,
    wall,
    text: `${wall}（${tz} 当地时间；UTC ${task.due_at_utc.replace(/\.\d+Z$/, 'Z')}）`,
  };
}

module.exports = { normalizeDeadline, explainDeadline, isValidZone };
