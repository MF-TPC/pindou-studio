/**
 * 拼豆图纸导入 (V6.0 — 准确长宽 + 连通域图例识别)
 *
 * 核心改进:
 *   1. detectPatternBounds: 用饱和度(彩色度)定位图案区边界，排除图例/边框干扰
 *      → 网格检测只对图案区做投影，修复长宽比例失衡问题
 *   2. 连通域分割替代滑动窗口 → 图例数字识别更准更快
 *   3. 全程内存数组运算 (一次性 getImageData)
 *   4. 众数采样 (符号文字不污染格子背景色)
 *
 * 流程:
 *   整图getImageData → 定位图案区 → 网格检测(图案区) → 图例读取(连通域) → 逐格众数采样 → 交叉验证
 */

// ============ 模板渲染缓存 ============
var _charTemplates = null;

/**
 * 预渲染字符模板 (0-9 数字 + A-Z 字母 + 符号)，用于图例文字识别
 */
function ensureCharTemplates(fontSize) {
  fontSize = fontSize || 16;
  var key = 'char_' + fontSize;
  if (_charTemplates && _charTemplates._key === key) return _charTemplates;

  var tmpl = { _key: key };
  var chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  var measureCvs = document.createElement('canvas');
  measureCvs.width = fontSize * 3; measureCvs.height = fontSize * 2;
  var mctx = measureCvs.getContext('2d');
  mctx.font = 'bold ' + fontSize + 'px "PingFang SC","Microsoft YaHei",monospace';

  for (var i = 0; i < chars.length; i++) {
    var ch = chars[i];
    var metrics = mctx.measureText(ch);
    var cw = Math.ceil(metrics.width) + 2;
    var ch2 = fontSize + 4;

    var cc = document.createElement('canvas');
    cc.width = cw; cc.height = ch2;
    var cctx = cc.getContext('2d');
    cctx.fillStyle = '#000';
    cctx.font = 'bold ' + fontSize + 'px "PingFang SC","Microsoft YaHei",monospace';
    cctx.textAlign = 'left';
    cctx.textBaseline = 'top';
    cctx.fillText(ch, 1, 1);

    tmpl[ch] = { data: cctx.getImageData(0, 0, cw, ch2), w: cw, h: ch2 };
  }

  _charTemplates = tmpl;
  return tmpl;
}

// ============ Tesseract OCR (按需懒加载，仅图例区) ============
var _tesseractWorker = null;
var _tesseractLoading = false;
var _tesseractReady = false;

function loadTesseract(callback) {
  if (_tesseractReady) { callback(true); return; }
  if (_tesseractLoading) { setTimeout(function() { loadTesseract(callback); }, 400); return; }
  _tesseractLoading = true;
  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  script.onload = function() {
    try {
      Tesseract.createWorker('eng', 1, {}).then(function(w) {
        _tesseractWorker = w; _tesseractReady = true; callback(true);
      }).catch(function() { _tesseractLoading = false; callback(false); });
    } catch (e) { _tesseractLoading = false; callback(false); }
  };
  script.onerror = function() { _tesseractLoading = false; callback(false); };
  document.head.appendChild(script);
}

/**
 * 切出图例区并 OCR (放大2倍利于小字识别)
 */
function tesseractOcrLegend(img, legendTop, legendH, callback) {
  if (!_tesseractReady || !_tesseractWorker) { callback(''); return; }
  var sw = img.naturalWidth;
  if (legendH <= 0) { callback(''); return; }
  var scale = 2;
  var canvas = document.createElement('canvas');
  canvas.width = sw * scale; canvas.height = legendH * scale;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, legendTop, sw, legendH, 0, 0, sw * scale, legendH * scale);
  _tesseractWorker.recognize(canvas).then(function(r) {
    callback((r.data && r.data.text) ? r.data.text.trim() : '');
  }).catch(function() { callback(''); });
}

/**
 * 解析 OCR 文本 → 图例条目 (色号 + 数量)
 *
 * 通用模板：无论图例是"色号上数量下"、"色号+×数量同行"、"色号+(数量)"，
 * 都统一为 token 提取(色号 + 数字) + 顺序配对(FIFO)。
 * 连字如 "H7620" 自动拆成 H7 + 620；色号必须命中色板合法编号，否则跳过。
 */
