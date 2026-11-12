/** 多维表格字段值读取兼容（文本字段可能返回数组段落） */
function textVal(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    return v.map(seg => {
      if (typeof seg === 'string') return seg;
      if (seg && typeof seg === 'object') return seg.text || seg.name || '';
      return '';
    }).join('');
  }
  if (typeof v === 'object') return v.text || v.name || '';
  return '';
}

function arrVal(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : (x.text || x.name || ''))).filter(Boolean);
  return [textVal(v)].filter(Boolean);
}

function numVal(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(textVal(v));
  return Number.isFinite(n) ? n : null;
}

module.exports = { textVal, arrVal, numVal };
