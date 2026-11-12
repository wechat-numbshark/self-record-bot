/**
 * AI Agent：工具定义 + 循环调用（DeepSeek tool calling + Perplexity 联网搜索）
 * 最多迭代 3 次，失败自动降级。
 */
const axios = require('axios');
const { config } = require('../config');
const Logger = require('../logger');
const bitable = require('../feishu/bitable');
const calendar = require('../feishu/calendar');
const task = require('../feishu/task');
const reminders = require('../reminders');
const owner = require('../owner');
const { textVal, numVal } = require('../util/fields');
const dateU = require('../util/date');

// ────────────────────────────────────────────────
// 工具定义
// ────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: '【消息提醒】到指定时间时，机器人给用户发一条飞书消息来提醒。仅当用户明确说"提醒我…""定个提醒""消息提醒""到点叫我"时调用。⚠️它只发消息，绝不创建飞书日程/日历事件，也绝不创建飞书任务——这三者严格分开。用户明确说"日程"就用 create_feishu_event，说"任务"就用 create_feishu_task。',
      parameters: {
        type: 'object',
        properties: {
          title:     { type: 'string', description: '提醒标题（≤30字，简洁）' },
          remind_at: { type: 'string', description: '提醒时间，格式 YYYY-MM-DD HH:mm（上海时区）' },
          note:      { type: 'string', description: '补充说明，可留空' },
        },
        required: ['title', 'remind_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_feishu_event',
      description: '【飞书日程】在飞书日历里创建一个日程事件。仅当用户明确说"新建/创建飞书日程""加个日程""记到日历""安排个日程"时调用。⚠️它只建日历日程，绝不发消息提醒，也绝不创建飞书任务——这三者严格分开。用户明确说"提醒"就用 create_reminder，说"任务"就用 create_feishu_task。\n时间规则（按 system 里的"当前时间"把相对日期换算成 YYYY-MM-DD）：有具体时刻用 YYYY-MM-DD HH:mm；"一整天/全天"用纯日期 YYYY-MM-DD；"从X到Y"填 start_at 和 end_at。',
      parameters: {
        type: 'object',
        properties: {
          title:    { type: 'string', description: '日程标题（简洁）' },
          start_at: { type: 'string', description: '开始时间。定时用 YYYY-MM-DD HH:mm；全天用纯日期 YYYY-MM-DD（上海时区）' },
          end_at:   { type: 'string', description: '结束时间，格式同 start_at。用户没提则省略（定时默认+30分钟，全天默认当天）' },
          note:     { type: 'string', description: '补充说明，可留空' },
        },
        required: ['title', 'start_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_feishu_task',
      description: '【飞书任务】在飞书「任务」App 里创建一条正式待办任务。仅当用户明确说"新建/创建飞书任务""建个任务"时调用。⚠️它只建任务，绝不创建飞书日程/日历事件，也绝不发消息提醒——这三者严格分开。即使句子里出现"提醒/日程"等字（那是任务内容），只要用户说了"任务"就用本工具。用户明确说"日程"才用 create_feishu_event，说"提醒"才用 create_reminder。\n时间处理规则（务必按 system 里给的"当前时间"把相对日期换算成 YYYY-MM-DD）：\n① "从X到Y"这种区间→X填 start_at、Y填 due_at。例：当前是2026-07-08，"从今天到7月15号"→ start_at="2026-07-08", due_at="2026-07-15"。\n② 只有一个时间点→只填 due_at。\n③ "一整天/全天/一天"不带具体时分→用纯日期 YYYY-MM-DD（不要带 HH:mm）。例："明天一整天"（当前2026-07-08）→ start_at="2026-07-09", due_at="2026-07-09"。\n只要用户提到了任何日期/时间，就必须填进 start_at/due_at，不允许丢弃。',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: '任务标题（简洁）' },
          description: { type: 'string', description: '任务备注，可留空' },
          start_at:    { type: 'string', description: '开始时间。全天/整天任务用纯日期 YYYY-MM-DD；有具体时刻用 YYYY-MM-DD HH:mm（上海时区）。用户没提则省略' },
          due_at:      { type: 'string', description: '截止时间。全天/整天任务用纯日期 YYYY-MM-DD；有具体时刻用 YYYY-MM-DD HH:mm（上海时区）。用户没提则省略' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_feishu_tasks',
      description: '查询本机器人创建过的飞书任务（未完成的，或用户明确要求也看已完成的）。用户问"我有哪些任务/还有什么任务没做完"时调用。注意：只能看到机器人创建过的任务，看不到用户在飞书 App 里手动建的。',
      parameters: {
        type: 'object',
        properties: {
          include_completed: { type: 'boolean', description: '是否包含已完成的任务，默认 false' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_calendar_events',
      description: '查询用户未来 N 天内的飞书日程（个人记录提醒日历里的事件）。用户问"我这周/最近有什么日程/安排"时调用。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '查询未来几天，默认 14' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: '查询还没触发的消息提醒（create_reminder 创建的那些）。用户问"还有什么提醒没到/我设了哪些提醒"时调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_goal',
      description: '当用户明确表达想做某事、立了一个目标、或说要开始某个项目时，把它录入目标项目表。录入后告知用户已记录。',
      parameters: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: '目标名称，简洁（≤30字）' },
          type:        { type: 'string', enum: ['长期目标', '项目', '习惯'], description: '目标类型' },
          description: { type: 'string', description: '目标描述，可补充用户原话中的细节' },
          deadline:    { type: 'string', description: '截止日期 YYYY-MM-DD，用户没提则省略' },
        },
        required: ['name', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_goals',
      description: '查看用户当前所有目标和项目的详情（名称、类型、状态、描述、进度、截止日期）。当用户提到某个目标或询问项目进展时使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_records',
      description: '查看用户近 N 天的每日复盘摘要（情绪、概述、卡点、评价、项目聚焦）。了解用户近期状态、重复出现的卡点或情绪趋势时使用。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '查看最近几天，默认 7', default: 7 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网获取实时最新信息。适合：加密货币/股票行情、产品/市场研究、海外资讯、技术文档等需要最新数据的问题。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，尽量精确（中英文均可）' },
        },
        required: ['query'],
      },
    },
  },
];