function parseOcrLegendText(text, labPalette) {
  // 合法色号索引
  var byId = {};
  var validCodes = {};
  for (var p = 0; p < labPalette.length; p++) {
    validCodes[labPalette[p].id] = true;
    byId[labPalette[p].id] = labPalette[p];
  }

  // token 提取：色号队列 + 数字队列
  var codeQueue = [];
  var numQueue = [];
  var i = 0, n = text.length;

  while (i < n) {
    var ch = text[i];
    var U = ch.toUpperCase();
    if (U >= 'A' && U <= 'Z') {
      // 尝试匹配色号：字母 + 2 位数字 → 1 位数字
      var matched = false;
      for (var len = 2; len >= 1; len--) {
        if (i + len < n) {
          var code = U;
          var ok = true;
          for (var d = 1; d <= len; d++) {
            var dc = text[i + d];
            if (dc < '0' || dc > '9') { ok = false; break; }
            code += dc;
          }
          if (ok && validCodes[code]) {
            codeQueue.push(code);
            i += 1 + len;
            matched = true;
            break;
          }
        }
      }
      if (!matched) i++; // 非色号字母(水印英文)，跳过
    } else if (ch >= '0' && ch <= '9') {
      var j = i;
      while (j < n && text[j] >= '0' && text[j] <= '9') j++;
      var num = parseInt(text.substring(i, j), 10);
      numQueue.push(num);
      i = j;
    } else {
      i++; // 符号/空格/括号/汉字/换行
    }
  }

  // 过滤异常数字(水印)：拼豆数量 1~99999
  var nums = [];
  for (var q = 0; q < numQueue.length; q++) {
    var v = numQueue[q];
    if (v >= 1 && v <= 99999) nums.push(v);
  }

  // FIFO 顺序配对
  var legend = [];
  var seen = {};
  var minLen = Math.min(codeQueue.length, nums.length);
  for (var k = 0; k < minLen; k++) {
    var c = codeQueue[k];
    if (seen[c]) continue;
    seen[c] = true;
    legend.push({
      id: c,
      hex: byId[c] ? byId[c].hex : '#ccc',
      rgb: byId[c] ? byId[c].rgb : [204, 204, 204],
      qty: nums[k],
    });
  }
  return legend;
}

/**
 * 合并 OCR 结果与模板匹配结果 (OCR 优先)
 */
function mergeLegend(ocrLegend, tmplLegend) {
  var merged = {};
  for (var i = 0; i < ocrLegend.length; i++) merged[ocrLegend[i].id] = ocrLegend[i];
  for (var j = 0; j < tmplLegend.length; j++) {
    var id = tmplLegend[j].id;
    if (!merged[id]) merged[id] = tmplLegend[j];
    else if (merged[id].qty === null && tmplLegend[j].qty !== null) merged[id].qty = tmplLegend[j].qty;
  }
  var result = [];
  for (var k in merged) result.push(merged[k]);
  return result;
}

/**
 * 图例区上边界 (图案区下边界 + 间隙)
 */
function detectLegendTop(data, w, h, grid) {
  var legendTop;
  if (grid && grid.bounds) {
    legendTop = grid.bounds.y1 + 5;
  } else {
    legendTop = Math.floor(h * 0.75);
  }
  if (legendTop >= h - 15) legendTop = Math.floor(h * 0.70);
  return legendTop;
}

// ============ 像素读取辅助 ============

