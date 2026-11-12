/**
 * 语音识别：飞书 speech_to_text file_recognize（≤60s，pcm/16k）
 * 飞书语音消息是 opus，需先用 ffmpeg 转成 16k 单声道 pcm。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const client = require('./client');
const { config } = require('../config');
const Logger = require('../logger');

/** 用 ffmpeg 把任意音频 Buffer 转成 16k 单声道 pcm Buffer */
function toPcm16k(inputBuffer) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `voice_${crypto.randomUUID()}`);
    const inFile = tmp + '.input';
    const outFile = tmp + '.pcm';
    fs.writeFileSync(inFile, inputBuffer);
    const args = ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', '-f', 's16le', outFile];
    const ff = spawn(config.ffmpegPath, args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('error', err => { cleanup(); reject(new Error(`ffmpeg 启动失败（请确认已安装并配置 FFMPEG_PATH）：${err.message}`)); });
    ff.on('close', code => {
      if (code !== 0) { cleanup(); return reject(new Error(`ffmpeg 转码失败(code ${code}): ${stderr.slice(-300)}`)); }
      try {
        const pcm = fs.readFileSync(outFile);
        cleanup();
        resolve(pcm);
      } catch (e) { cleanup(); reject(e); }
    });
    function cleanup() {
      try { fs.unlinkSync(inFile); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
    }
  });
}

/**
 * 识别语音 Buffer（≤60s），返回识别文本
 * @param {Buffer} audioBuffer 原始音频（opus/其它）
 */
async function recognize(audioBuffer) {
  const pcm = await toPcm16k(audioBuffer);
  const r = await client.post('/speech_to_text/v1/speech/file_recognize', {
    speech: { speech: pcm.toString('base64') },
    config: { file_id: crypto.randomUUID(), format: 'pcm', engine_type: '16k_auto' },
  });
  const text = (r.data && r.data.recognition_text) || '';
  Logger.debug('语音识别结果:', text);
  return text;
}

module.exports = { recognize, toPcm16k };
