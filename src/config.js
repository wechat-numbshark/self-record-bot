/**
 * 全局配置：从 .env 读取 + 读取建表脚本生成的 table-ids.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const TABLE_IDS_PATH = path.join(__dirname, '..', 'table-ids.json');

function loadTableIds() {
  if (fs.existsSync(TABLE_IDS_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(TABLE_IDS_PATH, 'utf8'));
    } catch (e) {
      console.warn('[config] table-ids.json 解析失败:', e.message);
    }
  }
  return null;
}

function saveTableIds(obj) {
  fs.writeFileSync(TABLE_IDS_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

const config = {
  feishu: {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    bitableFolderToken: process.env.BITABLE_FOLDER_TOKEN,
    docxFolderToken: process.env.DOCX_FOLDER_TOKEN,
    baseUrl: 'https://open.feishu.cn/open-apis',
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
    modelSingle: process.env.MODEL_SINGLE || 'z-ai/glm-5.1',
    modelSummary: process.env.MODEL_SUMMARY || 'z-ai/glm-4.6',
    modelVision: process.env.MODEL_VISION || 'z-ai/glm-4.6v',
  },
  cron: {
    daily: process.env.CRON_DAILY || '0 23 * * *',
    dailyLate: process.env.CRON_DAILY_LATE || '0 2 * * *',
    weekly: process.env.CRON_WEEKLY || '0 22 * * 0',
    monthly: process.env.CRON_MONTHLY || '0 3 1 * *',
    tz: process.env.TZ || 'Asia/Shanghai',
  },
  enableInstantReply: String(process.env.ENABLE_INSTANT_REPLY || 'true') === 'true',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  tableIdsPath: TABLE_IDS_PATH,
  loadTableIds,
  saveTableIds,
};

function assertEnv() {
  const missing = [];
  if (!config.feishu.appId) missing.push('FEISHU_APP_ID');
  if (!config.feishu.appSecret) missing.push('FEISHU_APP_SECRET');
  if (!process.env.FEISHU_OWNER_ID) missing.push('FEISHU_OWNER_ID');
  if (missing.length) {
    throw new Error('缺少必要环境变量: ' + missing.join(', ') + '（请复制 .env.example 为 .env 并填写）');
  }
}

module.exports = { config, assertEnv };
