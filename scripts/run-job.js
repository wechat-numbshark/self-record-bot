/**
 * 手动触发整理任务：
 *   node scripts/run-job.js daily [YYYY-MM-DD]
 *   node scripts/run-job.js weekly [YYYY-MM-DD]
 *   node scripts/run-job.js monthly [YYYY-MM-DD]
 * 不传日期则用今天。
 */
const Logger = require('../src/logger');
const { summarizeDay, summarizeWeek, summarizeMonth } = require('../src/jobs/summarize');

async function main() {
  const kind = process.argv[2];
  const dateArg = process.argv[3];
  const ref = dateArg ? new Date(dateArg + 'T12:00:00') : new Date();
  const dateStr = dateArg || require('../src/util/date').dateStr(ref);

  if (kind === 'daily') await summarizeDay(dateStr);
  else if (kind === 'weekly') await summarizeWeek(ref);
  else if (kind === 'monthly') await summarizeMonth(ref);
  else { Logger.error('用法: node scripts/run-job.js <daily|weekly|monthly> [YYYY-MM-DD]'); process.exit(1); }
}

main().catch(e => { Logger.error('任务失败:', e.message); process.exit(1); });
