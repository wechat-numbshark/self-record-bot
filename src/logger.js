/** 极简日志：带时间戳 + 级别 */
function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}
const Logger = {
  info: (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  success: (...a) => console.log(`[${ts()}] [ OK ]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${ts()}] [ERR ]`, ...a),
  debug: (...a) => { if (process.env.DEBUG) console.log(`[${ts()}] [DBG ]`, ...a); },
};
module.exports = Logger;
