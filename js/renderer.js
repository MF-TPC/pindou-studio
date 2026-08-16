/**
 * Canvas 图纸渲染 (V2.5)
 * convert — 符号/纯色块
 * assist  — 黑(无效) / 浅原色(待拼) / 深原色(完成) / 红(当前批)
 */

function createRenderer() {
  var O = {
    cellSize: 20, renderStyle: 'symbol', showGrid: true,
    gridColor: '#d0d0d0', boardLineColor: '#d03030',
    bgColor: '#fafaf8', colorBlack: '#1a1a1a',
    pathColor: '#e6a817', padding: 3,
  };
  function setOptions(o) { Object.assign(O, o); }

  function renderConvert(canvas, matrix, boardConfig) {
    var h = matrix.length, w = h > 0 ? matrix[0].length : 0;
    var cs = O.cellSize, pad = O.padding * cs;
    _drawConvert(canvas, matrix, w, h, cs, pad, boardConfig);
  }

  function _drawConvert(canvas, matrix, w, h, cs, pad, boardConfig) {
    var cw = pad * 2 + w * cs, ch = pad * 2 + h * cs;
    var off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    var ctx = off.getContext('2d');
    ctx.fillStyle = O.bgColor; ctx.fillRect(0, 0, cw, ch);

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var cell = matrix[y] ? matrix[y][x] : null;
        var cx = pad + x * cs, cy = pad + y * cs;
        if (!cell) { drawEmpty(ctx, cx, cy, cs); continue; }
        if (O.renderStyle === 'solid') { ctx.fillStyle = cell.hex; ctx.fillRect(cx, cy, cs, cs); }
        else drawSymbol(ctx, cx, cy, cs, cell);
      }
    }
    if (O.showGrid) drawGrid(ctx, pad, w, h, cs);
    drawLabels(ctx, pad, w, h, cs);
    copy(canvas, off);
  }

  function renderZoomed(canvas, matrix, zoom, boardConfig) {
    var h = matrix.length, w = h > 0 ? matrix[0].length : 0;
    var cs = O.cellSize, pad = O.padding * cs;
    var cw = pad * 2 + w * cs, ch = pad * 2 + h * cs;
    var off = document.createElement('canvas');
    _drawConvert(off, matrix, w, h, cs, pad, boardConfig);
    var tc = canvas.getContext('2d');
    canvas.width = cw * zoom; canvas.height = ch * zoom;
    tc.imageSmoothingEnabled = false; tc.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  function renderAssist(canvas, paddedMatrix, statusMatrix, boardConfig, isolatedList, zoom) {
    zoom = zoom || 1;
    var bh = boardConfig.height, bw = boardConfig.width;
    var cs = O.cellSize, pad = O.padding * cs;
    var cw = pad * 2 + bw * cs, ch = pad * 2 + bh * cs;
    var off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    _drawAssist(off, paddedMatrix, statusMatrix, boardConfig, isolatedList, cs, pad);
    var tc = canvas.getContext('2d');
    canvas.width = cw * zoom; canvas.height = ch * zoom;
    tc.imageSmoothingEnabled = false; tc.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  function _drawAssist(cvs, paddedMatrix, statusMatrix, boardConfig, isolatedList, cs, pad) {
    var bh = boardConfig.height, bw = boardConfig.width;
    var cw = pad * 2 + bw * cs, ch = pad * 2 + bh * cs;
    var lines = computeGuideLines(boardConfig);
    cvs.width = cw; cvs.height = ch;
    var ctx = cvs.getContext('2d');
    ctx.fillStyle = O.bgColor; ctx.fillRect(0, 0, cw, ch);

    for (var y = 0; y < bh; y++) {
      for (var x = 0; x < bw; x++) {
        var s = statusMatrix[y] ? statusMatrix[y][x] : 0;
        var cell = paddedMatrix[y] ? paddedMatrix[y][x] : null;
        var cx = pad + x * cs, cy = pad + y * cs;

        if (s === 0 || !cell) {
          ctx.fillStyle = O.colorBlack;
          ctx.fillRect(cx, cy, cs, cs);
        } else if (s === 1) {
          ctx.fillStyle = cell.hex;
          ctx.fillRect(cx, cy, cs, cs);
          ctx.fillStyle = 'rgba(255,255,255,0.88)';
          ctx.fillRect(cx, cy, cs, cs);
        } else if (s === 2) {
          // 已完成 — 原色 + 白色蒙版(略深一点点) + 白勾
          ctx.fillStyle = cell.hex;
          ctx.fillRect(cx, cy, cs, cs);
          ctx.fillStyle = 'rgba(0,0,0,0.10)';
          ctx.fillRect(cx, cy, cs, cs);
          ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, cs * 0.14);
          ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
          ctx.moveTo(cx + cs * 0.22, cy + cs * 0.55);
          ctx.lineTo(cx + cs * 0.44, cy + cs * 0.75);
          ctx.lineTo(cx + cs * 0.78, cy + cs * 0.28);
          ctx.stroke();
        } else if (s === 3) {
          ctx.fillStyle = '#22cc44';
          ctx.fillRect(cx, cy, cs, cs);
          ctx.strokeStyle = '#00e640'; ctx.lineWidth = Math.max(2, cs * 0.14);
          ctx.strokeRect(cx + 1.5, cy + 1.5, cs - 3, cs - 3);
          // 小标记 ●
          if (cs >= 12) {
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.arc(cx + cs/2, cy + cs/2, cs * 0.15, 0, Math.PI*2); ctx.fill();
          }
        }
      }
    }

    ctx.strokeStyle = O.boardLineColor; ctx.lineWidth = 2.0; ctx.beginPath();
    for (var gi = 0; gi < lines.h.length; gi++) {
      var gy = lines.h[gi];
      if (gy < bh) { var py = pad + gy * cs; ctx.moveTo(pad, py); ctx.lineTo(pad + bw * cs, py); }
    }
    for (var gj = 0; gj < lines.v.length; gj++) {
      var gx = lines.v[gj];
      if (gx < bw) { var px = pad + gx * cs; ctx.moveTo(px, pad); ctx.lineTo(px, pad + bh * cs); }
    }
    ctx.stroke();

    if (O.showGrid) drawGrid(ctx, pad, bw, bh, cs);

    if (isolatedList && isolatedList.length) {
      for (var ii = 0; ii < isolatedList.length; ii++) {
        var iso = isolatedList[ii];
        var x1 = pad + iso.fromX * cs + cs / 2, y1 = pad + iso.fromY * cs + cs / 2;
        var x2 = pad + iso.x * cs + cs / 2, y2 = pad + iso.y * cs + cs / 2;
        ctx.strokeStyle = O.pathColor; ctx.lineWidth = Math.max(1.5, cs * 0.08);
        ctx.setLineDash([cs * 0.35, cs * 0.2]); ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = O.pathColor; ctx.beginPath();
        ctx.arc(x1, y1, cs * 0.15, 0, Math.PI * 2); ctx.fill();
        var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        var fs = Math.max(9, cs * 0.52);
        ctx.font = 'bold ' + fs + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = O.pathColor; ctx.fillText(iso.distance + '格', mx, my - 2);
      }
    }

    if (cs >= 12) drawLabels(ctx, pad, bw, bh, cs);
  }

  return { setOptions, renderConvert, renderAssist, renderZoomed };
}

