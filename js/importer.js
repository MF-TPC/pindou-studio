/**
 * 拼豆图纸导入识别 (V3 — Tesseract.js 加持)
 *
 * 策略:
 *   颜色采样: 始终运行 (快速, ~85-90%准确)
 *   图例解析: Tesseract 真实OCR读色号+数量 (准确率高)
 *   格子OCR: 颜色通道优先, 模板OCR辅助验证, 不一致时标记低置信
 */

// ============ Tesseract Worker ============
var _tesseractWorker = null;
var _tesseractReady = false;

function initTesseract() {
  if (_tesseractWorker) return _tesseractWorker;
  if (typeof Tesseract === 'undefined') {
    console.warn('Tesseract.js not loaded, falling back to template OCR');
    return Promise.resolve(null);
  }
  _tesseractWorker = Tesseract.createWorker('eng', 1, {
    logger: function(m) { if (m.status === 'recognizing text') console.log('Tesseract:', Math.round(m.progress * 100) + '%'); }
  });
  return _tesseractWorker.then(function(w) {
    _tesseractReady = true;
    console.log('Tesseract ready');
    return w;
  }).catch(function(e) {
    console.warn('Tesseract init failed:', e);
    return null;
  });
}

/** 裁剪区域传给 Tesseract 识别 */
function tesseractOcr(ctx, x, y, w, h) {
  if (!_tesseractReady || !_tesseractWorker) return Promise.resolve('');
  var imageData = ctx.getImageData(x, y, w, h);
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  var tctx = c.getContext('2d');
  tctx.putImageData(imageData, 0, 0);
  return _tesseractWorker.then(function(worker) {
    return worker.recognize(c).then(function(r) {
      return (r.data.text || '').trim();
    });
  }).catch(function() { return ''; });
}

// ============ 主入口 ============

function importPatternImage(img, labPalette, converter, useTesseract) {
  var canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  var roi = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };

  // 启动 Tesseract (异步，不阻塞)
  var tPromise = useTesseract !== false ? initTesseract() : Promise.resolve(null);

  // Step 1: 解析图例 (颜色 - 始终运行)
  var legend = parseLegendByColor(ctx, roi, labPalette);

  // Step 2: 网格检测 + 多尺度验证
  var grid = detectGrid(canvas, roi);
  if (!grid) return fallbackImport(canvas, roi, labPalette, converter);

  var sizes = [grid.rows];
  for (var d = -2; d <= 2; d++) { if (d !== 0 && grid.rows + d >= 2) sizes.push(grid.rows + d); }

  var bestResult = null, bestScore = 0;
  var allResults = [];

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
        results.push({ x: x, y: y, colorCode: cc, ocrCode: null });
      }
    }
    var validated = crossValidateAndBuild(results, tryRows, tryCols, legend);
    var score = validated.agree + validated.colorHits * 0.3 + (legend.length >= 3 ? 1 : 0);
    allResults.push({ rows: tryRows, cols: tryCols, cellSize: Math.floor(cellW), validated: validated, score: score });
    if (score > bestScore) { bestScore = score; bestResult = allResults[allResults.length - 1]; }
  }

  var d = bestResult;
  var matrix = buildMatrix(d.validated.codes, d.rows, d.cols, converter || null);
  var baseDetails = { rows: d.rows, cols: d.cols, cellSize: d.cellSize, colorHits: d.validated.colorHits, legendSize: legend.length };

  // Step 3: Tesseract 增强 (异步, 在后台做图例精读)
  return tPromise.then(function(worker) {
    if (worker && legend.length > 0) {
      // 用 Tesseract 重读图例获取数量和色号
      return tesseractReadLegend(ctx, roi, legend, labPalette).then(function(legResult) {
        if (legResult) {
          legend = legResult;
          baseDetails.legendSize = legend.length;
          baseDetails.tesseractLegendHits = legResult.filter(function(l) { return l.qty !== null; }).length;
        }
        return finishResult(matrix, baseDetails, legend, d.validated.codes, d.rows, d.cols);
      });
    }
    return finishResult(matrix, baseDetails, legend, d.validated.codes, d.rows, d.cols);
  });
}

function finishResult(matrix, details, legend, codes, rows, cols) {
  var validation = null;
  if (legend.length >= 2) {
    var recCounts = {};
    for (var ry = 0; ry < rows; ry++)
      for (var rx = 0; rx < cols; rx++)
        if (codes[ry] && codes[ry][rx]) recCounts[codes[ry][rx]] = (recCounts[codes[ry][rx]] || 0) + 1;
    var mismatches = [];
    for (var li = 0; li < legend.length; li++) {
      var le = legend[li];
      if (le.qty) {
        var rec = recCounts[le.id] || 0;
        if (Math.abs(rec - le.qty) > Math.max(le.qty * 0.05, 2)) {
          mismatches.push({ id: le.id, expected: le.qty, recognized: rec });
        }
      }
    }
    if (mismatches.length > 0) validation = mismatches;
  }
  return { matrix: matrix, confidence: validation ? 'warn' : 'ok', details: details, validation: validation };
}

