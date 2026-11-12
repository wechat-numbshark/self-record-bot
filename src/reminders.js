/**
 * 提醒存储：reminders.json
 * 每条格式：{ id, title, note, remindAt(ms), durationMinutes, done, createdAt(ms) }
 */
const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

const FILE = path.join(__dirname, '..', 'reminders.json');

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) { Logger.warn('[reminders] 读取失败:', e.message); }
  return [];
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
}

/** 解析 "YYYY-MM-DD HH:mm" → ms（上海时区） */
function parseDateTime(str) {
  const s = str.trim().replace('T', ' ').slice(0, 16); // "2026-07-06 09:50"
  const ts = new Date(`${s.replace(' ', 'T')}:00+08:00`).getTime();
  if (isNaN(ts)) throw new Error(`无效的时间格式: ${str}，请用 YYYY-MM-DD HH:mm`);
  return ts;
}

function add({ title, note, remindAt, durationMinutes = 30 }) {
  const list = load();
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title,
    note: note || '',
    remindAt,
    durationMinutes,
    done: false,
    createdAt: Date.now(),
  };
  list.push(item);
  save(list);
  const dt = new Date(remindAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  Logger.info(`[reminders] 已添加: "${title}" @ ${dt}`);
  return item;
}

function getDue() {
  const now = Date.now();
  return load().filter(r => !r.done && r.remindAt <= now);
}

function markDone(id) {
  const list = load();
  const item = list.find(r => r.id === id);
  if (item) { item.done = true; save(list); }
}

function listPending() {
  return load().filter(r => !r.done && r.remindAt > Date.now());
}

module.exports = { add, getDue, markDone, listPending, parseDateTime };
