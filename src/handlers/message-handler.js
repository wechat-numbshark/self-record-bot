/**
 * 处理飞书 im.message.receive_v1 事件
 * 流程：
 *   ① 收到即刻回「收到」
 *   ② 内容处理（语音转文字 / 图片理解）
 *   ③ 写云文档
 *   ④ DeepSeek 分类：摘要/标签/情绪/need_reply/消费提取
 *   ⑤ 若 need_reply → Agent 循环（含工具调用 + 联网搜索）生成有背景的回复
 *   ⑥ 写原始记录表 + 消费记录表
 *   ⑦ 回复「✅ 已记录 + 摘要 + 链接」
 */
const { config } = require('../config');
const Logger = require('../logger');
const owner = require('../owner');
const dateU = require('../util/date');
const bitable = require('../feishu/bitable');
const docx = require('../feishu/docx');
const im = require('../feishu/im');
const speech = require('../feishu/speech');
const ai = require('../ai/openrouter');
const agent = require('../ai/agent');
const prompts = require('../ai/prompts');
const { getOrCreateDailyDoc } = require('../daily-doc');
const contextCache = require('../context-cache');

function mimeOf(name = '') {
  const ext = name.split('.').pop().toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' })[ext] || 'image/jpeg';
}

/** 富文本(post)消息 → 纯文本。content: { title, content: [ [ {tag,text,...}, ... ], ... ] } */
function extractPostText(content) {
  const paras = Array.isArray(content.content) ? content.content : [];
  const lines = paras.map(para =>
    (Array.isArray(para) ? para : [])
      .map(el => (el.tag === 'text' ? el.text : el.tag === 'a' ? (el.text || el.href) : el.tag === 'at' ? `@${el.user_name || ''}` : ''))
      .join('')
  );
  return [content.title, ...lines].filter(Boolean).join('\n');
}

