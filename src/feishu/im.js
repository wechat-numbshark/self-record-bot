/**
 * IM 封装：下载消息资源（图片/音频/文件）、回复消息
 */
const axios = require('axios');
const tokenManager = require('./token-manager');
const { config } = require('../config');
const client = require('./client');

/**
 * 下载消息中的资源，返回 Buffer
 * @param {string} messageId 消息 ID
 * @param {string} fileKey image_key 或 file_key
 * @param {string} type 'image' | 'file'（音频/文件都用 file）
 */
async function downloadResource(messageId, fileKey, type) {
  const auth = await tokenManager.authHeaders();
  const url = `${config.feishu.baseUrl}/im/v1/messages/${messageId}/resources/${fileKey}`;
  const res = await axios.get(url, {
    params: { type },
    responseType: 'arraybuffer',
    headers: { Authorization: auth.Authorization },
    timeout: 60000,
  });
  return Buffer.from(res.data);
}

/** 回复某条消息（文本） */
async function replyText(messageId, text) {
  return client.post(`/im/v1/messages/${messageId}/reply`, {
    msg_type: 'text',
    content: JSON.stringify({ text }),
  });
}

/** 主动发消息到会话（文本） */
async function sendText(receiveId, text, receiveIdType = 'chat_id') {
  return client.post('/im/v1/messages', {
    receive_id: receiveId,
    msg_type: 'text',
    content: JSON.stringify({ text }),
  }, { params: { receive_id_type: receiveIdType } });
}

module.exports = { downloadResource, replyText, sendText };
