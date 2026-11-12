/**
 * 多维表格封装：创建 App / 表 / 字段，读写记录，上传附件
 * 字段类型参考：1 文本 2 数字 3 单选 4 多选 5 日期 7 复选框
 *               15 超链接 17 附件 18 单向关联
 */
const FormData = require('form-data');
const axios = require('axios');
const client = require('./client');
const tokenManager = require('./token-manager');
const { config } = require('../config');

const FT = { TEXT: 1, NUMBER: 2, SINGLE: 3, MULTI: 4, DATE: 5, CHECKBOX: 7, URL: 15, ATTACH: 17, LINK: 18 };

/** 在指定文件夹创建多维表格 App，返回 app_token */
async function createApp(name, folderToken) {
  const body = { name };
  if (folderToken) body.folder_token = folderToken;
  const r = await client.post('/bitable/v1/apps', body);
  return r.data.app.app_token;
}

/** 创建数据表（可带初始字段，第一个字段为主字段，须为文本类）。返回 { tableId } */
async function createTable(appToken, name, fields) {
  const body = { table: { name, default_view_name: '表格', fields } };
  const r = await client.post(`/bitable/v1/apps/${appToken}/tables`, body);
  return { tableId: r.data.table_id };
}

/** 列出表字段，返回 [{field_id, field_name, type}] */
async function listFields(appToken, tableId) {
  const r = await client.get(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, { params: { page_size: 100 } });
  return r.data.items || [];
}

/** 新增字段，返回 field_id */
async function createField(appToken, tableId, field) {
  const r = await client.post(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, field);
  return r.data.field.field_id;
}

/** 新增记录，返回 record_id */
async function addRecord(appToken, tableId, fields) {
  const r = await client.post(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, { fields });
  return r.data.record.record_id;
}

/** 更新记录 */
async function updateRecord(appToken, tableId, recordId, fields) {
  return client.put(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, { fields });
}

/** 按条件搜索记录（filter 见飞书文档）。返回 items 数组 */
async function searchRecords(appToken, tableId, filter, pageSize = 200) {
  const items = [];
  let pageToken;
  do {
    const params = { page_size: pageSize };
    if (pageToken) params.page_token = pageToken;
    const r = await client.post(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`, filter || {}, { params });
    items.push(...(r.data.items || []));
    pageToken = r.data.has_more ? r.data.page_token : null;
  } while (pageToken);
  return items;
}

/**
 * 上传素材到多维表格附件字段，返回 file_token
 * @param {Buffer} buffer 文件内容
 * @param {string} fileName 文件名（含扩展名）
 * @param {string} appToken 作为 parent_node
 * @param {boolean} isImage 图片用 bitable_image，其它用 bitable_file
 */
async function uploadMedia(buffer, fileName, appToken, isImage = false) {
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', isImage ? 'bitable_image' : 'bitable_file');
  form.append('parent_node', appToken);
  form.append('size', String(buffer.length));
  form.append('file', buffer, { filename: fileName });

  const auth = await tokenManager.authHeaders();
  const { data } = await axios.post(
    `${config.feishu.baseUrl}/drive/v1/medias/upload_all`,
    form,
    { headers: { ...form.getHeaders(), Authorization: auth.Authorization }, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 60000 }
  );
  if (data.code !== 0) throw new Error(`上传素材失败 ${data.code}: ${data.msg}`);
  return data.data.file_token;
}

module.exports = {
  FT, createApp, createTable, listFields, createField,
  addRecord, updateRecord, searchRecords, uploadMedia,
};
