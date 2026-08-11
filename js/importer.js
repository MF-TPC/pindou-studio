/**
 * 第三方拼豆图纸导入识别 (V2 — Stage 3+4)
 *
 * 流程:
 *   1. 网格自动检测
 *   2. 每格双通道读取: 颜色采样 + 轻量符号 OCR
 *   3. 图例区域解析
 *   4. 交叉验证: 颜色&OCR一致→确认, 不一致→OCR优先(符号是ground truth)
 */

// ============ 主入口 ============

/**
 * @param {HTMLImageElement} img
 * @param {Array} labPalette - precomputeLab() 结果
 * @returns {{ matrix: Array<Array>, stats: Object|null, confidence: string }}
 */
function importPatternImage(img, labPalette, converter) {
  var canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  var roi = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };

  // Step 1: 图例优先解析 —— 先弄清图纸用了哪些颜色
  var legend = parseLegend(ctx, roi, labPalette);
  // 从 legend 构建受限色板 (只有图纸中出现的颜色)
  var legendPalette = null;
  if (legend.length >= 3) {
    legendPalette = legend.map(function(l) {
      var def = labPalette.find(function(c) { return c.id === l.id; });
      return def || { id: l.id, hex: l.hex, rgb: l.rgb, lab: rgbToLab(l.rgb[0], l.rgb[1], l.rgb[2]) };
    });
  }

  // Step 2: 多尺度网格检测验证
  var grid = detectGrid(canvas, roi);
  if (!grid) return fallbackImport(canvas, roi, labPalette, converter);

  // 在检测值附近尝试多个尺寸，选图例匹配率最高的
  var bestResult = null, bestScore = 0;
  var sizes = [grid.rows];
  for (var d = -2; d <= 2; d++) { if (d !== 0 && grid.rows + d >= 2) sizes.push(grid.rows + d); }

  for (var si = 0; si < sizes.length; si++) {
    var tryRows = sizes[si];
    var tryCols = Math.round(grid.cols * tryRows / grid.rows);
    if (tryCols < 2 || tryRows < 2) continue;

    var cellW = roi.w / tryCols, cellH = roi.h / tryRows;
    var results = [];
    for (var y = 0; y < tryRows; y++) {
      for (var x = 0; x < tryCols; x++) {
        var cx = Math.round(roi.x + x * cellW + cellW / 2);
        var cy = Math.round(roi.y + y * cellH + cellH / 2);
        var cc = readCellByColor(ctx, cx, cy, Math.floor(cellW), labPalette);
        var oc = readCellByOCR(ctx, cx, cy, Math.floor(cellW), Math.floor(cellH), cc);
        results.push({ x: x, y: y, colorCode: cc, ocrCode: oc });
      }
    }

    var validated = crossValidateAndBuild(results, tryRows, tryCols, legend);
    var score = validated.agree + validated.ocrHits * 0.5 + (legend.length >= 3 ? validated.colorHits * 0.3 : 0);
    if (score > bestScore) {
      bestScore = score; bestResult = { codes: validated.codes, rows: tryRows, cols: tryCols, cellSize: Math.floor(cellW), ocrHits: validated.ocrHits, colorHits: validated.colorHits, agree: validated.agree, confidence: validated.confidence };
    }
  }

  var d = bestResult;
  var matrix = buildMatrix(d.codes, d.rows, d.cols, converter || null);
  return {
    matrix: matrix,
    confidence: d.confidence,
    details: { rows: d.rows, cols: d.cols, cellSize: d.cellSize, ocrHits: d.ocrHits, colorHits: d.colorHits, agree: d.agree, legendSize: legend.length },
  };
}

// ============ 通道A: 颜色采样 ============

