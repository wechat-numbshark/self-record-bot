/**
 * OpenRouter 调用封装
 * - chat(): 通用对话，支持指定模型、是否要求 JSON
 * - chatVision(): 带图片（base64）的多模态调用，用于图片理解
 */
const axios = require('axios');
const { config } = require('../config');
const Logger = require('../logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 判断错误是否可重试：网络层错误（无 response）或 408/429/5xx，以及 OpenRouter 偶发的 404 路由抖动
function isRetryable(e) {
  if (!e.response) return true; // 网络错误 / 超时 / TLS 断开
  const s = e.response.status;
  return s === 408 || s === 409 || s === 425 || s === 429 || s === 404 || s >= 500;
}

async function _call(model, messages, { json = false, maxTokens = 2000, temperature = 0.7, retries = 3 } = {}) {
  const body = { model, messages, max_tokens: maxTokens, temperature };
  // response_format: json_object 仅 OpenAI 兼容模型支持；Anthropic/Claude 模型忽略该参数或行为异常，依赖 prompt + safeParse
  if (json && !model.startsWith('anthropic/')) {
    body.response_format = { type: 'json_object' };
    // GLM-5.1 等推理模型默认会先输出大量 reasoning，吃光 max_tokens 导致 JSON 被截断；
    // 结构化抽取不需要可见推理，直接关掉，既防截断又更快更省（非推理模型会忽略此参数）
    body.reasoning = { enabled: false };
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.post(`${config.openrouter.baseUrl}/chat/completions`, body, {
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/self-record-bot',
          'X-Title': 'Self Record Bot',
        },
        timeout: 120000,
      });
      // 部分 provider 在 HTTP 200 下仍把错误塞进 body（无 choices），需显式抛出可读错误
      if (!data.choices || !data.choices[0]) {
        throw new Error(`OpenRouter 返回异常(${model}): ${JSON.stringify(data.error || data).slice(0, 300)}`);
      }
      return data.choices[0].message.content;
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      if (attempt < retries && isRetryable(e)) {
        const wait = 1500 * Math.pow(2, attempt); // 1.5s, 3s, 6s
        Logger.warn(`OpenRouter 调用失败(${model}, status=${status || '网络'}), ${wait}ms 后重试 ${attempt + 1}/${retries}`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** 纯文本对话 */
async function chat(model, system, user, opts = {}) {
  return _call(model, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], opts);
}

/** 要求返回 JSON，自动解析（失败则尝试截取大括号） */
async function chatJSON(model, system, user, opts = {}) {
  const raw = await _call(model, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { ...opts, json: true });
  return safeParse(raw);
}

/** 图片理解：images 为 [{base64, mime}]，prompt 为文字说明 */
async function chatVision(model, system, prompt, images, opts = {}) {
  // 部分多模态模型（如 GLM-4.6V）对「独立 system 角色 + 图片」组合不稳定，偶发 provider 400；
  // 将 system 合并进 user 文本更兼容。
  const content = [{ type: 'text', text: system ? `${system}\n\n${prompt}` : prompt }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } });
  }
  return _call(model, [
    { role: 'user', content },
  ], opts);
}

function safeParse(raw) {
  if (!raw) return null;

  // 提取最合适的 JSON 候选字符串（按优先级）
  const candidates = [];
  candidates.push(raw.trim());
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/gi;
  let m;
  while ((m = fenceRe.exec(raw)) !== null) candidates.push(m[1].trim());
  const objM = raw.match(/\{[\s\S]*\}/);
  if (objM) candidates.push(objM[0]);

  // 直接解析
  for (const s of candidates) {
    try { return JSON.parse(s); } catch {}
  }

  // 修复：模型有时在字符串值内用未转义的 ASCII 双引号，用状态机转义后再试
  for (const s of candidates) {
    try { return JSON.parse(fixUnescapedQuotes(s)); } catch {}
  }

  Logger.warn('JSON 解析失败，原文长度:', raw.length);
  Logger.warn('JSON 解析失败，末尾200字：', raw.slice(-200));
  return null;
}

/** 将 JSON 字符串值内部的未转义双引号转义为 \" */
function fixUnescapedQuotes(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') {
      if (!inStr) { inStr = true; out += c; continue; }
      // 往后找第一个非空白字符，判断这个 " 是关闭字符串还是值内引号
      let j = i + 1;
      while (j < s.length && ' \t\r\n'.includes(s[j])) j++;
      const next = j < s.length ? s[j] : '';
      if (':,}]'.includes(next) || next === '') {
        inStr = false; out += c;
      } else {
        out += '\\"'; // 值内裸引号，转义它
      }
      continue;
    }
    out += c;
  }
  return out;
}

module.exports = { chat, chatJSON, chatVision, safeParse };