function getPixel(data, w, h, x, y) {
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  var idx = (y * w + x) * 4;
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

// ============ 主入口 ============

function importPatternImage(img, labPalette, converter, enableOCR) {
  var canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // 一次性读取整图 (性能关键)
  var fullImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  var fullData = fullImageData.data;
  var fullW = canvas.width, fullH = canvas.height;

  // Step 1: 网格检测 (只对图案区)
  var grid = detectGrid(fullData, fullW, fullH);
  if (!grid) return Promise.resolve(fallbackImport(fullData, fullW, fullH, labPalette, converter));

  // Step 2: 图例检测 (图案区下方)
  var legend = parseLegend(fullData, fullW, fullH, grid, labPalette);
  var legendTop = detectLegendTop(fullData, fullW, fullH, grid);

  // Step 3: 逐格众数采样 (基于图案区坐标)
  var region = grid.bounds || { x0: 0, y0: 0, x1: fullW - 1, y1: fullH - 1 };
  var regionW = region.x1 - region.x0 + 1, regionH = region.y1 - region.y0 + 1;
  var cellW = regionW / grid.cols, cellH = regionH / grid.rows;

  var codes = Array.from({ length: grid.rows }, function() { return new Array(grid.cols).fill(null); });
  var colorHits = 0;
  var totalCells = grid.rows * grid.cols;

  for (var y = 0; y < grid.rows; y++) {
    for (var x = 0; x < grid.cols; x++) {
      var cx = Math.round(region.x0 + x * cellW + cellW / 2);
      var cy = Math.round(region.y0 + y * cellH + cellH / 2);
      var code = readCellByMode(fullData, fullW, fullH, cx, cy, cellW, cellH, labPalette);
      if (code) { colorHits++; codes[y][x] = code; }
    }
  }

  // Step 4: 置信度评估
  var bestRows = grid.rows, bestCols = grid.cols, bestCodes = codes, bestHits = colorHits;
  var hitRate = colorHits / totalCells;

  if (hitRate < 0.75) {
    var alts = [];
    if (grid.rows > 2) alts.push({ rows: grid.rows - 1, cols: Math.round(grid.cols * (grid.rows - 1) / grid.rows) });
    if (grid.rows < 300) alts.push({ rows: grid.rows + 1, cols: Math.round(grid.cols * (grid.rows + 1) / grid.rows) });

    for (var ai = 0; ai < alts.length; ai++) {
      var a = alts[ai];
      if (a.cols < 2 || a.rows < 2) continue;
      var aw = regionW / a.cols, ah = regionH / a.rows;
      var aCodes = Array.from({ length: a.rows }, function() { return new Array(a.cols).fill(null); });
      var aHits = 0;

      var sampleHits = 0, sampleTotal = 0;
      for (var sy = 0; sy < a.rows; sy += 3) {
        for (var sx = 0; sx < a.cols; sx += 3) {
          sampleTotal++;
          var scx = Math.round(region.x0 + sx * aw + aw / 2);
          var scy = Math.round(region.y0 + sy * ah + ah / 2);
          if (readCellByMode(fullData, fullW, fullH, scx, scy, aw, ah, labPalette)) sampleHits++;
        }
      }

      if (sampleHits / sampleTotal > hitRate + 0.1) {
        for (var fy = 0; fy < a.rows; fy++) {
          for (var fx = 0; fx < a.cols; fx++) {
            var fcx = Math.round(region.x0 + fx * aw + aw / 2);
            var fcy = Math.round(region.y0 + fy * ah + ah / 2);
            var fc = readCellByMode(fullData, fullW, fullH, fcx, fcy, aw, ah, labPalette);
            if (fc) { aHits++; aCodes[fy][fx] = fc; }
          }
        }
        if (aHits > bestHits) { bestHits = aHits; bestRows = a.rows; bestCols = a.cols; bestCodes = aCodes; }
      }
    }
  }

  // Step 5: 交叉验证
  var gridCounts = {};
  for (var gy = 0; gy < bestRows; gy++)
    for (var gx = 0; gx < bestCols; gx++)
      if (bestCodes[gy][gx]) gridCounts[bestCodes[gy][gx]] = (gridCounts[bestCodes[gy][gx]] || 0) + 1;

  var validation = crossValidate(legend, gridCounts);

  // Step 6: 构建结果
  var matrix = buildMatrix(bestCodes, bestRows, bestCols, converter || null);

  var result = {
    matrix: matrix,
    confidence: bestHits / (bestRows * bestCols) >= 0.85 ? 'ok' : 'low',
    details: {
      rows: bestRows, cols: bestCols,
      cellSize: Math.floor(cellW),
      colorHits: bestHits,
      legendSize: legend.length,
      legendQtyCount: legend.filter(function(l) { return l.qty !== null; }).length,
      hitRate: Math.round(bestHits / (bestRows * bestCols) * 100),
    },
    legend: legend,
    validation: validation,
  };

  // Step 7: 图例 OCR 增强 (模板匹配读到的数量不足时触发)
  var legendQtyCount = legend.filter(function(l) { return l.qty !== null; }).length;
  var needOCR = enableOCR !== false && legend.length > 0 && legendQtyCount < legend.length * 0.5;

  if (!needOCR) return Promise.resolve(result);

  return new Promise(function(resolve) {
    loadTesseract(function(ok) {
      if (!ok) { result.details.ocrUsed = false; resolve(result); return; }
      tesseractOcrLegend(img, legendTop, fullH - legendTop, function(text) {
        if (text) {
          var ocrLegend = parseOcrLegendText(text, labPalette);
          if (ocrLegend.length > 0) {
            legend = mergeLegend(ocrLegend, legend);
            validation = crossValidate(legend, gridCounts);
            result.legend = legend;
            result.validation = validation;
            result.details.legendSize = legend.length;
            result.details.legendQtyCount = legend.filter(function(l) { return l.qty !== null; }).length;
            result.details.ocrUsed = true;
          }
        }
        resolve(result);
      });
    });
  });
}

// ============ 重采样 ============

function resamplePatternImage(img, targetW, targetH, labPalette, converter) {
  var c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  var ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  var fullData = ctx.getImageData(0, 0, c.width, c.height).data;
  var fullW = c.width, fullH = c.height;

  var cellW = fullW / targetW, cellH = fullH / targetH;
  var codes = Array.from({ length: targetH }, function() { return new Array(targetW).fill(null); });
  var colorHits = 0;
  for (var y = 0; y < targetH; y++) {
    for (var x = 0; x < targetW; x++) {
      var cx = Math.round(x * cellW + cellW / 2);
      var cy = Math.round(y * cellH + cellH / 2);
      var code = readCellByMode(fullData, fullW, fullH, cx, cy, cellW, cellH, labPalette);
      if (code) { colorHits++; codes[y][x] = code; }
    }
  }
  var legend = parseLegend(fullData, fullW, fullH, null, labPalette);
  return {
    matrix: buildMatrix(codes, targetH, targetW, converter),
    confidence: 'ok',
    details: { rows: targetH, cols: targetW, cellSize: Math.floor(cellW), colorHits: colorHits, legendSize: legend.length },
  };
}

// ============ 颜色采样 (众数) ============

function readCellByMode(data, w, h, cx, cy, cellW, cellH, labPalette) {
  var hx = Math.max(2, Math.floor(cellW / 2));
  var hy = Math.max(2, Math.floor(cellH / 2));
  var x0 = Math.max(0, Math.round(cx - hx)), y0 = Math.max(0, Math.round(cy - hy));
  var x1 = Math.min(w, Math.round(cx + hx)), y1 = Math.min(h, Math.round(cy + hy));

  // 中间环采样 + 精确 RGB 众数：排除中心符号(30%) + 边界网格线(12%)，不量化，区分相近色
  var innerX = Math.floor(cellW * 0.30);
  var innerY = Math.floor(cellH * 0.30);
  var edgeX = Math.max(1, Math.floor(cellW * 0.12));
  var edgeY = Math.max(1, Math.floor(cellH * 0.12));

  var hist = {};
  var total = 0, maxC = 0, domKey = null;
  for (var y = y0; y < y1; y++) {
    var rowBase = y * w;
    for (var x = x0; x < x1; x++) {
      var dx = Math.abs(x - cx), dy = Math.abs(y - cy);
      if (dx < innerX && dy < innerY) continue; // 中心符号
      if (dx > hx - edgeX || dy > hy - edgeY) continue; // 边界网格线
      var idx = (rowBase + x) * 4;
      if (data[idx + 3] < 128) continue;
      var key = data[idx] + ',' + data[idx + 1] + ',' + data[idx + 2];
      hist[key] = (hist[key] || 0) + 1;
      if (hist[key] > maxC) { maxC = hist[key]; domKey = key; }
      total++;
    }
  }

  // 中间环样本不足，回退整格精确众数
  if (total < 3) {
    hist = {};
    total = 0; maxC = 0; domKey = null;
    for (var y2 = y0; y2 < y1; y2++) {
      var rowBase2 = y2 * w;
      for (var x2 = x0; x2 < x1; x2++) {
        var idx2 = (rowBase2 + x2) * 4;
        if (data[idx2 + 3] < 128) continue;
        var key2 = data[idx2] + ',' + data[idx2 + 1] + ',' + data[idx2 + 2];
        hist[key2] = (hist[key2] || 0) + 1;
        if (hist[key2] > maxC) { maxC = hist[key2]; domKey = key2; }
        total++;
      }
    }
  }
  if (total < 3 || !domKey) return null;

  var parts = domKey.split(',');
  var matched = matchLab([parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10)], labPalette);
  return matched ? matched.id : null;
}

