/**
 * 定时整理：每日 / 周 / 月（深度整理用 Sonnet 4.6）
 */
const { config } = require('../config');
const Logger = require('../logger');
const bitable = require('../feishu/bitable');
const im = require('../feishu/im');
const ai = require('../ai/openrouter');
const claudeLocal = require('../ai/claude-local');
const prompts = require('../ai/prompts');

// 整理后端：默认走本机 Claude Sonnet 4.6（分析给建议用好模型，不耗 OpenRouter）。
// 设 SUMMARY_BACKEND=openrouter 可退回 GLM/DeepSeek。失败时自动降级到 OpenRouter 兜底。
const SUMMARY_BACKEND = process.env.SUMMARY_BACKEND || 'openrouter';

async function summarizeAI(system, user, opts = {}) {
  if (SUMMARY_BACKEND === 'claude-local') {
    try {
      const r = await claudeLocal.chatJSONLocal(system, user);
      if (r) return r;
      Logger.warn('[整理] 本机 Claude 返回空，降级到 OpenRouter');
    } catch (e) {
      Logger.warn('[整理] 本机 Claude 失败，降级到 OpenRouter: ' + e.message);
    }
  }
  return ai.chatJSON(config.openrouter.modelSummary, system, user, opts);
}
const dateU = require('../util/date');
const { textVal, arrVal, numVal } = require('../util/fields');
const store = require('../store');
const contextCache = require('../context-cache');
const owner = require('../owner');

async function notify(text) {
  const uid = owner.get();
  if (!uid) return;
  await im.sendText(uid, text, 'open_id').catch(e => Logger.warn('推送通知失败: ' + e.message));
}

function ids() {
  const x = config.loadTableIds();
  if (!x) throw new Error('未找到 table-ids.json，请先运行 npm run create-tables');
  return x;
}

function eqFilter(fieldName, value) {
  return { filter: { conjunction: 'and', conditions: [{ field_name: fieldName, operator: 'is', value: [value] }] } };
}

/** 整理某一天 */
async function summarizeDay(date) {
  const I = ids();
  const app = I.appToken;
  const rawT = I.tables.raw.tableId;
  const dailyT = I.tables.daily.tableId;

  const raws = await bitable.searchRecords(app, rawT, eqFilter('日期', date));
  if (!raws.length) { Logger.info(`[每日] ${date} 无记录，跳过`); return; }

  const records = raws.map(r => ({
    time: textVal(r.fields['创建时间']) || '',
    tags: arrVal(r.fields['标签']).join('/'),
    mood: textVal(r.fields['情绪']),
    content: textVal(r.fields['原始内容']),
    reply: textVal(r.fields['AI回复']),
  })).sort((a, b) => a.time.localeCompare(b.time));

  Logger.info(`[每日] 整理 ${date}，共 ${records.length} 条 ...（后端 ${SUMMARY_BACKEND}）`);
  const out = await summarizeAI(prompts.DAILY_SYSTEM, prompts.dailyUser(date, records), { maxTokens: 3000, temperature: 0.6 });
  if (!out) { Logger.warn('[每日] AI 返回为空，跳过写入'); return; }

  const doc = store.getDoc(date);
  const fields = {
    '日期文本': date,
    '日期': new Date(date + 'T12:00:00').getTime(),
    '当日概述': out.overview || '',
    '三件事/亮点': out.highlights || '',
    '主要时间分配': out.time_allocation || '',
    '情绪总览': out.mood_overall || '中性',
    '收获/洞察': out.insights || '',
    '问题/卡点': out.blocks || '',
    '明日计划': out.tomorrow_plan || '',
    '当日整体评价': out.evaluation || '',
    '改进建议': out.suggestions || '',
    '项目聚焦': out.project_focus || '',
    '记录条数': records.length,
    '关联原始记录': raws.map(r => r.record_id),
  };
  if (doc) fields['当日云文档'] = { link: doc.url, text: `${date} 云文档` };

  await upsert(app, dailyT, '日期文本', date, fields);
  // 标记原始记录已处理
  for (const r of raws) {
    if (!boolVal(r.fields['已处理'])) {
      await bitable.updateRecord(app, rawT, r.record_id, { '已处理': true }).catch(() => {});
    }
  }
  Logger.success(`[每日] ${date} 整理完成`);
  contextCache.invalidate();

  const lines = [
    `📋 ${date} 每日复盘`,
    '',
    out.overview || '',
    '',
    out.highlights ? `✨ 亮点\n${out.highlights}` : '',
    out.blocks     ? `🚧 卡点：${out.blocks}` : '',
    out.tomorrow_plan ? `📌 明日：${out.tomorrow_plan}` : '',
    out.evaluation ? `💬 ${out.evaluation}` : '',
  ].filter(l => l !== undefined && !(l === '' && !out.overview));
  await notify(lines.join('\n').trim());
}

