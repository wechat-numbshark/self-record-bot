/**
 * 一次性建表脚本：
 *   1. 在 BITABLE_FOLDER_TOKEN 指定文件夹创建多维表格 App
 *   2. 创建 4 张表（原始记录 / 每日复盘 / 周月复盘 / 目标项目）及字段
 *   3. 二次补建跨表「关联」字段
 *   4. 结果写入 ../table-ids.json
 *
 * 运行：npm run create-tables
 * 已存在 table-ids.json 时默认跳过，加 --force 可强制重建（会新建一套表）。
 */
const path = require('path');
const { config, assertEnv } = require('../src/config');
const Logger = require('../src/logger');
const bitable = require('../src/feishu/bitable');
const { TAGS } = require('../src/ai/prompts');
const { FT } = bitable;

const moodOptions = [{ name: '积极' }, { name: '中性' }, { name: '消极' }];
const dateProp = (fmt) => ({ date_formatter: fmt, auto_fill: false });

const SCHEMAS = {
  raw: {
    name: '原始记录表',
    fields: [
      { field_name: '标题', type: FT.TEXT },                       // 主字段
      { field_name: '创建时间', type: FT.DATE, property: dateProp('yyyy-MM-dd HH:mm') },
      { field_name: '日期', type: FT.TEXT },                       // YYYY-MM-DD，便于筛选
      { field_name: '输入方式', type: FT.SINGLE, property: { options: [{ name: '语音' }, { name: '文字' }, { name: '图片' }] } },
      { field_name: '原始内容', type: FT.TEXT },
      { field_name: '附件', type: FT.ATTACH },
      { field_name: '云文档链接', type: FT.URL },
      { field_name: 'AI一句话摘要', type: FT.TEXT },
      { field_name: '需要回应', type: FT.CHECKBOX },
      { field_name: 'AI回复', type: FT.TEXT },
      { field_name: '回复来源', type: FT.SINGLE, property: { options: [{ name: 'DeepSeek' }, { name: 'Sonnet4.6' }] } },
      { field_name: '标签', type: FT.MULTI, property: { options: TAGS.map(name => ({ name })) } },
      { field_name: '情绪', type: FT.SINGLE, property: { options: moodOptions } },
      { field_name: '精力值', type: FT.NUMBER },                   // 1-5
      { field_name: '耗时(分钟)', type: FT.NUMBER },
      { field_name: '已处理', type: FT.CHECKBOX },
    ],
  },
  daily: {
    name: '每日复盘表',
    fields: [
      { field_name: '日期文本', type: FT.TEXT },                   // 主字段 YYYY-MM-DD
      { field_name: '日期', type: FT.DATE, property: dateProp('yyyy-MM-dd') },
      { field_name: '当日云文档', type: FT.URL },
      { field_name: '当日概述', type: FT.TEXT },
      { field_name: '三件事/亮点', type: FT.TEXT },
      { field_name: '主要时间分配', type: FT.TEXT },
      { field_name: '情绪总览', type: FT.SINGLE, property: { options: moodOptions } },
      { field_name: '收获/洞察', type: FT.TEXT },
      { field_name: '问题/卡点', type: FT.TEXT },
      { field_name: '明日计划', type: FT.TEXT },
      { field_name: '当日整体评价', type: FT.TEXT },
      { field_name: '改进建议', type: FT.TEXT },
      { field_name: '记录条数', type: FT.NUMBER },
    ],
  },
  period: {
    name: '周月复盘表',
    fields: [
      { field_name: '周期', type: FT.TEXT },                       // 主字段 2026-W23 / 2026-06
      { field_name: '周期类型', type: FT.SINGLE, property: { options: [{ name: '周' }, { name: '月' }] } },
      { field_name: '起始日期', type: FT.DATE, property: dateProp('yyyy-MM-dd') },
      { field_name: '结束日期', type: FT.DATE, property: dateProp('yyyy-MM-dd') },
      { field_name: '周期主题', type: FT.TEXT },
      { field_name: '核心总结', type: FT.TEXT },
      { field_name: '目标进展', type: FT.TEXT },
      { field_name: '时间投入分析', type: FT.TEXT },
      { field_name: '情绪精力趋势', type: FT.TEXT },
      { field_name: '亮点', type: FT.TEXT },
      { field_name: '改进项', type: FT.TEXT },
      { field_name: '给自己的话', type: FT.TEXT },
    ],
  },
  goals: {
    name: '目标项目表',
    fields: [
      { field_name: '目标名称', type: FT.TEXT },                   // 主字段
      { field_name: '类型', type: FT.SINGLE, property: { options: [{ name: '长期目标' }, { name: '项目' }, { name: '习惯' }] } },
      { field_name: '状态', type: FT.SINGLE, property: { options: [{ name: '进行中' }, { name: '已完成' }, { name: '暂停' }] } },
      { field_name: '目标描述', type: FT.TEXT },
      { field_name: '截止日期', type: FT.DATE, property: dateProp('yyyy-MM-dd') },
      { field_name: '进度', type: FT.NUMBER },
    ],
  },
};

