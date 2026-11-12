/** 日期工具（按本机时区） */
function pad(n) { return String(n).padStart(2, '0'); }

function fromMs(ms) { return new Date(Number(ms)); }

function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function timeStr(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dateTimeStr(d = new Date()) {
  return `${dateStr(d)} ${timeStr(d)}`;
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** ISO 周标签 2026-W23 */
function isoWeekLabel(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

/** 给定日期所在 ISO 周的周一~周日（本机日期） */
function weekRange(d = new Date()) {
  const day = (d.getDay() + 6) % 7; // 周一=0
  const monday = addDays(d, -day);
  const sunday = addDays(monday, 6);
  return { start: dateStr(monday), end: dateStr(sunday) };
}

/** 月标签 2026-06 与起止 */
function monthLabel(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function monthRange(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: dateStr(start), end: dateStr(end) };
}

function inRange(ds, start, end) { return ds >= start && ds <= end; }

/**
 * 灵活解析日期/日期时间字符串（上海时区）：
 *   "YYYY-MM-DD"       → { ts: 当天 00:00 的毫秒, allDay: true }
 *   "YYYY-MM-DD HH:mm" → { ts, allDay: false }
 */
function parseFlexible(str) {
  const s = (str || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ts = new Date(`${s}T00:00:00+08:00`).getTime();
    if (isNaN(ts)) throw new Error(`无效的日期格式: ${str}，请用 YYYY-MM-DD`);
    return { ts, allDay: true };
  }
  const norm = s.replace('T', ' ').slice(0, 16);
  const ts = new Date(`${norm.replace(' ', 'T')}:00+08:00`).getTime();
  if (isNaN(ts)) throw new Error(`无效的时间格式: ${str}，请用 YYYY-MM-DD 或 YYYY-MM-DD HH:mm`);
  return { ts, allDay: false };
}

// ── 中文相对日期兜底解析（LLM 偶尔漏抽日期时用）─────────────────────────
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(s) {
  if (s == null || s === '') return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a === '' ? 1 : (CN_NUM[a] ?? NaN);
    const ones = b === '' ? 0 : (CN_NUM[b] ?? NaN);
    if (isNaN(tens) || isNaN(ones)) return NaN;
    return tens * 10 + ones;
  }
  return CN_NUM[s] ?? NaN;
}

/** 上海时区今天的 {y,m,d} */
function shanghaiToday() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function fmt(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 把单个日期片段解析成 YYYY-MM-DD（解析不了返回 null） */
function resolveDatePart(part) {
  const t = (part || '').trim();
  const today = shanghaiToday();
  const rel = { '今天': 0, '今日': 0, '明天': 1, '明日': 1, '后天': 2, '大后天': 3 };
  for (const k of Object.keys(rel)) {
    if (t.includes(k)) {
      const base = new Date(`${fmt(today.y, today.m, today.d)}T00:00:00+08:00`);
      const shifted = addDays(base, rel[k]);
      return fmt(shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate());
    }
  }
  // X月X[号日]
  let m = t.match(/(\d{1,2}|[一二三四五六七八九十]+)月(\d{1,2}|[一二三四五六七八九十]+)[号日]/);
  if (m) {
    const mo = cnToInt(m[1]); const da = cnToInt(m[2]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return fmt(today.y, mo, da);
  }
  // 单独 X[号日]（当月）
  m = t.match(/(\d{1,2}|[一二三四五六七八九十]+)[号日]/);
  if (m) {
    const da = cnToInt(m[1]);
    if (da >= 1 && da <= 31) return fmt(today.y, today.m, da);
  }
  return null;
}

const DATE_TOKEN = /今天|今日|明天|明日|后天|大后天|(?:\d{1,2}|[一二三四五六七八九十]+)月(?:\d{1,2}|[一二三四五六七八九十]+)[号日]|(?:\d{1,2}|[一二三四五六七八九十]+)[号日]/g;

/**
 * 从中文文本里兜底抽取开始/截止日期（纯日期，供全天任务用）。
 * @returns {{ start?: string, due?: string }}  YYYY-MM-DD；抽不到返回 {}
 */
function parseDateHints(text) {
  const s = text || '';
  const tokens = s.match(DATE_TOKEN) || [];
  const dates = tokens.map(resolveDatePart).filter(Boolean);
  if (dates.length === 0) return {};
  const hasRange = /到|至|~|～|—|－|-/.test(s) && dates.length >= 2;
  if (hasRange) {
    // 取前两个日期作为区间；保证 start <= due
    let [a, b] = dates;
    if (a > b) [a, b] = [b, a];
    return { start: a, due: b };
  }
  return { due: dates[0] };
}

module.exports = { fromMs, dateStr, timeStr, dateTimeStr, addDays, isoWeekLabel, weekRange, monthLabel, monthRange, inRange, parseFlexible, parseDateHints };
