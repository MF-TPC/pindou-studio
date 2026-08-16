/**
 * 拼豆板参数模块
 * 默认板子 58×58，图纸自动居中
 */

function createBoardConfig() {
  return {
    width: 78, height: 78,
    guideSpacing: 5, guideOffset: 4,
    boardSize: 29, // 单板尺寸 (用于跨板边界线)
  };
}

function computeGuideLines(bc) {
  if (bc.guideSpacing <= 0) return { h: [], v: [] };
  const h = [], v = [];
  for (let p = bc.guideOffset; p < bc.height; p += bc.guideSpacing) h.push(p);
  for (let p = bc.guideOffset; p < bc.width; p += bc.guideSpacing) v.push(p);
  return { h, v };
}

function isInBounds(bc, x, y) {
  return x >= 0 && x < bc.width && y >= 0 && y < bc.height;
}

/**
 * 计算图纸在板子上的居中偏移
 * 返回 { ox, oy } — 图纸左上角在板子坐标中的位置
 */
function centerOffset(bc, matrixW, matrixH) {
  return {
    ox: Math.floor((bc.width - matrixW) / 2),
    oy: Math.floor((bc.height - matrixH) / 2),
  };
}

function drawBoardPreview(canvas, bc, opts) {
  opts = opts || {};
  const cs = opts.cellSize || 6;
  const gc = opts.guideColor || '#e03a3a';
  const lines = computeGuideLines(bc);
  const w = bc.width * cs, h = bc.height * cs;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f0ebe3'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#d8d0c4'; ctx.lineWidth = 0.3; ctx.beginPath();
  for (let x = 0; x <= bc.width; x++) { ctx.moveTo(x * cs, 0); ctx.lineTo(x * cs, h); }
  for (let y = 0; y <= bc.height; y++) { ctx.moveTo(0, y * cs); ctx.lineTo(w, y * cs); }
  ctx.stroke();
  ctx.strokeStyle = gc; ctx.lineWidth = 1.2; ctx.beginPath();
  for (const gy of lines.h) { const py = gy * cs; ctx.moveTo(0, py); ctx.lineTo(w, py); }
  for (const gx of lines.v) { const px = gx * cs; ctx.moveTo(px, 0); ctx.lineTo(px, h); }
  ctx.stroke();
  ctx.strokeStyle = '#999'; ctx.lineWidth = 1.5; ctx.strokeRect(0, 0, w, h);
}

const GUIDE_PRESETS = [
  { label: '5格标准', spacing: 5, offset: 0 },
  { label: '4格小间距', spacing: 4, offset: 0 },
  { label: '6格大间距', spacing: 6, offset: 0 },
  { label: '3格密线', spacing: 3, offset: 0 },
  { label: '偏移一格', spacing: 5, offset: 1 },
  { label: '偏移两格', spacing: 5, offset: 2 },
];
