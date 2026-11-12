/**
 * 可选的本机 Claude 整理后端
 *
 * 用途：每日/周/月这种"分析+给建议"的低频高价值任务，用更成熟的
 * Claude Sonnet 4.6。通过本机 `claude -p --model sonnet --output-format json`
 * 调用，返回 JSON。绕开了 OpenRouter 对 Anthropic 的隐私限制，也不花 API 钱。
 *
 * 模型分工（示例配置）：
 *   - 路由/单条记录摘要 → DeepSeek（openrouter.js，便宜高频）
 *   - 分析给建议/日周月整理 → 本机 Claude Sonnet 4.6（本模块）
 */
const { spawn } = require('child_process');
const os = require('os');
const Logger = require('../logger');
const { safeParse } = require('./openrouter');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.CLAUDE_SUMMARY_MODEL || 'sonnet'; // sonnet = claude-sonnet-4-6
const TIMEOUT_MS = Number(process.env.CLAUDE_SUMMARY_TIMEOUT_MS || 180000); // 3 分钟
// 在 tmp 目录运行：避免加载某项目的 CLAUDE.md 把"操作手册"注入整理任务
const RUN_DIR = process.env.CLAUDE_SUMMARY_DIR || os.tmpdir();

function childEnv() {
  // pm2 下 PATH 常不全；补上常用目录
  const home = os.homedir();
  const extra = [`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return { ...process.env, PATH: [...extra, process.env.PATH || ''].filter(Boolean).join(':'), HOME: home };
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    // --strict-mcp-config + 空配置：不加载任何 MCP/工具，纯文本生成，快且干净
    const args = ['-p', '--model', MODEL, '--output-format', 'json', prompt];
    const child = spawn(CLAUDE_BIN, args, { cwd: RUN_DIR, env: childEnv(), shell: false });

    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`本机 Claude 整理超时（>${Math.round(TIMEOUT_MS / 1000)}s）`));
    }, TIMEOUT_MS);

    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => { if (done) return; done = true; clearTimeout(timer); reject(new Error(`无法启动本机 claude: ${e.message}`)); });
    child.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      if (code !== 0) return reject(new Error(`本机 claude 返回码 ${code}: ${(err || out).slice(-300)}`));
      // 解析外层信封，取 .result（即模型输出文本）
      try {
        const env = JSON.parse(out.trim());
        if (env && typeof env.result === 'string') return resolve(env.result);
        // 兜底：信封异常时直接返回原文
        return resolve(out.trim());
      } catch {
        return resolve(out.trim());
      }
    });
  });
}

/**
 * 要求返回 JSON，自动解析。签名与 openrouter.chatJSON 对齐，便于替换。
 * @param {string} system
 * @param {string} user
 */
async function chatJSONLocal(system, user) {
  const prompt =
    `${system}\n\n========\n\n${user}\n\n` +
    `（重要：只输出符合上面要求的 JSON 对象本身，不要 markdown 代码块，不要任何解释文字。）`;
  const raw = await callClaude(prompt);
  const parsed = safeParse(raw);
  if (!parsed) Logger.warn('[claude-local] JSON 解析失败，末尾200字：' + (raw || '').slice(-200));
  return parsed;
}

module.exports = { chatJSONLocal, MODEL };
