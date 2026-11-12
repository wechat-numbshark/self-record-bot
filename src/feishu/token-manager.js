/**
 * tenant_access_token 管理器：自动获取 + 过期前刷新 + 并发去重
 */
const axios = require('axios');
const { config } = require('../config');
const Logger = require('../logger');

class TokenManager {
  constructor() {
    this.token = null;
    this.expiresAt = 0;
    this.refreshing = null;
    this.preRefreshMs = 5 * 60 * 1000; // 提前 5 分钟刷新
  }

  async getToken() {
    if (this.token && Date.now() < this.expiresAt - this.preRefreshMs) {
      return this.token;
    }
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async _refresh() {
    const url = `${config.feishu.baseUrl}/auth/v3/tenant_access_token/internal`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data } = await axios.post(url, {
          app_id: config.feishu.appId,
          app_secret: config.feishu.appSecret,
        }, { timeout: 10000 });
        if (data.code !== 0) throw new Error(`飞书鉴权失败 ${data.code}: ${data.msg}`);
        this.token = data.tenant_access_token;
        this.expiresAt = Date.now() + (data.expire || 7200) * 1000;
        Logger.success(`tenant_access_token 刷新成功（${data.expire}s 有效）`);
        return this.token;
      } catch (e) {
        Logger.warn(`token 第 ${attempt} 次获取失败: ${e.message}`);
        if (attempt === 3) throw e;
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }

  async authHeaders() {
    const t = await this.getToken();
    return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' };
  }
}

module.exports = new TokenManager(); // 单例
