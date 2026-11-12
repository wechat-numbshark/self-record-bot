/** 本地轻量存储：日期 → 当日云文档 映射，避免重复建文档 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'daily-docs.json');

function _read() {
  if (!fs.existsSync(FILE)) return {};
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function _write(obj) { fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8'); }

function getDoc(date) { return _read()[date] || null; }
function setDoc(date, doc) { const all = _read(); all[date] = doc; _write(all); }

module.exports = { getDoc, setDoc };