function readCellByColor(ctx, cx, cy, cellW, labPalette) {
  // 取中心 3×3 中位数，避免网格线干扰
  const r = Math.max(1, Math.floor(cellW * 0.2));
  const samples = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const p = ctx.getImageData(cx + dx, cy + dy, 1, 1).data;
      if (p[3] >= 128) samples.push([p[0], p[1], p[2]]);
    }
  }
  if (!samples.length) return null;

  // 中位数
  const med = medianColor(samples);
  const matched = matchLab(med, labPalette);
  return matched ? matched.id : null;
}

function medianColor(samples) {
  const rs = samples.map(s => s[0]).sort((a, b) => a - b);
  const gs = samples.map(s => s[1]).sort((a, b) => a - b);
  const bs = samples.map(s => s[2]).sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return [rs[mid], gs[mid], bs[mid]];
}

// ============ 通道B: 轻量符号 OCR ============

// 预渲染多尺度字符模板
let _templates = null;
let _templateSize = 0;

function getTemplates(cellW) {
  var ts = Math.max(24, Math.round(cellW * 0.7));
  if (_templates && ts === _templateSize) return _templates;

  _templateSize = ts;
  var tc = document.createElement('canvas');
  tc.width = ts; tc.height = ts;
  var tctx = tc.getContext('2d');
  var fs = Math.round(ts * 0.65);
  tctx.font = 'bold ' + fs + 'px "PingFang SC","Microsoft YaHei",monospace';
  tctx.textAlign = 'center';
  tctx.textBaseline = 'middle';

  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  _templates = {};
  for (var ci = 0; ci < chars.length; ci++) {
    var ch = chars[ci];
    tctx.clearRect(0, 0, ts, ts);
    tctx.fillStyle = '#000';
    tctx.fillText(ch, ts / 2, ts / 2);
    var imgData = tctx.getImageData(0, 0, ts, ts);
    _templates[ch] = extractGridFeature(imgData.data, ts, ts, 16);
  }
  return _templates;
}

/** 从 ImageData 提取 N×N 网格特征 (N 通常为 16) */
function extractGridFeature(data, w, h, N) {
  var feat = [];
  var cw = w / N, ch = h / N;
  for (var gy = 0; gy < N; gy++) {
    for (var gx = 0; gx < N; gx++) {
      var sx = Math.floor(gx * cw), sy = Math.floor(gy * ch);
      var ex = Math.floor((gx + 1) * cw), ey = Math.floor((gy + 1) * ch);
      var sum = 0, cnt = 0;
      for (var py = sy; py < ey; py++) {
        for (var px = sx; px < ex; px++) {
          var idx = (py * w + px) * 4;
          if (idx + 2 < data.length) { sum += data[idx]; cnt++; }
        }
      }
      feat.push(cnt > 0 && sum / cnt > 128 ? 0 : 1);
    }
  }
  return feat;
}

function readCellByOCR(ctx, cx, cy, cellW, cellH, colorCode) {
  var r = Math.max(4, Math.floor(Math.min(cellW, cellH) * 0.38));
  var imgData = ctx.getImageData(cx - r, cy - r, r * 2, r * 2);
  if (!imgData) return null;

  // 自适应二值化: 按局部窗口计算阈值
  var side = r * 2;
  var gray = [];
  for (var i = 0; i < imgData.data.length; i += 4) {
    gray.push(imgData.data[i] * 0.299 + imgData.data[i + 1] * 0.587 + imgData.data[i + 2] * 0.114);
  }
  // 局部自适应: 将图像分成多个窗口各自计算 Otsu
  var bw = adaptiveThreshold(gray, side);

  // 找连通域
  var components = findConnectedComponents(bw, side);
  if (components.length === 0) return null;
  components.sort(function(a, b) { return a.cx - b.cx; });

  // 颜色辅助: 缩小候选集
  var candidateLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var candidateDigits = '0123456789';
  if (colorCode && /^[A-Z]\d/.test(colorCode)) {
    // 颜色识别的色号 → OCR 只需验证这个色号中的字符
    candidateLetters = colorCode[0]; // 只匹配这一个字母
    candidateDigits = colorCode.slice(1); // 只匹配这些数字
  }

  var templates = getTemplates(cellW);
  var result = '';

  for (var ci = 0; ci < Math.min(components.length, 3); ci++) {
    var comp = components[ci];
    var feat = extractComponentFeature(bw, side, comp);
    var candidates = ci === 0 ? candidateLetters : candidateDigits;

    var best = null, bestScore = Infinity;
    for (var di = 0; di < candidates.length; di++) {
      var ch = candidates[di];
      var tf = templates[ch];
      if (!tf) continue;
      var score = 0;
      for (var i = 0; i < tf.length; i++) {
        if (feat[i] !== tf[i]) score++;
      }
      var maxErr = Math.floor(tf.length * 0.35);
      if (score < bestScore && score <= maxErr) { bestScore = score; best = ch; }
    }
    if (best) result += best;
  }

  if (result.length >= 2 && /^[A-Z]\d+$/.test(result)) return result;
  if (result.length >= 1 && /^[A-Z]\d/.test(result)) return result;
  return result || null;
}