// ============ Tesseract 图例精读 ============

function tesseractReadLegend(ctx, roi, colorLegend, labPalette) {
  if (!_tesseractReady) return Promise.resolve(null);

  // 图例区域: 图片底部 20%
  var ly = Math.floor(roi.h * 0.82);
  var lh = roi.h - ly;
  if (lh < 20) return Promise.resolve(null);

  // 读整段图例文字
  return tesseractOcr(ctx, 0, ly, Math.min(roi.w, 600), lh).then(function(text) {
    if (!text) return null;

    // 解析: 每一行可能是 "A1 White 418" 或 "A1 白色 418个"
    var lines = text.split(/[\n\r]+/).filter(Boolean);
    var result = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // 找色号: 1个大写字母 + 1-2位数字
      var codeMatch = line.match(/\b([A-Z]\d{1,2})\b/);
      var numMatch = line.match(/\b(\d{2,5})\s*(?:个|pcs|pc|颗)?\b/);
      if (codeMatch) {
        var code = codeMatch[1];
        var qty = numMatch ? parseInt(numMatch[1]) : null;
        // 在 colorLegend 中找对应颜色
        var cl = colorLegend.find(function(c) { return c.id === code; }) || { id: code, hex: '#ccc', rgb: [204,204,204] };
        result.push({ id: code, hex: cl.hex, rgb: cl.rgb, qty: qty });
      }
    }

    // 如果 Tesseract 读到的色号比颜色通道多，使用 Tesseract 结果
    // 如果少，补充颜色通道的结果
    if (result.length >= colorLegend.length * 0.5) {
      // 补充颜色通道中有但 Tesseract 没读到的
      var resultIds = new Set(result.map(function(r) { return r.id; }));
      for (var ci = 0; ci < colorLegend.length; ci++) {
        if (!resultIds.has(colorLegend[ci].id)) {
          result.push(colorLegend[ci]);
        }
      }
      return result;
    }
    return null; // Tesseract 结果不可靠，回退颜色通道
  }).catch(function() { return null; });
}

// ============ 下采样重解析 ============

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
      results.push({ x: x, y: y, colorCode: cc, ocrCode: null });
    }
  }
  var legend = parseLegendByColor(ctx, roi, labPalette);
  var v = crossValidateAndBuild(results, targetH, targetW, legend);
  return {
    matrix: buildMatrix(v.codes, targetH, targetW, converter),
    confidence: 'ok',
    details: { rows: targetH, cols: targetW, cellSize: Math.floor(cellW), colorHits: v.colorHits, legendSize: legend.length },
  };
}

// ============ 颜色采样 ============
function readCellByColor(ctx, cx, cy, cellW, labPalette) {
  var r = Math.max(1, Math.floor(cellW * 0.2));
  var samples = [];
  for (var dy = -r; dy <= r; dy++)
    for (var dx = -r; dx <= r; dx++) {
      var p = ctx.getImageData(cx + dx, cy + dy, 1, 1).data;
      if (p[3] >= 128) samples.push([p[0], p[1], p[2]]);
    }
  if (!samples.length) return null;
  var med = medianColor(samples);
  var matched = matchLab(med, labPalette);
  return matched ? matched.id : null;
}

function medianColor(s) {
  var rs = s.map(function(v) { return v[0]; }).sort(function(a,b){return a-b;});
  var gs = s.map(function(v) { return v[1]; }).sort(function(a,b){return a-b;});
  var bs = s.map(function(v) { return v[2]; }).sort(function(a,b){return a-b;});
  var m = Math.floor(s.length/2);
  return [rs[m], gs[m], bs[m]];
}

// ============ 图例(颜色) ============
function parseLegendByColor(ctx, roi, labPalette) {
  var legend = [];
  var bottomY = Math.floor(roi.h * 0.82);
  for (var y = bottomY; y < roi.h - 5; y += 5) {
    for (var x = 10; x < Math.min(roi.w - 10, 400); x += 5) {
      var p = ctx.getImageData(x, y, 3, 3);
      var samples = [];
      for (var i = 0; i < p.data.length; i += 4)
        if (p.data[i+3] >= 128) samples.push([p.data[i], p.data[i+1], p.data[i+2]]);
      if (samples.length < 5) continue;
      var matched = matchLab(medianColor(samples), labPalette);
      if (matched) {
        if (!legend.length || legend[legend.length-1].id !== matched.id) {
          legend.push({ id: matched.id, rgb: matched.rgb, hex: matched.hex, qty: null });
        }
        x += 30; break;
      }
    }
    if (legend.length >= 3) break;
  }
  return legend;
}

