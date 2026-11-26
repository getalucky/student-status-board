/**
 * 周切分（技术方案 §6.1）。
 *
 * 固定 Asia/Shanghai = UTC+8（无夏令时），周一起点。
 * 做法：把 epoch 平移 +8h 后按 UTC 取年月日，等价于取上海本地时间，
 * 再算回真实 epoch，避免依赖进程时区 / ICU 数据。
 */
import { badRequest } from './errors.js';

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** 0=周日 … 6=周六（上海本地） */
export function shanghaiDayOfWeek(ts) {
  return new Date(ts + SHANGHAI_OFFSET_MS).getUTCDay();
}

/** 1=周一 … 7=周日（上海本地） */
export function shanghaiWeekday(ts) {
  const dow = shanghaiDayOfWeek(ts);
  return dow === 0 ? 7 : dow;
}

/** 上海本地当日 00:00:00.000 的 epoch */
export function shanghaiStartOfDay(ts) {
  const shifted = ts + SHANGHAI_OFFSET_MS;
  const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
  return dayStart - SHANGHAI_OFFSET_MS;
}

/** 所在周的周一 00:00:00.000（上海）的 epoch */
export function startOfWeek(ts) {
  const dow = shanghaiDayOfWeek(ts); // 0..6
  const back = (dow + 6) % 7; // 周一=0
  return shanghaiStartOfDay(ts) - back * DAY_MS;
}

/** 所在周的周日 23:59:59.999（上海）的 epoch */
export function endOfWeek(ts) {
  return startOfWeek(ts) + WEEK_MS - 1;
}

/**
 * 生成区间：本周一往前推 (weeks-1) 周 ～ 本周日 23:59:59.999。
 * @param {number} weeks 1..20
 * @param {number} [now] epoch ms
 */
export function weekRange(weeks, now = Date.now()) {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 20) {
    throw badRequest('weeks 必须是 1~20 的整数', 'INVALID_WEEKS');
  }
  const currentMonday = startOfWeek(now);
  const from = currentMonday - (weeks - 1) * WEEK_MS;
  const to = currentMonday + WEEK_MS - 1;
  return { weeks, from, to, currentMonday };
}

/** 'YYYY-MM-DD' (上海) */
export function formatShanghaiDate(ts) {
  const d = new Date(ts + SHANGHAI_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD HH:mm' (上海) */
export function formatShanghaiDateTime(ts) {
  const d = new Date(ts + SHANGHAI_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${formatShanghaiDate(ts)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 用户录入时间：接受 epoch 毫秒、纯数字串、或 ISO 字符串；缺省用当前时间。
 * @returns {number} epoch ms
 */
export function parseHappenedAt(input, now = Date.now()) {
  if (input === undefined || input === null || input === '') return now;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw badRequest('happened_at 不是合法时间', 'INVALID_HAPPENED_AT');
    // 兼容秒级时间戳（10 位）与毫秒时间戳（13 位）
    return Math.trunc(input > 0 && input < 1e12 ? input * 1000 : input);
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (/^\d{10}$/.test(trimmed)) return Number(trimmed) * 1000; // 秒级时间戳
    if (/^\d{13}$/.test(trimmed)) return Number(trimmed);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw badRequest('happened_at 不是合法时间', 'INVALID_HAPPENED_AT');
}
