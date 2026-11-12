/**
 * 飞书 API 统一请求封装：自动带 token、基础错误处理、token 失效重试一次
 */
const axios = require('axios');
const tokenManager = require('./token-manager');
const { config } = require('../config');
const Logger = require('../logger');

const TOKEN_INVALID_CODES = new Set([99991663, 99991661, 99991664]);

async function request(method, apiPath, { params, data, headers, responseType } = {}) {
  const url = apiPath.startsWith('http') ? apiPath : `${config.feishu.baseUrl}${apiPath}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const auth = await tokenManager.authHeaders();
    try {
      const res = await axios({
        method, url, params, data,
        timeout: 30000,
        responseType: responseType || 'json',
        headers: { ...auth, ...(headers || {}) },
        // 上传时由调用方覆盖 Content-Type
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      // 二进制下载直接返回
      if (responseType === 'arraybuffer' || responseType === 'stream') return res.data;
      const body = res.data;
      if (body && typeof body === 'object' && body.code !== undefined && body.code !== 0) {
        if (TOKEN_INVALID_CODES.has(body.code) && attempt === 1) {
          Logger.warn('token 失效，强制刷新后重试');
          tokenManager.token = null;
          continue;
        }
        throw new Error(`飞书API错误 [${method} ${apiPath}] code=${body.code} msg=${body.msg}`);
      }
      return body;
    } catch (e) {
      const detail = e.response && e.response.data ? ` ${JSON.stringify(e.response.data)}` : '';
      if (attempt === 2) { e.message += detail; throw e; }
      Logger.warn(`请求失败重试: ${e.message}${detail}`);
    }
  }
}

module.exports = {
  get: (p, opt) => request('GET', p, opt),
  post: (p, data, opt) => request('POST', p, { ...opt, data }),
  put: (p, data, opt) => request('PUT', p, { ...opt, data }),
  del: (p, opt) => request('DELETE', p, opt),
  request,
};
