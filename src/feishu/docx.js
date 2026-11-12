/**
 * 飞书云文档（docx）封装：创建文档 + 追加文本段落
 */
const client = require('./client');

/** 在文件夹中创建文档，返回 { documentId, url } */
async function createDocument(title, folderToken) {
  const body = { title };
  if (folderToken) body.folder_token = folderToken;
  const r = await client.post('/docx/v1/documents', body);
  const doc = r.data.document;
  return {
    documentId: doc.document_id,
    url: `https://feishu.cn/docx/${doc.document_id}`,
  };
}

/**
 * 在文档末尾追加一个文本段落块
 * block_type 2 = 文本段落
 */
async function appendText(documentId, text, { bold = false } = {}) {
  const children = [{
    block_type: 2,
    text: {
      elements: [{ text_run: { content: text, text_element_style: { bold } } }],
      style: {},
    },
  }];
  // 在根块（document_id 即根 block_id）下追加，index 省略表示末尾
  return client.post(
    `/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
    { children }
  );
}

/** 追加一个标题块（heading2） */
async function appendHeading(documentId, text) {
  const children = [{
    block_type: 4, // heading2
    heading2: { elements: [{ text_run: { content: text } }], style: {} },
  }];
  return client.post(
    `/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
    { children }
  );
}

/** 读取文档纯文本（拼接所有文本块），用于整理时取全文 */
async function getPlainText(documentId) {
  const r = await client.get(`/docx/v1/documents/${documentId}/blocks`, { params: { page_size: 500 } });
  const items = r.data.items || [];
  const lines = [];
  for (const b of items) {
    const blk = b.text || b.heading1 || b.heading2 || b.heading3 || b.bullet || b.ordered;
    if (blk && Array.isArray(blk.elements)) {
      lines.push(blk.elements.map(e => (e.text_run && e.text_run.content) || '').join(''));
    }
  }
  return lines.join('\n');
}

module.exports = { createDocument, appendText, appendHeading, getPlainText };
