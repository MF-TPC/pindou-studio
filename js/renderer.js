/**
 * Canvas 图纸渲染模块 (V2.3)
 *
 * convert  — 纯色块 / 圆珠 / 符号 + zoom
 * assist   — 四色纯块 + 亮紫红线 + 路径 + zoom
 */

function createRenderer() {
  let O = {
    cellSize: 18, renderStyle: 'circle', showGrid: true,
    gridColor: '#d0d0d0', boardLineColor: '#b040e0',
    bgColor: '#fafaf8',
    colorBlack: '#1a1a1a', colorWhite: '#fefefe',
    colorRed: '#dc2828', colorGreen: '#00cc32',
    pathColor: '#e6a817', padding: 3,
  };
  function setOptions(o) { Object.assign(O, o); }

  // ======== 转换模式 ========
  function renderConvert(canvas, matrix, boardConfig) {
    const h = matrix.length, w = h > 0 ? matrix[0].length : 0;
    const cs = O.cellSize, pad = O.padding * cs;
    _drawConvert(canvas, matrix, w, h, cs, pad, boardConfig);
  }

  function _drawConvert(canvas, matrix, w, h, cs, pad, boardConfig) {
    const cw = pad * 2 + w * cs, ch = pad * 2 + h * cs;
    const off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    const ctx = off.getContext('2d');
    ctx.fillStyle = O.bgColor; ctx.fillRect(0, 0, cw, ch);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = matrix[y]?.[x], cx = pad + x * cs, cy = pad + y * cs;
        if (!cell) { drawEmpty(ctx, cx, cy, cs); continue; }
        if (O.renderStyle === 'solid') { ctx.fillStyle = cell.hex; ctx.fillRect(cx, cy, cs, cs); }
        else drawBeadSymbol(ctx, cx, cy, cs, cell);
      }
    }
    // 定位线
    if (boardConfig) {
      const lines = computeGuideLines(boardConfig);
      ctx.strokeStyle = O.boardLineColor; ctx.lineWidth = 1.3; ctx.beginPath();
      for (const gy of lines.h) { if (gy < h) { const py = pad + gy * cs; ctx.moveTo(pad, py); ctx.lineTo(pad + w * cs, py); } }
      for (const gx of lines.v) { if (gx < w) { const px = pad + gx * cs; ctx.moveTo(px, pad); ctx.lineTo(px, pad + h * cs); } }
      ctx.stroke();
    }
    if (O.showGrid) drawGrid(ctx, pad, w, h, cs);
    if (cs >= 12) drawLabels(ctx, pad, w, h, cs);
    copy(canvas, off);
  }

  function renderZoomed(canvas, matrix, zoom, boardConfig) {
    const h = matrix.length, w = h > 0 ? matrix[0].length : 0;
    const cs = O.cellSize, pad = O.padding * cs;
    const cw = pad * 2 + w * cs, ch = pad * 2 + h * cs;
    const off = document.createElement('canvas');
    _drawConvert(off, matrix, w, h, cs, pad, boardConfig);
    const tc = canvas.getContext('2d');
    canvas.width = cw * zoom; canvas.height = ch * zoom;
    tc.imageSmoothingEnabled = false; tc.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  // ======== 辅助模式 ========
  function renderAssist(canvas, paddedMatrix, statusMatrix, boardConfig, isolatedList, zoom) {
    zoom = zoom || 1;
    const bh = boardConfig.height, bw = boardConfig.width;
    const cs = O.cellSize, pad = O.padding * cs;
    const cw = pad * 2 + bw * cs, ch = pad * 2 + bh * cs;

    // 1x 渲染到离屏
    const off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    _drawAssist(off, paddedMatrix, statusMatrix, boardConfig, isolatedList, cs, pad);

    // 缩放到目标 canvas
    const tc = canvas.getContext('2d');
    canvas.width = cw * zoom; canvas.height = ch * zoom;
    tc.imageSmoothingEnabled = false;
    tc.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  function _drawAssist(cvs, paddedMatrix, statusMatrix, boardConfig, isolatedList, cs, pad) {
    const bh = boardConfig.height, bw = boardConfig.width;
    const cw = pad * 2 + bw * cs, ch = pad * 2 + bh * cs;
    const lines = computeGuideLines(boardConfig);

    cvs.width = cw; cvs.height = ch;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = O.bgColor; ctx.fillRect(0, 0, cw, ch);

    // 四色纯块
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const s = statusMatrix[y]?.[x];
        const cx = pad + x * cs, cy = pad + y * cs;
        ctx.fillStyle = s === 0 ? O.colorBlack
                      : s === 1 ? O.colorWhite
                      : s === 2 ? O.colorRed
                      : s === 3 ? O.colorGreen
                      : O.colorBlack;
        ctx.fillRect(cx, cy, cs, cs);

        if (s === 2) {
          ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, cs * 0.12);
          ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
          ctx.moveTo(cx + cs * 0.22, cy + cs * 0.52);
          ctx.lineTo(cx + cs * 0.44, cy + cs * 0.74);
          ctx.lineTo(cx + cs * 0.78, cy + cs * 0.26);
          ctx.stroke();
        }
        if (s === 3) {
          ctx.strokeStyle = '#00e640'; ctx.lineWidth = Math.max(2, cs * 0.14);
          ctx.strokeRect(cx + 1.5, cy + 1.5, cs - 3, cs - 3);
        }
      }
    }

    // 亮紫红线
    ctx.strokeStyle = O.boardLineColor; ctx.lineWidth = 1.3; ctx.beginPath();
    for (const gy of lines.h) { if (gy < bh) { const py = pad + gy * cs; ctx.moveTo(pad, py); ctx.lineTo(pad + bw * cs, py); } }
    for (const gx of lines.v) { if (gx < bw) { const px = pad + gx * cs; ctx.moveTo(px, pad); ctx.lineTo(px, pad + bh * cs); } }
    ctx.stroke();

    if (O.showGrid) drawGrid(ctx, pad, bw, bh, cs);

    // 孤立点路径
    if (isolatedList && isolatedList.length) {
      for (const iso of isolatedList) {
        const x1 = pad + iso.fromX * cs + cs / 2, y1 = pad + iso.fromY * cs + cs / 2;
        const x2 = pad + iso.x * cs + cs / 2, y2 = pad + iso.y * cs + cs / 2;
        ctx.strokeStyle = O.pathColor; ctx.lineWidth = Math.max(1.5, cs * 0.08);
        ctx.setLineDash([cs * 0.35, cs * 0.2]); ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = O.pathColor; ctx.beginPath();
        ctx.arc(x1, y1, cs * 0.15, 0, Math.PI * 2); ctx.fill();
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const fs = Math.max(9, cs * 0.52);
        ctx.font = `bold ${fs}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = O.pathColor; ctx.fillText(iso.distance + '格', mx, my - 2);
      }
    }

    if (cs >= 12) drawLabels(ctx, pad, bw, bh, cs);
  }

  return { setOptions, renderConvert, renderAssist, renderZoomed };
}

// ============ 绘图 primitives ============
function drawEmpty(ctx, x, y, size) {
  ctx.strokeStyle = '#e5e5e5'; ctx.lineWidth = 0.5; ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size * 0.38, 0, Math.PI * 2); ctx.stroke();
}
function drawBeadCircle(ctx, x, y, size, hex) {
  const r = size * 0.42, mx = x + size / 2, my = y + size / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.beginPath();
  ctx.arc(mx + 0.5, my + 1, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = hex; ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.beginPath();
  ctx.ellipse(mx - r * 0.3, my - r * 0.3, r * 0.38, r * 0.22, -Math.PI / 4, 0, Math.PI * 2); ctx.fill();
}
function drawBeadSymbol(ctx, x, y, size, cell) {
  // 背景色块
  ctx.fillStyle = cell.hex;
  ctx.fillRect(x, y, size, size);

  // 亮度判断 → 选对比色
  const b = cell.rgb[0] * 0.299 + cell.rgb[1] * 0.587 + cell.rgb[2] * 0.114;
  const textColor = b > 140 ? '#1a1a1a' : '#ffffff';

  // 字号: cellSize 的 58%, 最小 8px
  const fs = Math.max(7, Math.round(size * 0.40));
  ctx.font = `bold ${fs}px "PingFang SC","Microsoft YaHei",monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 文字阴影增强可读性
  const shadowColor = b > 140 ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)';
  ctx.fillStyle = shadowColor;
  ctx.fillText(cell.id, x + size / 2 + 0.5, y + size / 2 + 0.5);

  // 主体文字
  ctx.fillStyle = textColor;
  ctx.fillText(cell.id, x + size / 2, y + size / 2);
}
function drawGrid(ctx, pad, w, h, cs) {
  ctx.strokeStyle = '#d0d0d0'; ctx.lineWidth = 0.5; ctx.beginPath();
  for (let x = 0; x <= w; x++) { const px = pad + x * cs; ctx.moveTo(px, pad); ctx.lineTo(px, pad + h * cs); }
  for (let y = 0; y <= h; y++) { const py = pad + y * cs; ctx.moveTo(pad, py); ctx.lineTo(pad + w * cs, py); }
  ctx.stroke();
}
function drawLabels(ctx, pad, w, h, cs) {
  const fs = Math.max(8, cs * 0.4);
  ctx.font = `${fs}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#999';
  for (let x = 0; x < w; x++) { if (x % 5 === 0) ctx.fillText(String(x + 1), pad + x * cs + cs / 2, pad - cs * 0.45); }
  ctx.textAlign = 'right';
  for (let y = 0; y < h; y++) { if (y % 5 === 0) ctx.fillText(String(y + 1), pad - cs * 0.3, pad + y * cs + cs / 2); }
}
function copy(target, source) {
  target.width = source.width; target.height = source.height;
  target.getContext('2d').drawImage(source, 0, 0);
}
