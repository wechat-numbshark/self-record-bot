/**
 * 飞书任务（Task）封装
 * 所需应用权限（在飞书开放平台 → 权限管理 开启）：
 *   task:task:write      （创建/更新/删除/查询任务，二选一）
 *   task:task:writeonly  （仅创建/更新任务，不含查询——若要用 listTasks/getTask 请选 task:task:write）
 *
 * 工作原理：
 *   1. 创建任务：POST /task/v2/tasks，把用户设为负责人（members.role=assignee）。
 *      不挂 tasklist，任务会出现在用户飞书「任务」App 的「我负责的」列表里。
 *   2. 查询单条：GET /task/v2/tasks/:guid，tenant_access_token 可用。
 *   3. 查询列表：飞书官方的"我的任务"列表接口（type=my_tasks）只支持 user_access_token，
 *      本项目走 tenant_access_token 免用户登录的架构用不了。改为本地维护 tasks.json 台账
 *      （记录本机器人创建过的任务 guid），查询时台账取 guid 列表 → 逐个 GET 刷新实时状态。
 *      局限：只能看到机器人创建过的任务，看不到用户在飞书 App 里手动建的。
 */
const fs = require('fs');
const path = require('path');
const client = require('./client');
const Logger = require('../logger');

const LEDGER_FILE = path.join(__dirname, '../../tasks.json');

function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_FILE)) return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch (e) { Logger.warn('[Task] 台账读取失败:', e.message); }
  return [];
}

function saveLedger(list) {
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(list, null, 2), 'utf8');
}

/**
 * 创建一条飞书任务
 * @param {object} opts
 * @param {string}  opts.title
 * @param {string}  [opts.description]
 * @param {{ts:number, allDay:boolean}} [opts.start]  开始时间，不传则任务无起始时间
 * @param {{ts:number, allDay:boolean}} [opts.due]     截止时间，不传则任务无截止时间
 * @param {string}  [opts.assigneeOpenId]  负责人 open_id
 * @returns {Promise<{guid: string, taskId: string}>}
 */
async function createTask({ title, description, start, due, assigneeOpenId }) {
  const body = {
    summary: title,
    description: description || '',
  };
  if (start) body.start = { timestamp: String(start.ts), is_all_day: start.allDay };
  if (due) body.due = { timestamp: String(due.ts), is_all_day: due.allDay };
  if (assigneeOpenId) {
    body.members = [{ id: assigneeOpenId, type: 'user', role: 'assignee' }];
  }

  const r = await client.post('/task/v2/tasks', body, { params: { user_id_type: 'open_id' } });
  const task = r.data.task;
  Logger.success(`[Task] 已创建: ${title} (${task.guid})`);

  const ledger = loadLedger();
  ledger.push({ guid: task.guid, taskId: task.task_id, title, createdAt: Date.now() });
  saveLedger(ledger);

  return { guid: task.guid, taskId: task.task_id };
}

/**
 * 查询单条任务的实时状态
 * @param {string} guid
 */
async function getTask(guid) {
  const r = await client.get(`/task/v2/tasks/${guid}`, { params: { user_id_type: 'open_id' } });
  return r.data.task;
}

/**
 * 查询本机器人创建过的任务（本地台账 + 逐条刷新实时状态）
 * @param {object} [opts]
 * @param {boolean} [opts.includeCompleted=false]
 * @param {number}  [opts.limit=20]  最多刷新最近的几条（台账倒序取）
 */
async function listTasks({ includeCompleted = false, limit = 20 } = {}) {
  const ledger = loadLedger();
  const recent = [...ledger].reverse().slice(0, limit);
  const results = [];
  for (const entry of recent) {
    let task;
    try {
      task = await getTask(entry.guid);
    } catch (e) {
      Logger.warn(`[Task] 刷新 ${entry.guid} 失败（可能已被删除）:`, e.message);
      continue;
    }
    const completed = !!(task.completed_at && task.completed_at !== '0');
    if (completed && !includeCompleted) continue;
    const timeObj = (t) => t && t.timestamp ? { ts: Number(t.timestamp), allDay: !!t.is_all_day } : null;
    results.push({
      title: task.summary,
      start: timeObj(task.start),
      due: timeObj(task.due),
      completed,
    });
  }
  return results;
}

/** 删除任务（用于测试清理） */
async function deleteTask(guid) {
  await client.del(`/task/v2/tasks/${guid}`);
  Logger.success(`[Task] 已删除: ${guid}`);
}

module.exports = { createTask, getTask, listTasks, deleteTask };