function medianColor(s) {
  var rs = s.map(function(v) { return v[0]; }).sort(function(a, b) { return a - b; });
  var gs = s.map(function(v) { return v[1]; }).sort(function(a, b) { return a - b; });
  var bs = s.map(function(v) { return v[2]; }).sort(function(a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return [rs[m], gs[m], bs[m]];
}

// ============ 图案区边界检测 ============

/**
 * 用饱和度(彩色度)定位图案区边界，排除图例/边框/坐标数字干扰
 * 图案区 = 彩色格子(饱和度高)，图例/边框 = 白底黑字(饱和度低)
 */
// ============ 网格检测 (波谷法) ============

function detectGrid(data, w, h) {
  // 垂直投影 (全图)
  var vProj = new Float32Array(w);
  for (var x = 0; x < w; x++) {
    var s = 0;
    for (var y = 0; y < h; y++) {
      var idx = (y * w + x) * 4;
      s += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    }
    vProj[x] = s / h;
  }

  // 水平投影 (全图)
  var hProj = new Float32Array(h);
  for (var y = 0; y < h; y++) {
    var s = 0;
    var rowBase = y * w;
    for (var x = 0; x < w; x++) {
      var idx = (rowBase + x) * 4;
      s += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    }
    hProj[y] = s / w;
  }

  var vP = findPeriod(vProj);
  var hP = findPeriod(hProj);
  if (!vP || !hP) return null;

  // 统一 cellSize (格子通常正方形)，保证 cols:rows = 宽:高 比例正确
  var cs = Math.round((vP + hP) / 2);
  var cols = Math.round(w / cs);
  var rows = Math.round(h / cs);

  if (cs < 5 || cs > 100 || cols < 2 || cols > 500 || rows < 2 || rows > 500) return null;

  return { rows: rows, cols: cols, cellSize: cs, bounds: { x0: 0, y0: 0, x1: w - 1, y1: h - 1 } };
}

function findValleys(proj, threshold) {
  var n = proj.length;
  if (n < 10) return [];
  if (threshold === undefined) threshold = 0.88;

  var smoothed = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var sum = 0, cnt = 0;
    for (var j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { sum += proj[j]; cnt++; }
    smoothed[i] = sum / cnt;
  }

  var valleys = [];
  for (var i = 2; i < n - 2; i++) {
    if (smoothed[i] < smoothed[i - 1] && smoothed[i] < smoothed[i + 1]) {
      var localMean = (smoothed[i - 2] + smoothed[i - 1] + smoothed[i + 1] + smoothed[i + 2]) / 4;
      if (smoothed[i] < localMean * threshold) valleys.push(i);
    }
  }
  return valleys;
}

function findPeriod(proj) {
  var valleys = findValleys(proj);
  if (valleys.length < 3) return null;
  var gaps = [];
  for (var i = 1; i < valleys.length; i++) gaps.push(valleys[i] - valleys[i - 1]);
  gaps.sort(function(a, b) { return a - b; });
  return gaps[Math.floor(gaps.length / 2)];
}

// ============ 内容边界检测 (背景吸附 + 背景拟合用) ============

/**
 * 检测"非背景内容"的包围框
 * 背景色 = 四角采样，从四边向内扫描找非背景像素的边界
 * @returns {x0, y0, x1, y1} 或 null
 */
function detectContentBounds(data, w, h) {
  // 背景色：四角 3×3 采样平均
  var corners = [[4, 4], [w - 5, 4], [4, h - 5], [w - 5, h - 5]];
  var bgR = 0, bgG = 0, bgB = 0, bgN = 0;
  for (var i = 0; i < corners.length; i++) {
    var cx0 = corners[i][0], cy0 = corners[i][1];
    for (var dy = 0; dy < 3; dy++) {
      for (var dx = 0; dx < 3; dx++) {
        var px = cx0 + dx, py = cy0 + dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        var idx = (py * w + px) * 4;
        bgR += data[idx]; bgG += data[idx + 1]; bgB += data[idx + 2]; bgN++;
      }
    }
  }
  if (bgN < 4) return null;
  bgR /= bgN; bgG /= bgN; bgB /= bgN;

  var thr = 40;      // 与背景色的曼哈顿距离阈值
  var ratio = 0.25;  // 一行/列中非背景像素占比阈值

  function rowIsContent(y) {
    var cnt = 0, total = 0;
    for (var x = 0; x < w; x += 2) {
      var idx = (y * w + x) * 4;
      var d = Math.abs(data[idx] - bgR) + Math.abs(data[idx + 1] - bgG) + Math.abs(data[idx + 2] - bgB);
      if (d > thr) cnt++;
      total++;
    }
    return cnt / total > ratio;
  }
  function colIsContent(x, y0, y1) {
    var cnt = 0, total = 0;
    for (var y = y0; y <= y1; y += 2) {
      var idx = (y * w + x) * 4;
      var d = Math.abs(data[idx] - bgR) + Math.abs(data[idx + 1] - bgG) + Math.abs(data[idx + 2] - bgB);
      if (d > thr) cnt++;
      total++;
    }
    return cnt / total > ratio;
  }

  var y0 = -1, y1 = -1, x0 = -1, x1 = -1;
  for (var y = 0; y < h; y++) { if (rowIsContent(y)) { y0 = y; break; } }
  for (var y = h - 1; y >= 0; y--) { if (rowIsContent(y)) { y1 = y; break; } }
  if (y0 < 0 || y1 <= y0) return null;
  for (var x = 0; x < w; x++) { if (colIsContent(x, y0, y1)) { x0 = x; break; } }
  for (var x = w - 1; x >= 0; x--) { if (colIsContent(x, y0, y1)) { x1 = x; break; } }
  if (x0 < 0 || x1 <= x0) return null;

  return { x0: x0, y0: y0, x1: x1, y1: y1 };
}

// ============ 图案网格精确边界 (网格线定位) ============

function medianGap(valleys) {
  var gaps = [];
  for (var i = 1; i < valleys.length; i++) gaps.push(valleys[i] - valleys[i - 1]);
  gaps.sort(function(a, b) { return a - b; });
  return gaps[Math.floor(gaps.length / 2)];
}

// 用"最小间距的众数"作为周期：区分细网格线(cellSize)与粗定位线(5×cellSize)
function robustPeriod(valleys) {
  var gaps = [];
  for (var i = 1; i < valleys.length; i++) gaps.push(valleys[i] - valleys[i - 1]);
  if (!gaps.length) return null;
  var minGap = Math.min.apply(null, gaps);
  var hist = {};
  for (var i = 0; i < gaps.length; i++) {
    if (gaps[i] <= minGap * 1.5) hist[gaps[i]] = (hist[gaps[i]] || 0) + 1;
  }
  var best = null, bestCount = 0;
  for (var g in hist) {
    if (hist[g] > bestCount) { bestCount = hist[g]; best = parseInt(g, 10); }
  }
  return best;
}

// 找最长一段"周期吻合"的波谷区间（真实网格线），排除卡牌边框/编号圈等离群波谷
// 找不到足够长的周期区间时不返回 null，退回用首尾波谷（保底，避免整体失败）
function periodicRun(valleys, period) {
  if (!valleys || valleys.length < 2) return null;
  var bestStart = 0, bestLen = 1, curStart = 0, curLen = 1;
  if (period && period >= 2) {
    for (var i = 1; i < valleys.length; i++) {
      var gap = valleys[i] - valleys[i - 1];
      if (gap >= period * 0.7 && gap <= period * 1.45) {
        curLen++;
      } else {
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
        curStart = i; curLen = 1;
      }
    }
    if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
  }
  if (bestLen < 3) {
    return { first: valleys[0], last: valleys[valleys.length - 1], count: valleys.length, loose: true };
  }
  return { first: valleys[bestStart], last: valleys[bestStart + bestLen - 1], count: bestLen, loose: false };
}

function hasValleyNear(valleys, from, to) {
  for (var i = 0; i < valleys.length; i++) {
    if (valleys[i] >= from && valleys[i] <= to) return true;
  }
  return false;
}

/**
 * 用网格线检测图案本体的精确边界（排除四边编号格子圈），并返回交界处
 * @param {object} bounds - detectContentBounds 的内容大致范围
 * @returns {x0, y0, x1, y1, junctionY} 或 null（网格线不足时回退）
 */
function detectPatternGridBounds(data, w, h, bounds) {
  var cx0 = bounds.x0, cy0 = bounds.y0, cx1 = bounds.x1, cy1 = bounds.y1;
  var pw = cx1 - cx0 + 1, ph = cy1 - cy0 + 1;

  // 1. 垂直投影 (整个内容范围，用量横跨全宽不影响竖线周期)
  var vProj = new Float32Array(pw);
  for (var x = 0; x < pw; x++) {
    var s = 0;
    for (var y = 0; y < ph; y++) {
      var idx = ((cy0 + y) * w + (cx0 + x)) * 4;
      s += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    }
    vProj[x] = s / ph;
  }
  var vValleys = findValleys(vProj);
  if (vValleys.length < 3) vValleys = findValleys(vProj, 0.95);
  if (vValleys.length < 3) { console.log('[grid] 垂直波谷不足', vValleys.length); return null; }
  var cellW = robustPeriod(vValleys);
  if (!cellW || cellW < 3) { console.log('[grid] cellW 异常', cellW); return null; }
  var vRun = periodicRun(vValleys, cellW);
  if (!vRun) return null;
  var leftGrid = cx0 + vRun.first;
  var rightGrid = cx0 + vRun.last;

  // 2. 水平投影 (只在左右网格线之间，排除左右编号圈/用量区干扰)
  var gw = rightGrid - leftGrid + 1;
  if (gw < 3 * cellW) return null;
  var hProj = new Float32Array(ph);
  for (var y = 0; y < ph; y++) {
    var s = 0;
    for (var x = 0; x < gw; x++) {
      var idx = ((cy0 + y) * w + (leftGrid + x)) * 4;
      s += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    }
    hProj[y] = s / gw;
  }
  var hValleys = findValleys(hProj);
  if (hValleys.length < 3) hValleys = findValleys(hProj, 0.95);
  if (hValleys.length < 3) { console.log('[grid] 水平波谷不足', hValleys.length); return null; }
  var cellH = robustPeriod(hValleys);
  if (!cellH || cellH < 3) { console.log('[grid] cellH 异常', cellH); return null; }
  var hRun = periodicRun(hValleys, cellH);
  if (!hRun) return null;
  var topGrid = cy0 + hRun.first;
  var bottomGrid = cy0 + hRun.last;

  // 3. 判断四边是否有编号圈 (网格线外侧还有一圈内容)
  var vLeftRel = leftGrid - cx0, vRightRel = rightGrid - cx0;
  var hTopRel = topGrid - cy0, hBottomRel = bottomGrid - cy0;
  var hasLeftNum = vLeftRel >= cellW * 0.5;
  var hasTopNum = hTopRel >= cellH * 0.5;
  var hasRightNum = (cx1 - rightGrid) >= cellW * 0.5;
  var hasBottomNum = hasValleyNear(hValleys, hBottomRel + cellH * 0.4, hBottomRel + cellH * 1.6);

  var cols = Math.round((rightGrid - leftGrid) / cellW);
  var rows = Math.round((bottomGrid - topGrid) / cellH);
  if (cols < 2 || rows < 2) return null;

  // 全范围 = 图案网格 + 编号圈 (外扩一格，不再往里缩)
  var x0 = hasLeftNum ? leftGrid - cellW : leftGrid;
  var x1 = hasRightNum ? rightGrid + cellW : rightGrid;
  var y0 = hasTopNum ? topGrid - cellH : topGrid;
  var y1 = hasBottomNum ? bottomGrid + cellH : bottomGrid;

  // 交界处 = 图案(含下编号圈)的最底边
  var junctionY = hasBottomNum ? (bottomGrid + cellH) : bottomGrid;

  console.log('[grid] 成功: cols=' + cols + ' rows=' + rows + ' cellW=' + cellW + ' cellH=' + cellH +
    ' grid=(' + leftGrid + ',' + topGrid + ')-(' + rightGrid + ',' + bottomGrid + ')' +
    ' 编号圈 L/T/R/B=' + hasLeftNum + '/' + hasTopNum + '/' + hasRightNum + '/' + hasBottomNum +
    ' junctionY=' + junctionY);

  return {
    x0: x0, y0: y0, x1: x1, y1: y1, junctionY: junctionY,
    cols: cols, rows: rows,
    hasLeftNum: hasLeftNum, hasTopNum: hasTopNum, hasRightNum: hasRightNum, hasBottomNum: hasBottomNum,
    grid: { left: leftGrid, right: rightGrid, top: topGrid, bottom: bottomGrid, cellW: cellW, cellH: cellH }
  };
}

// ============ 图例检测与读取 ============

function parseLegend(data, w, h, grid, labPalette) {
  var legendTop = detectLegendTop(data, w, h, grid);
  var legendH = h - legendTop;
  if (legendH < 20) return [];

  // 水平投影找图例行
  var rowProj = new Float32Array(legendH);
  for (var py = 0; py < legendH; py++) {
    var aY = legendTop + py;
    var sum = 0, cnt = 0;
    for (var px = 10; px < Math.min(w - 10, w); px++) {
      var idx = (aY * w + px) * 4;
      sum += (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      cnt++;
    }
    rowProj[py] = sum / Math.max(1, cnt);
  }

  var avgBrightness = rowProj.reduce(function(a, b) { return a + b; }, 0) / rowProj.length;
  var inRow = false;
  var rowStarts = [], rowEnds = [];
  for (var rY = 0; rY < legendH; rY++) {
    var bright = rowProj[rY] > avgBrightness;
    if (bright && !inRow) { inRow = true; rowStarts.push(rY); }
    else if (!bright && inRow) { inRow = false; rowEnds.push(rY); }
  }
  if (inRow) rowEnds.push(legendH - 1);

  var rows = [];
  for (var ri = 0; ri < Math.min(rowStarts.length, rowEnds.length); ri++) {
    var rs = rowStarts[ri], re = rowEnds[ri];
    if (re - rs < 8) continue;
    if (rows.length > 0 && rs - rows[rows.length - 1].end < 4) rows[rows.length - 1].end = re;
    else rows.push({ start: rs, end: re });
  }

  // 回退: 均匀扫描
  if (rows.length < 2) {
    var rowH = Math.floor(legendH / 8);
    for (var i = 0; i < 8; i++) {
      var startY = legendTop + i * rowH;
      var endY = legendTop + (i + 1) * rowH;
      if (startY < h - 10) rows.push({ start: startY - legendTop, end: endY - legendTop });
    }
  }

  // 逐行读取
  var legend = [];
  var seenIds = {};

  for (var ri2 = 0; ri2 < rows.length; ri2++) {
    var row = rows[ri2];
    var rowH = row.end - row.start;
    var rMid = legendTop + Math.floor((row.start + row.end) / 2);
    if (rMid >= h) continue;

    var swatch = findSwatch(data, w, h, 5, rMid - Math.floor(rowH / 2), Math.min(w - 10, 400), rowH, labPalette);
    if (!swatch) continue;

    if (seenIds[swatch.id]) continue;
    seenIds[swatch.id] = true;

    var qty = readQuantity(data, w, h, swatch.right + 4, rMid - Math.floor(rowH / 2), Math.min(w - swatch.right - 14, 150), rowH);

    legend.push({ id: swatch.id, hex: swatch.hex, rgb: swatch.rgb, qty: qty });
  }

  return legend;
}

function findSwatch(data, w, h, sx, sy, maxW, swatchH, labPalette) {
  for (var x = sx; x < sx + maxW; x += 2) {
    var samples = [];
    for (var dy = 0; dy < swatchH; dy++) {
      for (var dx = 0; dx < 3; dx++) {
        var p = getPixel(data, w, h, x + dx, sy + dy);
        if (p && p[3] >= 128) samples.push([p[0], p[1], p[2]]);
      }
    }

    if (samples.length < swatchH * 2) continue;

    var med = medianColor(samples);
    var variance = 0;
    for (var vi = 0; vi < Math.min(samples.length, 20); vi++) {
      variance += Math.abs(samples[vi][0] - med[0]) + Math.abs(samples[vi][1] - med[1]) + Math.abs(samples[vi][2] - med[2]);
    }
    variance /= Math.min(samples.length, 20);

    if (variance > 60) continue;

    var matched = matchLab(med, labPalette);
    if (!matched) continue;

    var right = x + 3;
    var midY = sy + Math.floor(swatchH / 2);
    var matchLabObj = rgbToLab(matched.rgb[0], matched.rgb[1], matched.rgb[2]);
    for (var rx = x + 4; rx < sx + maxW; rx++) {
      var rp = getPixel(data, w, h, rx, midY);
      if (!rp) break;
      var rd = deltaE76(rgbToLab(rp[0], rp[1], rp[2]), matchLabObj);
      if (rd > 10) break;
      right = rx;
    }

    return { id: matched.id, hex: matched.hex, rgb: matched.rgb, right: right };
  }

  return null;
}

// ============ 连通域数字识别 ============

function connectedComponents(gray, w, h) {
  var labels = new Int32Array(w * h).fill(-1);
  var comps = [];

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (gray[y * w + x] !== 0) continue;
      if (labels[y * w + x] !== -1) continue;

      var label = comps.length;
      var stack = [[x, y]];
      labels[y * w + x] = label;
      var minX = x, maxX = x, minY = y, maxY = y, size = 0;

      while (stack.length) {
        var p = stack.pop();
        var cx = p[0], cy = p[1];
        size++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;

        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (labels[ny * w + nx] !== -1) continue;
            if (gray[ny * w + nx] !== 0) continue;
            labels[ny * w + nx] = label;
            stack.push([nx, ny]);
          }
        }
      }

      comps.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, size: size });
    }
  }

  return comps;
}