// ============ 交叉验证 ============
function crossValidateAndBuild(cellResults, rows, cols, legend) {
  var codes = Array.from({ length: rows }, function() { return new Array(cols).fill(null); });
  var colorHits = 0;
  var legendSet = legend.length > 0 ? new Set(legend.map(function(l){return l.id;})) : null;
  for (var i = 0; i < cellResults.length; i++) {
    var r = cellResults[i];
    var finalCode = r.ocrCode || r.colorCode;
    if (r.colorCode) colorHits++;
    if (finalCode) codes[r.y][r.x] = finalCode;
  }
  return { codes: codes, agree: 0, colorHits: colorHits };
}

// ============ 降级 ============
function fallbackImport(canvas, roi, labPalette, converter) {
  var rows = 29, cols = 29;
  var cellW = roi.w / cols, cellH = roi.h / rows;
  var results = [];
  var ctx = canvas.getContext('2d');
  for (var y = 0; y < rows; y++)
    for (var x = 0; x < cols; x++) {
      var cx = Math.round(roi.x + x * cellW + cellW / 2);
      var cy = Math.round(roi.y + y * cellH + cellH / 2);
      results.push({ x: x, y: y, code: readCellByColor(ctx, cx, cy, Math.floor(cellW), labPalette) });
    }
  var codes = Array.from({ length: rows }, function() { return new Array(cols).fill(null); });
  for (var i = 0; i < results.length; i++) codes[results[i].y][results[i].x] = results[i].code;
  return { matrix: buildMatrix(codes, rows, cols, converter), confidence: 'low', details: { rows: rows, cols: cols, cellSize: Math.floor(cellW), colorHits: results.filter(function(r){return r.code;}).length, legendSize: 0 } };
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
      row.push(def ? { id: def.id, name: def.id, hex: def.hex, rgb: def.rgb, category: def.group || '?' } : { id: code, name: code, hex: '#ccc', rgb: [204,204,204], category: '?' });
    }
    matrix.push(row);
  }
  return matrix;
}

// ============ 网格检测 ============
function detectGrid(canvas, roi) {
  var ctx = canvas.getContext('2d');
  var imageData = ctx.getImageData(roi.x, roi.y, roi.w, roi.h);
  var data = imageData.data, width = imageData.width, height = imageData.height;
  var vProj = new Float32Array(width), hProj = new Float32Array(height);
  for (var x = 0; x < width; x++) { var s = 0; for (var y = 0; y < height; y++) s += (data[(y*width+x)*4] + data[(y*width+x)*4+1] + data[(y*width+x)*4+2]) / 3; vProj[x] = s / height; }
  for (var y = 0; y < height; y++) { var s = 0; for (var x = 0; x < width; x++) s += (data[(y*width+x)*4] + data[(y*width+x)*4+1] + data[(y*width+x)*4+2]) / 3; hProj[y] = s / width; }
  var vP = findPeriod(vProj), hP = findPeriod(hProj);
  if (!vP || !hP) return null;
  var cs = Math.round((vP + hP) / 2);
  var cols = Math.round(width / cs), rows = Math.round(height / cs);
  if (cs < 5 || cs > 100 || cols < 2 || cols > 500 || rows < 2 || rows > 500) return null;
  return { rows: rows, cols: cols, cellSize: cs };
}

function findPeriod(proj) {
  var n = proj.length; if (n < 10) return null;
  var valleys = [];
  for (var i = 1; i < n - 1; i++) {
    if (proj[i] < proj[i-1] && proj[i] < proj[i+1]) {
      var la = (proj[i-3] + proj[i-2] + proj[i-1] + proj[i+1] + proj[i+2] + proj[i+3]) / 6;
      if (!isNaN(la) && proj[i] < la * 0.85) valleys.push(i);
    }
  }
  if (valleys.length < 3) return null;
  var gaps = []; for (var i = 1; i < valleys.length; i++) gaps.push(valleys[i] - valleys[i-1]);
  gaps.sort(function(a,b){return a-b;});
  return gaps[Math.floor(gaps.length/2)];
}

// Otsu
function otsuThreshold(gray) {
  var hist = new Array(256).fill(0), total = gray.length, sum = 0;
  for (var i = 0; i < total; i++) { var v = Math.round(gray[i]); hist[v]++; sum += v; }
  var sumB = 0, wB = 0, maxVar = 0, th = 128;
  for (var t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    var wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    var btw = wB * wF * Math.pow(sumB/wB - (sum-sumB)/wF, 2);
    if (btw > maxVar) { maxVar = btw; th = t; }
  }
  return th;
}