async function main() {
  assertEnv();
  const force = process.argv.includes('--force');
  if (config.loadTableIds() && !force) {
    Logger.warn('table-ids.json 已存在，跳过建表。如需强制重建：npm run create-tables -- --force');
    return;
  }
  if (!config.feishu.bitableFolderToken) {
    Logger.warn('未设置 BITABLE_FOLDER_TOKEN，将创建在云空间根目录');
  }

  Logger.info('创建多维表格 App ...');
  const appToken = await bitable.createApp('记录自己', config.feishu.bitableFolderToken);
  Logger.success(`App 创建成功 app_token=${appToken}`);

  const result = { appToken, createdAt: new Date().toISOString(), tables: {} };

  // 创建 4 张表（不含关联字段）
  for (const key of ['raw', 'daily', 'period', 'goals']) {
    const schema = SCHEMAS[key];
    Logger.info(`创建表：${schema.name} ...`);
    const { tableId } = await bitable.createTable(appToken, schema.name, schema.fields);
    result.tables[key] = { name: schema.name, tableId };
    Logger.success(`  ${schema.name} table_id=${tableId}`);
    await sleep(500);
  }

  // 注：新建 App 会带一个默认空表「数据表」，可在网页里手动删除。

  // 二次补建关联字段（type 18 单向关联）
  const links = [
    { from: 'raw', field: '关联目标', to: 'goals' },
    { from: 'daily', field: '关联原始记录', to: 'raw' },
    { from: 'period', field: '关联每日复盘', to: 'daily' },
    { from: 'goals', field: '关联记录', to: 'raw' },
  ];
  for (const lk of links) {
    Logger.info(`补建关联字段：${SCHEMAS[lk.from].name}.${lk.field} → ${SCHEMAS[lk.to].name}`);
    try {
      await bitable.createField(appToken, result.tables[lk.from].tableId, {
        field_name: lk.field,
        type: FT.LINK,
        property: { table_id: result.tables[lk.to].tableId, multiple: true },
      });
      await sleep(500);
    } catch (e) {
      Logger.warn(`  关联字段创建失败（可稍后在网页手动添加）：${e.message}`);
    }
  }

  // 记录每张表的字段名->id 映射，便于排查
  for (const key of Object.keys(result.tables)) {
    const fields = await bitable.listFields(appToken, result.tables[key].tableId);
    result.tables[key].fields = Object.fromEntries(fields.map(f => [f.field_name, f.field_id]));
  }

  config.saveTableIds(result);
  Logger.success(`完成！配置已写入 ${config.tableIdsPath}`);
  Logger.info(`多维表格链接：https://feishu.cn/base/${appToken}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

main().catch(e => { Logger.error('建表失败:', e.message); process.exit(1); });