function drawEmpty(ctx, x, y, size) {
  ctx.strokeStyle = '#e5e5e5'; ctx.lineWidth = 0.5; ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size * 0.38, 0, Math.PI * 2); ctx.stroke();
}
function drawSymbol(ctx, x, y, size, cell) {
  ctx.fillStyle = cell.hex; ctx.fillRect(x, y, size, size);
  var b = cell.rgb[0] * 0.299 + cell.rgb[1] * 0.587 + cell.rgb[2] * 0.114;
  ctx.fillStyle = b > 140 ? '#1a1a1a' : '#ffffff';
  var fs = Math.max(7, Math.round(size * 0.40));
  ctx.font = 'bold ' + fs + 'px "PingFang SC","Microsoft YaHei",monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  var sc = b > 140 ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)';
  ctx.fillStyle = sc; ctx.fillText(cell.id, x + size / 2 + 0.5, y + size / 2 + 0.5);
  ctx.fillStyle = b > 140 ? '#1a1a1a' : '#ffffff';
  ctx.fillText(cell.id, x + size / 2, y + size / 2);
}
function drawGrid(ctx, pad, w, h, cs) {
  ctx.strokeStyle = '#d0d0d0'; ctx.lineWidth = 0.5; ctx.beginPath();
  for (var x = 0; x <= w; x++) { var px = pad + x * cs; ctx.moveTo(px, pad); ctx.lineTo(px, pad + h * cs); }
  for (var y = 0; y <= h; y++) { var py = pad + y * cs; ctx.moveTo(pad, py); ctx.lineTo(pad + w * cs, py); }
  ctx.stroke();
}
function drawLabels(ctx, pad, w, h, cs) {
  var fs = Math.max(9, cs * 0.42);
  ctx.font = fs + 'px monospace'; ctx.fillStyle = '#666';

  // 顶部列号 (每5格 + 末格)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (var x = 0; x < w; x++) {
    if (x % 5 === 0 || x === w - 1) {
      ctx.fillText(String(x + 1), pad + x * cs + cs / 2, pad - cs * 0.5);
    }
  }

  // 左侧行号
  ctx.textAlign = 'right';
  for (var y = 0; y < h; y++) {
    if (y % 5 === 0 || y === h - 1) {
      ctx.fillText(String(y + 1), pad - cs * 0.35, pad + y * cs + cs / 2);
    }
  }

  // 底部中央: 总尺寸标注
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = 'bold ' + Math.max(10, cs * 0.45) + 'px sans-serif';
  ctx.fillStyle = '#e8724a';
  ctx.fillText(w + ' 列 × ' + h + ' 行', pad + w * cs / 2, pad + h * cs + cs * 0.15);
}
function copy(target, source) {
  target.width = source.width; target.height = source.height;
  target.getContext('2d').drawImage(source, 0, 0);
}
