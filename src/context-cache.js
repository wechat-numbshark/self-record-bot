/**
 * 用户上下文缓存：每小时从 Bitable 拉一次目标 + 近期复盘，注入 Agent 回复
 */
const bitable = require('./feishu/bitable');
const { config } = require('./config');
const { textVal, numVal } = require('./util/fields');
const Logger = require('./logger');

const TTL = 60 * 60 * 1000; // 1小时

let _cache = { data: null, ts: 0 };

async function getContext(force = false) {
  if (!force && _cache.data && Date.now() - _cache.ts < TTL) return _cache.data;
  try {
    const ids = config.loadTableIds();
    if (!ids) return null;
    const app = ids.appToken;

    // 目标项目表（所有状态）
    const goalRecs = await bitable.searchRecords(app, ids.tables.goals.tableId, {});
    const goals = goalRecs
      .map(r => ({
        name:        textVal(r.fields['目标名称']),
        type:        textVal(r.fields['类型']),
        status:      textVal(r.fields['状态']),
        description: textVal(r.fields['目标描述']),
        progress:    numVal(r.fields['进度']) || 0,
        deadline:    textVal(r.fields['截止日期']),
      }))
      .filter(g => g.name);

    // 每日复盘表（近5天）
    const dailyRecs = await bitable.searchRecords(app, ids.tables.daily.tableId, {});
    const recentDailies = dailyRecs
      .map(r => ({
        date:          textVal(r.fields['日期文本']),
        mood:          textVal(r.fields['情绪总览']),
        overview:      textVal(r.fields['当日概述']),
        blocks:        textVal(r.fields['问题/卡点']),
        evaluation:    textVal(r.fields['当日整体评价']),
        project_focus: textVal(r.fields['项目聚焦']),
      }))
      .filter(d => d.date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5);

    _cache = { data: { goals, recentDailies }, ts: Date.now() };
    Logger.info(`[Context] 刷新：${goals.length} 个目标，${recentDailies.length} 天复盘`);
    return _cache.data;
  } catch (e) {
    Logger.warn('[Context] 刷新失败，使用旧缓存:', e.message);
    return _cache.data || null;
  }
}

/** 整理后主动刷新（让 AI 马上能看到最新复盘） */
function invalidate() { _cache.ts = 0; }

module.exports = { getContext, invalidate };
