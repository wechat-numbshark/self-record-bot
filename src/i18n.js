const { config } = require('./config');

const MESSAGES = {
  received: { zh: '收到，正在处理…', en: 'Received. Processing…', ja: '受け取りました。処理中です…' },
  recorded: { zh: '已记录', en: 'Recorded', ja: '記録しました' },
  speechFailed: { zh: '[语音识别失败，请查看附件]', en: '[Speech recognition failed; see attachment]', ja: '[音声認識に失敗しました。添付ファイルをご確認ください]' },
  image: { zh: '[图片]', en: '[Image]', ja: '[画像]' },
  unsupportedType: { zh: '不支持的消息类型', en: 'Unsupported message type', ja: '未対応のメッセージ形式' },
  contentFailed: { zh: '[内容处理失败]', en: '[Content processing failed]', ja: '[内容の処理に失敗しました]' },
};

function text(key) { return MESSAGES[key][config.language]; }
function languageInstruction() {
  return { zh: '请用简体中文回答。', en: 'Respond in English.', ja: '日本語で回答してください。' }[config.language];
}

module.exports = { text, languageInstruction };
