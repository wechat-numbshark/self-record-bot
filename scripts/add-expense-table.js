/**
 * 新增消费记录表到已有多维表格 App，并更新 table-ids.json
 * 运行：node scripts/add-expense-table.js
 */
require('dotenv').config();
const { config, assertEnv } = require('../src/config');
const Logger = require('../src/logger');
const bitable = require('../src/feishu/bitable');
const { EXPENSE_CATEGORIES } = require('../src/ai/prompts');
const { FT } = bitable;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  assertEnv();
  const ids = config.loadTableIds();
  if (!ids) { Logger.error('未找到 table-ids.json，请先运行 npm run create-tables'); process.exit(1); }
  if (ids.tables.expense) { Logger.warn('消费记录表已存在，跳过'); return; }

  const appToken = ids.appToken;
  Logger.info('创建消费记录表 ...');

  const { tableId } = await bitable.createTable(appToken, '消费记录表', [
    { field_name: '备注', type: FT.TEXT },   // 主字段
    { field_name: '日期文本', type: FT.TEXT },
    { field_name: '日期', type: FT.DATE, property: { date_formatter: 'yyyy-MM-dd', auto_fill: false } },
    { field_name: '金额', type: FT.NUMBER },
    { field_name: '类别', type: FT.SINGLE, property: { options: EXPENSE_CATEGORIES.map(name => ({ name })) } },
  ]);
  Logger.success(`消费记录表创建成功 table_id=${tableId}`);
  await sleep(500);

  try {
    await bitable.createField(appToken, tableId, {
      field_name: '关联原始记录',
      type: FT.LINK,
      property: { table_id: ids.tables.raw.tableId, multiple: false },
    });
    Logger.success('关联字段创建成功');
  } catch (e) {
    Logger.warn('关联字段创建失败（可网页手动添加）:', e.message);
  }
  await sleep(500);

  const fieldList = await bitable.listFields(appToken, tableId);
  ids.tables.expense = {
    name: '消费记录表',
    tableId,
    fields: Object.fromEntries(fieldList.map(f => [f.field_name, f.field_id])),
  };

  config.saveTableIds(ids);
  Logger.success('table-ids.json 已更新');
  Logger.info(`消费记录表：https://feishu.cn/base/${appToken}?table=${tableId}`);
}

main().catch(e => { Logger.error('失败:', e.message); process.exit(1); });