// ────────────────────────────────────────────────
// 工具执行
// ────────────────────────────────────────────────
async function executeTool(name, args, ids, userMessage) {
  // 【消息提醒】只加本地提醒（到点由 start.js 的 cron 发飞书消息）；绝不碰日历/任务
  if (name === 'create_reminder') {
    let remindAtMs;
    try {
      remindAtMs = reminders.parseDateTime(args.remind_at);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (remindAtMs <= Date.now()) {
      return { ok: false, error: '提醒时间已过，请重新指定未来的时间' };
    }
    const item = reminders.add({ title: args.title, note: args.note || '', remindAt: remindAtMs });
    const dt = new Date(remindAtMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    return { ok: true, id: item.id, remindAt: dt, message: `已设置消息提醒，${dt} 会发飞书消息提醒你。` };
  }

  // 【飞书日程】只建日历事件；绝不加消息提醒/任务
  if (name === 'create_feishu_event') {
    let start, end;
    try {
      start = dateU.parseFlexible(args.start_at);
      if (args.end_at) end = dateU.parseFlexible(args.end_at);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (end && end.ts < start.ts) {
      return { ok: false, error: '结束时间不能早于开始时间，请重新确认' };
    }
    try {
      const eventId = await calendar.createEvent({
        title: args.title,
        description: args.note || '',
        start,
        end,
        attendeeOpenId: owner.get(),
      });
      Logger.success(`[create_feishu_event] 已创建: ${args.title}`);
      return { ok: true, eventId, message: '飞书日程已创建，请在飞书日历「个人记录提醒」里查看。' };
    } catch (e) {
      Logger.warn('[create_feishu_event] 创建失败:', e.message);
      return { ok: false, error: '创建飞书日程失败，请先在飞书开放平台开启 calendar:calendar 权限：' + e.message };
    }
  }

  if (name === 'create_feishu_task') {
    // 兜底：LLM 偶尔会漏抽日期（~1/6 概率），若两个时间都空但原文里有日期表达，本地解析补全
    if (!args.start_at && !args.due_at && userMessage) {
      const hints = dateU.parseDateHints(userMessage);
      if (hints.start) args.start_at = hints.start;
      if (hints.due) args.due_at = hints.due;
      if (hints.start || hints.due) Logger.info('[create_feishu_task] LLM 漏抽日期，本地兜底补全:', JSON.stringify(hints));
    }
    let start, due;
    try {
      if (args.start_at) start = dateU.parseFlexible(args.start_at);
      if (args.due_at) due = dateU.parseFlexible(args.due_at);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // 飞书要求 start/due 的 is_all_day 必须一致；只有一方是纯日期时，把带时间的一方也降级为当天 00:00 全天
    const toAllDay = (dt) => dateU.parseFlexible(new Date(dt.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
    if (start && due && start.allDay !== due.allDay) {
      if (start.allDay) due = toAllDay(due);
      else start = toAllDay(start);
    }
    if (start && due && start.ts > due.ts) {
      return { ok: false, error: '开始时间不能晚于截止时间，请重新确认日期' };
    }

    try {
      const result = await task.createTask({
        title: args.title,
        description: args.description || '',
        start,
        due,
        assigneeOpenId: owner.get(),
      });
      Logger.success(`[create_feishu_task] 已创建: ${args.title}`);
      return { ok: true, guid: result.guid, taskId: result.taskId, message: '飞书任务已创建，请在飞书「任务」App 查看。' };
    } catch (e) {
      Logger.warn('[create_feishu_task] 创建失败:', e.message);
      return { ok: false, error: '创建飞书任务失败，请先在飞书开放平台开启 task:task:write 权限并发布版本：' + e.message };
    }
  }

  if (name === 'list_feishu_tasks') {
    try {
      const tasks = await task.listTasks({ includeCompleted: !!args.include_completed });
      // 全天任务的 timestamp 被飞书锚定在 UTC 零点，只显示日期；定时任务显示完整时刻
      const fmt = (o) => {
        if (!o) return null;
        if (o.allDay) return new Date(o.ts).toLocaleDateString('en-CA', { timeZone: 'UTC' }) + '(全天)';
        return new Date(o.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      };
      return tasks.map(t => ({ title: t.title, start: fmt(t.start), due: fmt(t.due), completed: t.completed }));
    } catch (e) {
      return { error: '查询飞书任务失败: ' + e.message };
    }
  }

  if (name === 'list_calendar_events') {
    try {
      const events = await calendar.listEvents({ days: args.days || 14 });
      return events.map(e => ({
        summary: e.summary,
        start: e.start ? e.start.text + (e.start.allDay ? '(全天)' : '') : null,
        end: e.end ? e.end.text : null,
      }));
    } catch (e) {
      return { error: '查询飞书日程失败: ' + e.message };
    }
  }

  if (name === 'list_reminders') {
    return reminders.listPending().map(r => ({
      title: r.title,
      note: r.note,
      remindAt: new Date(r.remindAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    }));
  }

  if (name === 'add_goal') {
    const fields = {
      '目标名称'  : args.name || '',
      '类型'      : args.type || '项目',
      '状态'      : '进行中',
      '目标描述'  : args.description || '',
    };
    const recordId = await bitable.addRecord(ids.appToken, ids.tables.goals.tableId, fields);
    Logger.success(`[add_goal] 已录入目标：${args.name}`);
    return { ok: true, recordId, message: `已将「${args.name}」录入目标项目表` };
  }

  if (name === 'get_goals') {
    const recs = await bitable.searchRecords(ids.appToken, ids.tables.goals.tableId, {});
    return recs.map(r => ({
      name:        textVal(r.fields['目标名称']),
      type:        textVal(r.fields['类型']),
      status:      textVal(r.fields['状态']),
      description: textVal(r.fields['目标描述']),
      progress:    numVal(r.fields['进度']) || 0,
      deadline:    textVal(r.fields['截止日期']),
    })).filter(g => g.name);
  }

  if (name === 'get_recent_records') {
    const days = Math.min(args.days || 7, 30);
    const cutoff = dateU.dateStr(dateU.addDays(new Date(), -days));
    const recs = await bitable.searchRecords(ids.appToken, ids.tables.daily.tableId, {});
    return recs
      .map(r => ({
        date:          textVal(r.fields['日期文本']),
        mood:          textVal(r.fields['情绪总览']),
        overview:      textVal(r.fields['当日概述']),
        blocks:        textVal(r.fields['问题/卡点']),
        evaluation:    textVal(r.fields['当日整体评价']),
        project_focus: textVal(r.fields['项目聚焦']),
        suggestions:   textVal(r.fields['改进建议']),
      }))
      .filter(d => d.date && d.date >= cutoff)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  if (name === 'web_search') {
    const query = (args.query || '').trim();
    if (!query) return { error: '搜索词为空' };
    try {
      const { data } = await axios.post(
        `${config.openrouter.baseUrl}/chat/completions`,
        {
          model: 'perplexity/sonar-pro',
          messages: [
            { role: 'system', content: '用中文简洁准确总结搜索结果，突出关键数据和最新动态，不超过400字。' },
            { role: 'user', content: query },
          ],
          max_tokens: 600,
        },
        {
          headers: {
            Authorization: `Bearer ${config.openrouter.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/self-record-bot',
            'X-Title': 'Self Record Bot',
          },
          timeout: 30000,
        }
      );
      return { result: data.choices[0].message.content };
    } catch (e) {
      return { error: '搜索失败: ' + e.message };
    }
  }

  return { error: `未知工具: ${name}` };
}

// ────────────────────────────────────────────────
// Agent 主循环
// ────────────────────────────────────────────────
/**
 * 带工具调用的回复生成。
 * @param {string} systemPrompt  包含用户背景的 system prompt
 * @param {string} userMessage   用户本条消息原文
 * @param {object} ids           table-ids.json 内容
 * @param {object} [opts]
 * @param {string|null} [opts.forceTool]  本地正则已明确判定的工具名，首轮强制调用它，避免 LLM 在语义相近工具间选错
 * @param {number}      [opts.maxIter=3]  最大工具调用轮次
 * @returns {Promise<string>}    最终回复文本
 */
// 创建类工具：一条用户消息内每个最多执行一次，防止 Agent 循环里模型重复调用建出多份
const CREATE_TOOLS = new Set(['create_feishu_task', 'create_feishu_event', 'create_reminder']);

async function replyWithTools(systemPrompt, userMessage, ids, opts = {}) {
  const { forceTool = null, maxIter = 3 } = opts;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const executedCreates = new Set(); // 本条消息内已执行过的"工具+标题"签名，同名不同标题（如一次建3个任务）不算重复

  for (let i = 0; i < maxIter; i++) {
    // 只在第一轮强制指定工具；后续轮次放开为 auto，让模型能在复合请求里补充调用别的工具
    const toolChoice = (i === 0 && forceTool) ? { type: 'function', function: { name: forceTool } } : 'auto';
    const { data } = await axios.post(
      `${config.openrouter.baseUrl}/chat/completions`,
      {
        model: config.openrouter.modelSingle,
        messages,
        tools: TOOLS,
        tool_choice: toolChoice,
        max_tokens: 600,
        temperature: 0.3,
        // 关掉推理：GLM-5.1 默认的 reasoning 会吃光 token 预算导致工具调用/回复被截断，
        // 工具路由与参数抽取是结构化任务，不需要可见推理（非推理模型忽略此参数）
        reasoning: { enabled: false },
      },
      {
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/self-record-bot',
          'X-Title': 'Self Record Bot',
        },
        timeout: 60000,
      }
    );

    const choice = data.choices[0];
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (choice.finish_reason === 'tool_calls' && assistantMsg.tool_calls && assistantMsg.tool_calls.length) {
      Logger.info(`[Agent] 工具调用: ${assistantMsg.tool_calls.map(t => t.function.name).join(', ')}`);
      for (const call of assistantMsg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
        let result;
        // 签名 = 工具名 + 标题（归一化），只拦截"同名同标题"的真重复调用；标题不同（如一次建3个任务）各自放行
        const signature = CREATE_TOOLS.has(call.function.name)
          ? `${call.function.name}::${String(args.title || '').trim().toLowerCase()}`
          : null;
        if (signature && executedCreates.has(signature)) {
          // 同一条消息里模型重复调用同一个创建工具且标题相同 → 跳过，避免建出重复项
          result = { ok: true, skipped: true, message: '该项本次已创建，无需重复创建，请直接回复用户已完成。' };
          Logger.warn(`[Agent] 跳过重复创建调用: ${call.function.name} (${args.title || ''})`);
        } else {
          result = await executeTool(call.function.name, args, ids, userMessage);
          if (signature && result && result.ok) executedCreates.add(signature);
          Logger.info(`[Agent] ${call.function.name} → ${JSON.stringify(result).slice(0, 120)}`);
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      // 继续循环，让模型根据工具结果生成回复
    } else {
      return (assistantMsg.content || '').trim();
    }
  }

  // 超过最大轮次，返回最后一条 assistant 内容
  const last = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
  return last ? last.content.trim() : '';
}

module.exports = { replyWithTools, TOOLS, executeTool };