async function handleMessage(event) {
  const senderId = event.sender && event.sender.sender_id && event.sender.sender_id.open_id;
  if (!senderId || senderId !== owner.get()) return;
  const ids = config.loadTableIds();
  if (!ids) { Logger.error('未找到 table-ids.json，请先运行 npm run create-tables'); return; }
  const appToken = ids.appToken;
  const rawTable = ids.tables.raw.tableId;

  const msg = event.message;
  const when = dateU.fromMs(msg.create_time);
  const date = dateU.dateStr(when);
  const time = dateU.timeStr(when);
  let content = {};
  try { content = JSON.parse(msg.content || '{}'); } catch {}

  // ① 即刻确认收到
  im.replyText(msg.message_id, '收到，正在处理…').catch(e => Logger.warn('确认回复失败: ' + e.message));

  // ── 内容处理 ─────────────────────────────────────────────────────────────
  let inputType = '文字';
  let text = '';
  let attachmentToken = null;
  let attachmentName = null;

  try {
    if (msg.message_type === 'text') {
      text = content.text || '';
    } else if (msg.message_type === 'audio') {
      inputType = '语音';
      const buf = await im.downloadResource(msg.message_id, content.file_key, 'file');
      attachmentName = `voice_${msg.message_id}.opus`;
      attachmentToken = await safeUpload(buf, attachmentName, appToken, false);
      text = await speech.recognize(buf).catch(e => {
        Logger.warn('语音识别失败: ' + e.message);
        return '[语音识别失败，请查看附件]';
      });
    } else if (msg.message_type === 'post') {
      text = extractPostText(content);
    } else if (msg.message_type === 'image') {
      inputType = '图片';
      const buf = await im.downloadResource(msg.message_id, content.image_key, 'image');
      attachmentName = `image_${msg.message_id}.jpg`;
      attachmentToken = await safeUpload(buf, attachmentName, appToken, true);
      text = await ai.chatVision(
        config.openrouter.modelVision, prompts.VISION_SYSTEM,
        '请描述这张图片，便于日后检索。',
        [{ base64: buf.toString('base64'), mime: mimeOf(attachmentName) }],
        { maxTokens: 400 }
      ).catch(e => { Logger.warn('图片理解失败: ' + e.message); return '[图片]'; });
    } else {
      text = `[未支持的消息类型: ${msg.message_type}]`;
    }
  } catch (e) {
    Logger.error('消息内容处理失败:', e.message);
    text = text || '[内容处理失败]';
  }

  // ③ 写云文档
  let docUrl = '';
  try {
    const doc = await getOrCreateDailyDoc(date);
    docUrl = doc.url;
    await docx.appendText(doc.documentId, `[${time}] (${inputType}) ${text}`);
  } catch (e) { Logger.warn('写云文档失败: ' + e.message); }

  // ④ DeepSeek 分类（摘要 / 标签 / 情绪 / need_reply / 消费）
  let analysis = { summary: '', tags: [], mood: '', need_reply: false, expenses: [] };
  try {
    const r = await ai.chatJSON(
      config.openrouter.modelSingle,
      prompts.SINGLE_SYSTEM,
      prompts.singleUser(text),
      { maxTokens: 400, temperature: 0.4 }
    );
    if (r) analysis = { ...analysis, ...r };
  } catch (e) { Logger.warn('分类AI失败: ' + e.message); }

  // ④.5 本地兜底：严格区分三类创建意图（飞书任务 / 飞书日程 / 消息提醒），互不混淆。
  // 无条件计算（不能只在 !need_reply 时跑，否则 DeepSeek 已判 need_reply=true 的场景会跳过纠偏）。
  // 每类都由自己明确的关键词触发，绝不互相替代：
  const TASK_INTENT     = /(?:创建|添加|新建|建个|加个|记个|帮.*建|帮.*加).*任务|飞书任务|新建任务|创建任务/;
  const EVENT_INTENT    = /(?:创建|添加|新建|建个|加个|安排个?|帮.*建|帮.*加).*(?:日程|日历)|飞书日程|新建日程|创建日程|记到日历/;
  const REMINDER_INTENT = /提醒我|帮我提醒|提醒一下|定个?提醒|加个?提醒|设个?提醒|消息提醒|到点提醒|到点叫我|闹钟/;
  // 查询类意图（任务/日程/提醒），也需唤醒 agent
  const QUERY_INTENT    = /(?:查|看|有哪些|还有什么|还有啥|哪些没).*(?:任务|日程|日历|提醒)/;

  const taskHit     = TASK_INTENT.test(text);
  const eventHit    = EVENT_INTENT.test(text);
  const reminderHit = REMINDER_INTENT.test(text);
  const queryHit    = QUERY_INTENT.test(text);

  if (!analysis.need_reply && (taskHit || eventHit || reminderHit || queryHit)) {
    analysis.need_reply = true;
    Logger.info(`[classify] 本地检测到意图，强制 need_reply=true (task=${taskHit}, event=${eventHit}, reminder=${reminderHit}, query=${queryHit})`);
  }

  // 路由优先级：谁的关键词更"专属"谁优先——任务 > 日程 > 提醒。
  // 关键：像"新建飞书任务，明天提醒张姐"里"提醒"是任务内容而非意图，任务关键词命中即锁定 create_feishu_task，
  // 不会因内容里的"提醒/日程"字样被抢走。三类严格分开，每类只做自己那一件事（消息提醒不再顺带建日历）。
  // 查询类（"还有哪些飞书任务"）虽含"任务/日程/提醒"字样，但不是创建，绝不强制建，交给 LLM 选 list_* 工具。
  let forceTool = null;
  if (!queryHit) {
    if (taskHit) forceTool = 'create_feishu_task';
    else if (eventHit) forceTool = 'create_feishu_event';
    else if (reminderHit) forceTool = 'create_reminder';
  }

  // ⑤ Agent 回复（仅 need_reply 时，带上下文 + 工具）
  let replyText = '';
  let replySource = '';
  if (config.enableInstantReply && analysis.need_reply) {
    try {
      const ctx = await contextCache.getContext().catch(() => null);
      const sysPrompt = prompts.agentSystem(ctx);
      replyText = await agent.replyWithTools(sysPrompt, text, ids, { forceTool });
      replySource = 'DeepSeek+Agent';
      if (replyText) {
        await im.replyText(msg.message_id, replyText);
        Logger.success(`[Agent] 已回复（${replySource}）`);
      }
    } catch (e) {
      Logger.warn('Agent 回复失败: ' + e.message);
    }
  }

  // ⑥ 写原始记录表
  const fields = {
    '标题':        analysis.summary || text.slice(0, 20) || time,
    '创建时间':    Number(msg.create_time),
    '日期':        date,
    '输入方式':    inputType,
    '原始内容':    text,
    'AI一句话摘要': analysis.summary || '',
    '需要回应':    !!analysis.need_reply,
    'AI回复':      replyText,
    '已处理':      false,
  };
  if (replySource) fields['回复来源'] = replySource.startsWith('DeepSeek') ? 'DeepSeek' : 'Sonnet4.6';
  if (analysis.tags && analysis.tags.length) fields['标签'] = analysis.tags;
  if (analysis.mood) fields['情绪'] = analysis.mood;
  if (docUrl) fields['云文档链接'] = { link: docUrl, text: `${date} 云文档` };
  if (attachmentToken) fields['附件'] = [{ file_token: attachmentToken }];

  let rawRecordId = null;
  try {
    rawRecordId = await bitable.addRecord(appToken, rawTable, fields);
    Logger.success(`已记录一条（${inputType}）：${fields['标题']}`);
    // ⑦ 回复「已记录」确认 + 摘要 + 链接
    const summary = analysis.summary ? `「${analysis.summary}」` : '';
    im.replyText(msg.message_id, `✅ 已记录 ${summary}\n${docUrl}`)
      .catch(e => Logger.warn('记录链接回复失败: ' + e.message));
  } catch (e) { Logger.error('写多维表格失败: ' + e.message); }

  // 消费记录
  const expTable = ids.tables && ids.tables.expense;
  if (expTable && Array.isArray(analysis.expenses) && analysis.expenses.length) {
    for (const exp of analysis.expenses) {
      if (!exp.amount) continue;
      const expFields = {
        '备注':      exp.note || fields['标题'] || '',
        '日期文本':  date,
        '日期':      Number(msg.create_time),
        '金额':      Number(exp.amount) || 0,
        '类别':      exp.category || '其他',
      };
      if (rawRecordId) expFields['关联原始记录'] = [rawRecordId];
      try {
        await bitable.addRecord(appToken, expTable.tableId, expFields);
        Logger.success(`💰 [${exp.category}] ¥${exp.amount} ${exp.note || ''}`);
      } catch (e) { Logger.warn('写消费记录失败: ' + e.message); }
    }
  }
}

async function safeUpload(buf, name, appToken, isImage) {
  try { return await bitable.uploadMedia(buf, name, appToken, isImage); }
  catch (e) { Logger.warn('附件上传失败: ' + e.message); return null; }
}

module.exports = { handleMessage };