/**
 * 归一化匹配：把连通域边界框缩放到模板尺寸，做互相关
 */
function matchCharTemplate(gray, gw, gh, comp, template) {
  var bw = comp.x1 - comp.x0 + 1, bh = comp.y1 - comp.y0 + 1;
  if (bw < 2 || bh < 2) return 0;
  var tw = template.w, th = template.h;
  var td = template.data.data;

  var tMean = 0, rMean = 0, count = 0;
  var samples = [];

  for (var ty = 0; ty < th; ty++) {
    var sy = comp.y0 + Math.floor(ty * bh / th);
    for (var tx = 0; tx < tw; tx++) {
      var ti = (ty * tw + tx) * 4;
      if (td[ti + 3] === 0) continue; // 跳过透明(模板背景)
      var sx = comp.x0 + Math.floor(tx * bw / tw);
      var gv = gray[sy * gw + sx];
      samples.push([gv, td[ti]]);
      tMean += td[ti];
      rMean += gv;
      count++;
    }
  }
  if (count < 10) return 0;
  tMean /= count; rMean /= count;

  var match = 0, normT = 0, normR = 0;
  for (var i = 0; i < samples.length; i++) {
    var tv = samples[i][1] - tMean;
    var rv = samples[i][0] - rMean;
    match += tv * rv;
    normT += tv * tv;
    normR += rv * rv;
  }
  if (normT === 0 || normR === 0) return 0;
  return Math.max(0, match / Math.sqrt(normT * normR));
}