/** 整理某周（传入该周内任一日期） */
async function summarizeWeek(anyDateInWeek = new Date()) {
  const I = ids();
  const app = I.appToken;
  const dailyT = I.tables.daily.tableId;
  const periodT = I.tables.period.tableId;
  const label = dateU.isoWeekLabel(anyDateInWeek);
  const { start, end } = dateU.weekRange(anyDateInWeek);

  const dailies = await fetchDailiesInRange(app, dailyT, start, end);
  if (!dailies.length) { Logger.info(`[周] ${label} 无每日数据，跳过`); return; }

  Logger.info(`[周] 整理 ${label}（${start}~${end}），${dailies.length} 天 ...`);
  const out = await summarizeAI(prompts.periodSystem('周'), prompts.periodUser(label, dailies), { maxTokens: 1800, temperature: 0.6 });
  if (!out) return;
  await writePeriod(app, periodT, { label, type: '周', start, end, out, links: dailies.map(d => d.recordId) });
  Logger.success(`[周] ${label} 整理完成`);
  await notify([
    `📊 ${label} 周报`,
    '',
    out.theme ? `主题：${out.theme}` : '',
    out.summary || '',
    '',
    out.highlights ? `✨ 亮点：${out.highlights}` : '',
    out.improvements ? `🔧 下周调整：${out.improvements}` : '',
    out.words_to_self ? `💬 ${out.words_to_self}` : '',
    out.project_priority ? `🎯 项目优先级：\n${out.project_priority}` : '',
  ].filter(Boolean).join('\n').trim());
}

/** 整理某月（传入该月内任一日期） */
async function summarizeMonth(anyDateInMonth = new Date()) {
  const I = ids();
  const app = I.appToken;
  const dailyT = I.tables.daily.tableId;
  const periodT = I.tables.period.tableId;
  const label = dateU.monthLabel(anyDateInMonth);
  const { start, end } = dateU.monthRange(anyDateInMonth);

  const dailies = await fetchDailiesInRange(app, dailyT, start, end);
  if (!dailies.length) { Logger.info(`[月] ${label} 无每日数据，跳过`); return; }

  Logger.info(`[月] 整理 ${label}（${start}~${end}），${dailies.length} 天 ...`);
  const out = await summarizeAI(prompts.periodSystem('月'), prompts.periodUser(label, dailies), { maxTokens: 2000, temperature: 0.6 });
  if (!out) return;
  await writePeriod(app, periodT, { label, type: '月', start, end, out, links: dailies.map(d => d.recordId) });
  Logger.success(`[月] ${label} 整理完成`);
  await notify([
    `🗓️ ${label} 月报`,
    '',
    out.theme ? `主题：${out.theme}` : '',
    out.summary || '',
    '',
    out.goal_progress ? `🎯 目标进展：${out.goal_progress}` : '',
    out.mood_trend ? `💭 情绪趋势：${out.mood_trend}` : '',
    out.improvements ? `🔧 下月调整：${out.improvements}` : '',
    out.words_to_self ? `💬 ${out.words_to_self}` : '',
  ].filter(Boolean).join('\n').trim());
}

// ---- helpers ----
async function fetchDailiesInRange(app, dailyT, start, end) {
  const all = await bitable.searchRecords(app, dailyT, {});
  return all
    .map(r => ({
      recordId: r.record_id,
      date: textVal(r.fields['日期文本']),
      overview: textVal(r.fields['当日概述']),
      highlights: textVal(r.fields['三件事/亮点']),
      blocks: textVal(r.fields['问题/卡点']),
    }))
    .filter(d => d.date && dateU.inRange(d.date, start, end))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function writePeriod(app, periodT, { label, type, start, end, out, links }) {
  const fields = {
    '周期': label,
    '周期类型': type,
    '起始日期': new Date(start + 'T12:00:00').getTime(),
    '结束日期': new Date(end + 'T12:00:00').getTime(),
    '周期主题': out.theme || '',
    '核心总结': out.summary || '',
    '目标进展': out.goal_progress || '',
    '时间投入分析': out.time_trend || '',
    '情绪精力趋势': out.mood_trend || '',
    '亮点': out.highlights || '',
    '改进项': out.improvements || '',
    '给自己的话': out.words_to_self || '',
    '项目优先级': out.project_priority || '',
    '关联每日复盘': links,
  };
  await upsert(app, periodT, '周期', label, fields);
}

function boolVal(v) { return v === true || v === 'true' || v === 1; }

/** 按主键字段查找，存在则更新否则新增 */
async function upsert(app, tableId, keyField, keyValue, fields) {
  const found = await bitable.searchRecords(app, tableId, eqFilter(keyField, keyValue));
  if (found.length) {
    await bitable.updateRecord(app, tableId, found[0].record_id, fields);
  } else {
    await bitable.addRecord(app, tableId, fields);
  }
}

module.exports = { summarizeDay, summarizeWeek, summarizeMonth };