/** 局部自适应二值化 */
function adaptiveThreshold(gray, side) {
  var bw = new Array(gray.length);
  var blockSize = Math.max(8, Math.floor(side / 3));
  for (var y = 0; y < side; y++) {
    for (var x = 0; x < side; x++) {
      var idx = y * side + x;
      var sum = 0, cnt = 0;
      var bx0 = Math.max(0, x - Math.floor(blockSize / 2));
      var by0 = Math.max(0, y - Math.floor(blockSize / 2));
      var bx1 = Math.min(side, x + Math.floor(blockSize / 2));
      var by1 = Math.min(side, y + Math.floor(blockSize / 2));
      for (var py = by0; py < by1; py++) {
        for (var px = bx0; px < bx1; px++) {
          sum += gray[py * side + px]; cnt++;
        }
      }
      var avg = sum / cnt;
      bw[idx] = gray[idx] < avg * 0.85 ? 1 : 0;
    }
  }
  return bw;
}

/** 提取单个连通域的 16×16 特征 */
function extractComponentFeature(bw, side, comp) {
  var xs = comp.pixels.map(function(p) { return p[0]; });
  var ys = comp.pixels.map(function(p) { return p[1]; });
  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  var w = maxX - minX + 1, h = maxY - minY + 1;
  var N = 16;
  var feat = [];
  for (var gy = 0; gy < N; gy++) {
    for (var gx = 0; gx < N; gx++) {
      var sx = minX + Math.floor(w * gx / N);
      var sy = minY + Math.floor(h * gy / N);
      var ex = minX + Math.floor(w * (gx + 1) / N);
      var ey = minY + Math.floor(h * (gy + 1) / N);
      var cnt = 0, total = 0;
      for (var py = sy; py < ey; py++)
        for (var px = sx; px < ex; px++)
          { if (px < side && py < side) { total++; if (bw[py * side + px]) cnt++; } }
      feat.push(total > 0 && cnt / total > 0.3 ? 1 : 0);
    }
  }
  return feat;
}

// ============ 图例解析 ============

function parseLegend(ctx, roi, labPalette) {
  // 扫描图像底部的色块
  // 简易策略: 找独立颜色方块 + 紧邻文字 → 色号对照
  const legend = [];
  const bottomY = Math.floor(roi.h * 0.85);
  const step = 5;

  let lastColor = null;
  for (let y = bottomY; y < roi.h - 5; y += step) {
    for (let x = 10; x < Math.min(roi.w - 10, 300); x += step) {
      const p = ctx.getImageData(x, y, 3, 3);
      const samples = [];
      for (let i = 0; i < p.data.length; i += 4) {
        if (p.data[i + 3] >= 128) samples.push([p.data[i], p.data[i + 1], p.data[i + 2]]);
      }
      if (samples.length < 5) continue;
      const med = medianColor(samples);
      const matched = matchLab(med, labPalette);
      if (matched) {
        if (lastColor !== matched.id) {
          legend.push({ id: matched.id, rgb: matched.rgb, hex: matched.hex });
          lastColor = matched.id;
        }
      }
      x += 20; // 跳到下一个色块
    }
    y += 20; // 跳行
  }
  return legend;
}

