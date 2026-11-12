/**
 * 「记录自己」机器人主程序
 * - 飞书长连接（WebSocket）订阅 im.message.receive_v1，无需公网域名
 * - node-cron 定时执行每日/周/月整理
 *
 * 启动：npm start
 */
const lark = require('@larksuiteoapi/node-sdk');
const cron = require('node-cron');
const { config, assertEnv } = require('./src/config');
const Logger = require('./src/logger');
const dateU = require('./src/util/date');
const { handleMessage } = require('./src/handlers/message-handler');
const { summarizeDay, summarizeWeek, summarizeMonth } = require('./src/jobs/summarize');
const reminders = require('./src/reminders');
const im = require('./src/feishu/im');
const owner = require('./src/owner');

// 去重：飞书事件可能重复投递
const seen = new Set();
function once(id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 5000) seen.clear();
  return true;
}

async function main() {
  assertEnv();
  if (!config.loadTableIds()) {
    Logger.warn('⚠ 未检测到 table-ids.json，请先运行：npm run create-tables');
  }

  Logger.info('========================================');
  Logger.info('  记录自己 · 飞书机器人');
  Logger.info(`  即时回复: ${config.enableInstantReply ? '开启(仅提问/情绪低落)' : '关闭'}`);
  Logger.info(`  单条模型: ${config.openrouter.modelSingle}`);
  Logger.info(`  整理模型: ${config.openrouter.modelSummary}`);
  Logger.info('========================================');

  // 1) 事件订阅（长连接）
  const wsClient = new lark.WSClient({ appId: config.feishu.appId, appSecret: config.feishu.appSecret });
  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const msgId = data && data.message && data.message.message_id;
      if (!once(msgId)) return;
      try { await handleMessage(data); }
      catch (e) { Logger.error('处理消息异常:', e.message); }
    },
  });
  wsClient.start({ eventDispatcher });
  Logger.success('飞书长连接已建立，等待消息 ...');

  // 2) 定时任务
  const opt = { timezone: config.cron.tz };

  cron.schedule(config.cron.daily, () => {
    const today = dateU.dateStr(new Date());
    Logger.info(`[cron] 每日整理触发 → ${today}`);
    summarizeDay(today).catch(e => Logger.error('每日整理失败:', e.message));
  }, opt);

  cron.schedule(config.cron.dailyLate, () => {
    const y = dateU.dateStr(dateU.addDays(new Date(), -1));
    Logger.info(`[cron] 凌晨补整理触发 → ${y}（覆盖23点后的消息）`);
    summarizeDay(y).catch(e => Logger.error('补整理失败:', e.message));
  }, opt);

  cron.schedule(config.cron.weekly, () => {
    Logger.info('[cron] 每周整理触发');
    summarizeWeek(new Date()).catch(e => Logger.error('周整理失败:', e.message));
  }, opt);

  cron.schedule(config.cron.monthly, () => {
    const prevMonth = new Date(); prevMonth.setDate(0); // 上月最后一天
    Logger.info(`[cron] 每月整理触发 → ${dateU.monthLabel(prevMonth)}`);
    summarizeMonth(prevMonth).catch(e => Logger.error('月整理失败:', e.message));
  }, opt);

  // 每分钟检查到期提醒
  cron.schedule('* * * * *', async () => {
    const due = reminders.getDue();
    if (!due.length) return;
    const ownerId = owner.get();
    for (const r of due) {
      reminders.markDone(r.id);
      if (!ownerId) { Logger.warn('[reminder] owner_id 未知，无法发送提醒'); continue; }
      const text = [`⏰ 提醒：${r.title}`, r.note ? `📝 ${r.note}` : ''].filter(Boolean).join('\n');
      try {
        await im.sendText(ownerId, text, 'open_id');
        Logger.success(`[reminder] 已发送: ${r.title}`);
      } catch (e) {
        Logger.error('[reminder] 发送失败:', e.message);
      }
    }
  }, opt);

  Logger.success(`定时任务已注册（时区 ${config.cron.tz}）：每日 ${config.cron.daily} / 补 ${config.cron.dailyLate} / 周 ${config.cron.weekly} / 月 ${config.cron.monthly} / 提醒 每分钟`);
  Logger.info('按 Ctrl+C 退出');
}

process.on('uncaughtException', e => Logger.error('未捕获异常:', e.message));
process.on('unhandledRejection', e => Logger.error('未处理拒绝:', e && e.message));
process.on('SIGINT', () => { Logger.info('收到 SIGINT，退出'); process.exit(0); });

main().catch(e => { Logger.error('启动失败:', e.message); process.exit(1); });
