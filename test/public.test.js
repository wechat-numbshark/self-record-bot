const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handleMessage } = require('../src/handlers/message-handler');

test('unknown sender cannot write personal records', async () => {
  process.env.FEISHU_OWNER_ID = 'ou_synthetic_owner';
  await handleMessage({ sender: { sender_id: { open_id: 'ou_other' } }, message: { message_id: 'demo' } });
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'owner-id.json')), false);
});

test('public example contains no credentials', () => {
  const sample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  for (const key of ['FEISHU_APP_ID','FEISHU_APP_SECRET','FEISHU_OWNER_ID','OPENROUTER_API_KEY','BITABLE_FOLDER_TOKEN','DOCX_FOLDER_TOKEN']) {
    assert.match(sample, new RegExp('^' + key + '=$', 'm'));
  }
});

test('confirmation text follows the selected language', () => {
  const { config } = require('../src/config');
  const { text } = require('../src/i18n');
  const previous = config.language;
  try {
    config.language = 'zh';
    assert.equal(text('recorded'), '已记录');
    config.language = 'en';
    assert.equal(text('recorded'), 'Recorded');
    config.language = 'ja';
    assert.equal(text('recorded'), '記録しました');
  } finally {
    config.language = previous;
  }
});