// ============ 交叉验证 ============

function crossValidateAndBuild(cellResults, rows, cols, legend) {
  const codes = Array.from({ length: rows }, () => new Array(cols).fill(null));
  let ocrHits = 0, colorHits = 0, agree = 0;
  const legendSet = new Set(legend.map(l => l.id));

  for (const r of cellResults) {
    let finalCode = null;

    if (r.ocrCode && r.colorCode) {
      ocrHits++; colorHits++;
      if (r.ocrCode === r.colorCode) {
        agree++;
        finalCode = r.ocrCode; // 双通道一致 → 高置信
      } else {
        // 不一致 → OCR 优先 (符号是真实标注)
        finalCode = r.ocrCode;
      }
    } else if (r.ocrCode) {
      ocrHits++;
      finalCode = r.ocrCode;
    } else if (r.colorCode) {
      colorHits++;
      // 只有颜色 → 如果有图例校验通过就用，否则用颜色结果
      finalCode = r.colorCode;
    }

    // 图例校验
    if (finalCode && legendSet.size > 0 && !legendSet.has(finalCode)) {
      // 结果不在图例中，回退到颜色
      finalCode = r.colorCode || finalCode;
    }

    if (finalCode) codes[r.y][r.x] = finalCode;
  }

  const total = cellResults.length;
  const conf = ocrHits > total * 0.5 ? 'high'
    : colorHits > total * 0.7 ? 'medium' : 'low';

  return { codes, confidence: conf, ocrHits, colorHits, agree };
}

// ============ 指定尺寸重采样 ============

function resamplePatternImage(img, targetW, targetH, labPalette, converter) {
  var c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  var ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  var roi = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  var cellW = roi.w / targetW, cellH = roi.h / targetH;
  var results = [];
  for (var y = 0; y < targetH; y++) {
    for (var x = 0; x < targetW; x++) {
      var cx = Math.round(roi.x + x * cellW + cellW / 2);
      var cy = Math.round(roi.y + y * cellH + cellH / 2);
      var cc = readCellByColor(ctx, cx, cy, Math.floor(cellW), labPalette);
      var oc = readCellByOCR(ctx, cx, cy, Math.floor(cellW), Math.floor(cellH), cc);
      results.push({ x: x, y: y, colorCode: cc, ocrCode: oc });
    }
  }
  var legend = parseLegend(ctx, roi, labPalette);
  var v = crossValidateAndBuild(results, targetH, targetW, legend);
  return {
    matrix: buildMatrix(v.codes, targetH, targetW, converter),
    confidence: v.confidence,
    details: { rows: targetH, cols: targetW, cellSize: Math.floor(cellW), ocrHits: v.ocrHits, colorHits: v.colorHits, agree: v.agree, legendSize: legend.length },
  };
}

// ============ 辅助 ============

function fallbackImport(canvas, roi, labPalette, converter) {
  // 降级: 尝试直接颜色采样 29×29
  const rows = 29, cols = 29;
  const cellW = roi.w / cols, cellH = roi.h / rows;
  const results = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cx = Math.round(roi.x + x * cellW + cellW / 2);
      const cy = Math.round(roi.y + y * cellH + cellH / 2);
      const code = readCellByColor(canvas.getContext('2d'), cx, cy, Math.floor(cellW), labPalette);
      results.push({ x, y, code });
    }
  }
  const codes = Array.from({ length: rows }, () => new Array(cols).fill(null));
  for (const r of results) codes[r.y][r.x] = r.code;
  return { matrix: buildMatrix(codes, rows, cols, converter), confidence: 'low', details: { rows, cols, cellSize: Math.floor(cellW), ocrHits: 0, colorHits: results.filter(r => r.code).length, agree: 0, legendSize: 0 } };
}