/**
 * 连通域识别图例数量文字 (色块右侧的数字)
 */
function otsuThreshold(lum, n) {
  var hist = new Array(256).fill(0);
  for (var i = 0; i < n; i++) {
    var v = Math.round(lum[i]);
    if (v < 0) v = 0; else if (v > 255) v = 255;
    hist[v]++;
  }
  var total = n;
  var sum = 0;
  for (var t = 0; t < 256; t++) sum += t * hist[t];
  var sumB = 0, wB = 0, maxVar = 0, threshold = 127;
  for (var t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    var wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    var mB = sumB / wB;
    var mF = (sum - sumB) / wF;
    var varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

function readQuantity(data, w, h, sx, sy, maxW, maxH) {
  if (sx < 0 || sy < 0) return null;
  maxW = Math.min(maxW, w - sx);
  maxH = Math.min(maxH, h - sy);
  if (maxW < 5 || maxH < 5) return null;

  // 二值化 (Otsu 自适应阈值)
  var lum = new Float32Array(maxW * maxH);
  for (var y = 0; y < maxH; y++) {
    var rowBase = (sy + y) * w;
    for (var x = 0; x < maxW; x++) {
      var idx = (rowBase + sx + x) * 4;
      lum[y * maxW + x] = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
    }
  }
  var threshold = otsuThreshold(lum, maxW * maxH);
  var gray = new Float32Array(maxW * maxH);
  for (var i = 0; i < lum.length; i++) gray[i] = lum[i] < threshold ? 0 : 255;

  // 连通域分割
  var comps = connectedComponents(gray, maxW, maxH);
  comps = comps.filter(function(c) {
    var cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    return c.size >= 3 && cw >= 2 && ch >= 3;
  });
  if (!comps.length) return null;

  comps.sort(function(a, b) { return a.x0 - b.x0; });

  // 多字号模板匹配 (应对实际字号浮动)
  var digits = '';
  for (var i = 0; i < comps.length; i++) {
    var comp = comps[i];
    var bestDigit = '', bestScore = 0;
    for (var fs = 10; fs <= 18; fs += 2) {
      var templates = ensureCharTemplates(fs);
      for (var d = 0; d <= 9; d++) {
        var t = templates[String(d)];
        if (!t) continue;
        var score = matchCharTemplate(gray, maxW, maxH, comp, t);
        if (score > bestScore) { bestScore = score; bestDigit = String(d); }
      }
    }
    if (bestScore > 0.32) digits += bestDigit;
  }

  if (digits.length >= 2) {
    var qty = parseInt(digits, 10);
    if (qty > 0 && qty < 100000) return qty;
  }

  return null;
}

// ============ 交叉验证 ============

function crossValidate(legend, gridCounts) {
  if (!legend || legend.length < 2) return null;

  var mismatches = [];
  for (var i = 0; i < legend.length; i++) {
    var le = legend[i];
    if (!le.qty) continue;

    var gridCount = gridCounts[le.id] || 0;
    var tolerance = Math.max(le.qty * 0.05, 2);

    if (Math.abs(gridCount - le.qty) > tolerance) {
      mismatches.push({
        id: le.id,
        hex: le.hex,
        expected: le.qty,
        recognized: gridCount,
        diff: gridCount - le.qty,
      });
    }
  }

  return mismatches.length > 0 ? mismatches : null;
}

// ============ 降级 ============

function fallbackImport(data, w, h, labPalette, converter) {
  var rows = 29, cols = 29;
  var cellW = w / cols, cellH = h / rows;
  var codes = Array.from({ length: rows }, function() { return new Array(cols).fill(null); });
  var colorHits = 0;
  for (var y = 0; y < rows; y++) {
    for (var x = 0; x < cols; x++) {
      var cx = Math.round(x * cellW + cellW / 2);
      var cy = Math.round(y * cellH + cellH / 2);
      var code = readCellByMode(data, w, h, cx, cy, cellW, cellH, labPalette);
      if (code) { colorHits++; codes[y][x] = code; }
    }
  }
  return {
    matrix: buildMatrix(codes, rows, cols, converter),
    confidence: 'low',
    details: { rows: rows, cols: cols, cellSize: Math.floor(cellW), colorHits: colorHits, legendSize: 0 },
  };
}

function buildMatrix(codes, rows, cols, converter) {
  var matrix = [];
  var palette = converter ? converter.labPalette : [];
  for (var y = 0; y < rows; y++) {
    var row = [];
    for (var x = 0; x < cols; x++) {
      var code = codes[y] ? codes[y][x] : null;
      if (!code) { row.push(null); continue; }
      var def = palette.find(function(c) { return c.id === code; });
      row.push(def ? { id: def.id, name: def.id, hex: def.hex, rgb: def.rgb, category: def.group || '?' } : { id: code, name: code, hex: '#ccc', rgb: [204, 204, 204], category: '?' });
    }
    matrix.push(row);
  }
  return matrix;
}
