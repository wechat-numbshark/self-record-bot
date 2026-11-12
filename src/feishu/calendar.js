/**
 * 飞书日历封装
 * 所需应用权限（在飞书开放平台 → 权限管理 开启）：
 *   calendar:calendar              （应用权限，读写日历）
 *   calendar:calendar.event:create （创建事件）
 *
 * 工作原理：
 *   1. 首次调用时创建「个人记录提醒」日历，calendar_id 缓存到 .calendar-id
 *   2. 用户在飞书「我的日历」订阅该日历后，即可看到所有事件
 *   3. 创建事件同时将用户添加为参与者，用户会收到日历邀请通知
 */
const client = require('./client');
const Logger = require('../logger');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../../.calendar-id');

async function getOrCreateCalendar() {
  // 读缓存
  if (fs.existsSync(CACHE_FILE)) {
    const id = fs.readFileSync(CACHE_FILE, 'utf8').trim();
    if (id) return id;
  }

  // 查找已有「个人记录提醒」日历
  let existing = null;
  try {
    const r = await client.get('/calendar/v4/calendars', { params: { page_size: 50 } });
    const list = (r.data && r.data.calendar_list) || [];
    existing = list.find(c => c.summary === '个人记录提醒');
  } catch (e) {
    Logger.warn('[Calendar] 查询日历列表失败，将尝试新建:', e.message);
  }

  if (existing) {
    fs.writeFileSync(CACHE_FILE, existing.calendar_id, 'utf8');
    Logger.info(`[Calendar] 复用已有日历: ${existing.calendar_id}`);
    return existing.calendar_id;
  }

  // 新建日历
  const r = await client.post('/calendar/v4/calendars', {
    summary: '个人记录提醒',
    description: 'AI 助手设置的提醒与日程',
    permissions: 'private',
  });
  const calendarId = r.data.calendar.calendar_id;
  fs.writeFileSync(CACHE_FILE, calendarId, 'utf8');
  Logger.success(`[Calendar] 新建日历成功: ${calendarId}`);
  return calendarId;
}

/** 把 { ts(ms), allDay } 转成飞书日程 time 对象（全天用 date，定时用 timestamp，二者互斥） */
function toTimeObj(o) {
  if (o.allDay) {
    return { date: new Date(o.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }), timezone: 'Asia/Shanghai' };
  }
  return { timestamp: String(Math.floor(o.ts / 1000)), timezone: 'Asia/Shanghai' };
}

/**
 * 创建飞书日程/日历事件（同时将用户添加为参与者，触发日历邀请通知）
 * @param {object} opts
 * @param {string}  opts.title
 * @param {string}  [opts.description]
 * @param {{ts:number, allDay:boolean}} opts.start  开始时间（ts 为毫秒）
 * @param {{ts:number, allDay:boolean}} [opts.end]   结束时间；不传则定时事件默认 +30 分钟、全天事件默认当天
 * @param {string}  [opts.attendeeOpenId]  用户 open_id
 * @returns {Promise<string>} eventId
 */
async function createEvent({ title, description, start, end, attendeeOpenId }) {
  const calendarId = await getOrCreateCalendar();
  if (!end) {
    end = start.allDay ? { ts: start.ts, allDay: true } : { ts: start.ts + 30 * 60 * 1000, allDay: false };
  }

  const r = await client.post(`/calendar/v4/calendars/${calendarId}/events`, {
    summary: title,
    description: description || '',
    start_time: toTimeObj(start),
    end_time: toTimeObj(end),
    need_notification: true,
  });

  const eventId = r.data.event.event_id;
  Logger.success(`[Calendar] 事件已创建: ${title} (${eventId})`);

  // 添加用户为参与者
  if (attendeeOpenId) {
    try {
      await client.post(
        `/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees`,
        {
          attendees: [{ type: 'user', user_id: attendeeOpenId }],
          need_notification: true,
        },
        { params: { user_id_type: 'open_id' } }
      );
      Logger.success(`[Calendar] 参与者已添加: ${attendeeOpenId}`);
    } catch (e) {
      Logger.warn('[Calendar] 添加参与者失败（不影响提醒）:', e.message);
    }
  }

  return eventId;
}

/**
 * 查询未来 N 天内的日程
 * @param {object} [opts]
 * @param {number} [opts.days=14]
 * @returns {Promise<Array<{summary:string, start:number, end:number}>>}
 */
async function listEvents({ days = 14 } = {}) {
  const calendarId = await getOrCreateCalendar();
  const now = Math.floor(Date.now() / 1000);
  const endTs = now + days * 86400;

  const r = await client.get(`/calendar/v4/calendars/${calendarId}/events`, {
    params: { start_time: String(now), end_time: String(endTs), page_size: 200 },
  });
  const items = (r.data && r.data.items) || [];
  // 定时事件返回 timestamp(秒)，全天事件返回 date(YYYY-MM-DD)；统一成 {text, allDay}
  const fmt = (t) => {
    if (!t) return null;
    if (t.date) return { text: t.date, allDay: true };
    if (t.timestamp) return { text: new Date(Number(t.timestamp) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }), allDay: false };
    return null;
  };
  return items
    .filter(e => e.status !== 'cancelled')
    .map(e => ({ summary: e.summary, start: fmt(e.start_time), end: fmt(e.end_time) }));
}

/** 删除日程事件（用于测试清理） */
async function deleteEvent(eventId) {
  const calendarId = await getOrCreateCalendar();
  await client.del(`/calendar/v4/calendars/${calendarId}/events/${eventId}`);
  Logger.success(`[Calendar] 事件已删除: ${eventId}`);
}

module.exports = { getOrCreateCalendar, createEvent, listEvents, deleteEvent };