function buildMatrix(codes, rows, cols, converter) {
  const matrix = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      const code = codes[y]?.[x];
      if (!code) { row.push(null); continue; }
      // 用 converter 的色板查找完整信息
      let cell = { id: code, name: code, hex: '#ccc', rgb: [204, 204, 204], category: '?' };
      if (converter && converter.labPalette) {
        const def = converter.labPalette.find(c => c.id === code);
        if (def) cell = { id: def.id, name: def.id, hex: def.hex, rgb: def.rgb, category: def.group || '?' };
      }
      row.push(cell);
    }
    matrix.push(row);
  }
  return matrix;
}

// ============ Otsu 阈值 ============

function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[Math.round(v)]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, wF = 0, maxVar = 0, thresh = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thresh = t; }
  }
  return thresh;
}

// ============ 连通域 ============

function findConnectedComponents(bw, side) {
  const visited = new Set();
  const comps = [];

  function flood(sx, sy) {
    const pixels = [];
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      const key = y * side + x;
      if (x < 0 || x >= side || y < 0 || y >= side || visited.has(key) || !bw[key]) continue;
      visited.add(key);
      pixels.push([x, y]);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    return pixels;
  }

  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const key = y * side + x;
      if (!visited.has(key) && bw[key]) {
        const pixels = flood(x, y);
        if (pixels.length >= 8) { // 至少8像素才算有效字符
          const cx = pixels.reduce((s, p) => s + p[0], 0) / pixels.length;
          const cy = pixels.reduce((s, p) => s + p[1], 0) / pixels.length;
          comps.push({ pixels, cx, cy, size: pixels.length });
        }
      }
    }
  }
  return comps;
}

function extractFeature(bw, side, comp) {
  // 在字符周围的包围盒上采样 8×8 网格
  const xs = comp.pixels.map(p => p[0]), ys = comp.pixels.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const feat = [];
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const sx = minX + Math.floor((maxX - minX + 1) * gx / 8);
      const sy = minY + Math.floor((maxY - minY + 1) * gy / 8);
      const ex = minX + Math.floor((maxX - minX + 1) * (gx + 1) / 8);
      const ey = minY + Math.floor((maxY - minY + 1) * (gy + 1) / 8);
      let cnt = 0, total = 0;
      for (let py = sy; py < ey; py++)
        for (let px = sx; px < ex; px++)
          { if (px < side && py < side) { total++; if (bw[py * side + px]) cnt++; } }
      feat.push(total > 0 && cnt / total > 0.3 ? 1 : 0);
    }
  }
  return feat;
}

// 复用 detectGrid from original importer
// (keep existing detectGrid code)

function detectGrid(canvas, roi) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(roi.x, roi.y, roi.w, roi.h);
  const { data, width, height } = imageData;

  const vProj = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      sum += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    }
    vProj[x] = sum / height;
  }

  const hProj = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      sum += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    }
    hProj[y] = sum / width;
  }

  const vP = findPeriod(vProj), hP = findPeriod(hProj);
  if (!vP || !hP) return null;

  const cs = Math.round((vP + hP) / 2);
  const cols = Math.round(width / cs), rows = Math.round(height / cs);
  if (cs < 5 || cs > 100 || cols < 2 || cols > 500 || rows < 2 || rows > 500) return null;
  return { rows, cols, cellSize: cs };
}

function findPeriod(proj) {
  const n = proj.length;
  if (n < 10) return null;
  const valleys = [];
  for (let i = 1; i < n - 1; i++) {
    if (proj[i] < proj[i - 1] && proj[i] < proj[i + 1]) {
      const la = (proj[i - 3] + proj[i - 2] + proj[i - 1] + proj[i + 1] + proj[i + 2] + proj[i + 3]) / 6;
      if (!isNaN(la) && proj[i] < la * 0.85) valleys.push(i);
    }
  }
  if (valleys.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < valleys.length; i++) gaps.push(valleys[i] - valleys[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
