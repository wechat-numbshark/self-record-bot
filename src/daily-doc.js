/** 当日云文档管理：按天复用，不存在则在指定文件夹新建 */
const docx = require('./feishu/docx');
const store = require('./store');
const { config } = require('./config');
const Logger = require('./logger');

async function getOrCreateDailyDoc(date) {
  const cached = store.getDoc(date);
  if (cached) return cached;
  const { documentId, url } = await docx.createDocument(`记录自己 · ${date}`, config.feishu.docxFolderToken);
  await docx.appendHeading(documentId, `${date} 当日记录`);
  const doc = { documentId, url };
  store.setDoc(date, doc);
  Logger.success(`新建当日云文档 ${date} → ${url}`);
  return doc;
}

module.exports = { getOrCreateDailyDoc };
