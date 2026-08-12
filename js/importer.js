/**
 * 拼豆图纸导入 (V3.1 — 默认颜色快速通道, OCR 按需增强)
 *
 * 默认: 颜色采样 + 多尺度网格验证 (快速, <1秒)
 * OCR增强: 动态加载 Tesseract.js → 图例精读 + 数量校验
 */

// ============ Tesseract (按需懒加载) ============
var _tesseractWorker = null;
var _tesseractLoading = false;
var _tesseractReady = false;

function loadTesseract(callback) {
  if (_tesseractReady) { callback(true); return; }
  if (_tesseractLoading) { setTimeout(function() { loadTesseract(callback); }, 500); return; }
  _tesseractLoading = true;

  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  script.onload = function() {
    _tesseractWorker = Tesseract.createWorker('eng', 1, { logger: function(m) {
      if (m.status === 'recognizing text') console.log('OCR:', Math.round(m.progress*100)+'%');
    }});
    _tesseractWorker.then(function(w) { _tesseractReady = true; callback(true); })
      .catch(function() { _tesseractLoading = false; callback(false); });
  };
  script.onerror = function() { _tesseractLoading = false; callback(false); };
  document.head.appendChild(script);
}

function tesseractOcrRegion(ctx, x, y, w, h, callback) {
  if (!_tesseractReady || !_tesseractWorker) { callback(''); return; }
  var imageData = ctx.getImageData(x, y, w, h);
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(imageData, 0, 0);
  _tesseractWorker.then(function(worker) {
    worker.recognize(c).then(function(r) { callback((r.data.text || '').trim()); })
      .catch(function() { callback(''); });
  });
}

// ============ 主入口 ============

function importPatternImage(img, labPalette, converter, enableOCR) {
  var canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  var ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  var roi = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };

  // Step 1: 图例(颜色) + 网格检测 (同步, 快)
  var legend = parseLegendByColor(ctx, roi, labPalette);
  var grid = detectGrid(canvas, roi);
  if (!grid) return Promise.resolve(fallbackImport(canvas, roi, labPalette, converter));

  // Step 2: 多尺度验证 (选最佳尺寸)
  var sizes = [grid.rows];
  for (var d = -2; d <= 2; d++) { if (d !== 0 && grid.rows + d >= 2) sizes.push(grid.rows + d); }

  var bestResult = null, bestScore = 0;

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
        results.push({ x: x, y: y, colorCode: readCellByColor(ctx, cx, cy, Math.floor(cellW), labPalette) });
      }
    }
    var validated = crossValidateAndBuild(results, tryRows, tryCols, legend);
    var score = validated.colorHits + (legend.length >= 3 ? 100 : 0);
    if (score > bestScore) { bestScore = score; bestResult = { rows: tryRows, cols: tryCols, cellSize: Math.floor(cellW), validated: validated }; }
  }

  var d = bestResult || { rows: grid.rows, cols: Math.round(grid.cols), cellSize: grid.cellSize, validated: { codes: Array.from({length: grid.rows}, function() { return []; }), colorHits: 0 } };
  var matrix = buildMatrix(d.validated.codes, d.rows, d.cols, converter || null);

  var result = {
    matrix: matrix,
    confidence: 'ok',
    details: { rows: d.rows, cols: d.cols, cellSize: d.cellSize, colorHits: d.validated.colorHits, legendSize: legend.length },
    validation: null,
  };

  // 校验
  if (legend.length >= 2) {
    var recCounts = {};
    for (var ry = 0; ry < d.rows; ry++)
      for (var rx = 0; rx < d.cols; rx++)
        if (d.validated.codes[ry] && d.validated.codes[ry][rx]) recCounts[d.validated.codes[ry][rx]] = (recCounts[d.validated.codes[ry][rx]] || 0) + 1;
    var mismatches = [];
    for (var li = 0; li < legend.length; li++) {
      var le = legend[li];
      if (le.qty) {
        var rec = recCounts[le.id] || 0;
        if (Math.abs(rec - le.qty) > Math.max(le.qty * 0.05, 2))
          mismatches.push({ id: le.id, expected: le.qty, recognized: rec });
      }
    }
    if (mismatches.length > 0) result.validation = mismatches;
  }

  // Step 3: OCR 增强 (可选, 仅图例)
  if (enableOCR) {
    return new Promise(function(resolve) {
      loadTesseract(function(ok) {
        if (!ok) { result.confidence = 'no-ocr'; resolve(result); return; }
        tesseractOcrRegion(ctx, 0, Math.floor(roi.h * 0.82), Math.min(roi.w, 500), roi.h - Math.floor(roi.h * 0.82), function(text) {
          if (text) {
            var ocrLegend = parseOcrLegendText(text, labPalette);
            if (ocrLegend.length >= legend.length * 0.5) {
              legend = ocrLegend;
              result.details.legendSize = legend.length;
              result.details.tesseractHits = legend.filter(function(l) { return l.qty !== null; }).length;
              result.confidence = 'ocr-ok';
              // 重新校验
              if (legend.length >= 2) {
                var rec2 = {};
                for (var ry2 = 0; ry2 < d.rows; ry2++)
                  for (var rx2 = 0; rx2 < d.cols; rx2++)
                    if (d.validated.codes[ry2] && d.validated.codes[ry2][rx2]) rec2[d.validated.codes[ry2][rx2]] = (rec2[d.validated.codes[ry2][rx2]] || 0) + 1;
                var m2 = [];
                for (var li2 = 0; li2 < legend.length; li2++) {
                  if (legend[li2].qty) {
                    var rc = rec2[legend[li2].id] || 0;
                    if (Math.abs(rc - legend[li2].qty) > Math.max(legend[li2].qty * 0.05, 2))
                      m2.push({ id: legend[li2].id, expected: legend[li2].qty, recognized: rc });
                  }
                }
                if (m2.length > 0) result.validation = m2;
              }
            }
          }
          resolve(result);
        });
      });
    });
  }

  return Promise.resolve(result);
}

function parseOcrLegendText(text, labPalette) {
  var lines = text.split(/[\n\r]+/).filter(Boolean);
  var result = [];
  for (var i = 0; i < lines.length; i++) {
    var codeMatch = lines[i].match(/\b([A-Z]\d{1,2})\b/);
    var numMatch = lines[i].match(/\b(\d{2,5})\s*(?:个|pcs|颗)?\b/);
    if (codeMatch) {
      var code = codeMatch[1];
      var cl = labPalette.find(function(c) { return c.id === code; });
      result.push({
        id: code,
        hex: cl ? cl.hex : '#ccc',
        rgb: cl ? cl.rgb : [204, 204, 204],
        qty: numMatch ? parseInt(numMatch[1]) : null,
      });
    }
  }
  return result;
}

// ============ 重采样 (始终颜色通道) ============

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
      results.push({ x: x, y: y, colorCode: readCellByColor(ctx, cx, cy, Math.floor(cellW), labPalette) });
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
  var rs = s.map(function(v) { return v[0]; }).sort(function(a, b) { return a - b; });
  var gs = s.map(function(v) { return v[1]; }).sort(function(a, b) { return a - b; });
  var bs = s.map(function(v) { return v[2]; }).sort(function(a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return [rs[m], gs[m], bs[m]];
}

// ============ 图例(颜色) ============
function parseLegendByColor(ctx, roi, labPalette) {
  var legend = [];
  for (var y = Math.floor(roi.h * 0.82); y < roi.h - 5; y += 5) {
    for (var x = 10; x < Math.min(roi.w - 10, 400); x += 5) {
      var p = ctx.getImageData(x, y, 3, 3);
      var samples = [];
      for (var i = 0; i < p.data.length; i += 4)
        if (p.data[i + 3] >= 128) samples.push([p.data[i], p.data[i + 1], p.data[i + 2]]);
      if (samples.length < 5) continue;
      var matched = matchLab(medianColor(samples), labPalette);
      if (matched) {
        if (!legend.length || legend[legend.length - 1].id !== matched.id) {
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
function crossValidateAndBuild(results, rows, cols, legend) {
  var codes = Array.from({ length: rows }, function() { return new Array(cols).fill(null); });
  var colorHits = 0;
  for (var i = 0; i < results.length; i++) {
    if (results[i].colorCode) { colorHits++; codes[results[i].y][results[i].x] = results[i].colorCode; }
  }
  return { codes: codes, colorHits: colorHits };
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
  return { matrix: buildMatrix(codes, rows, cols, converter), confidence: 'low', details: { rows: rows, cols: cols, cellSize: Math.floor(cellW), colorHits: results.filter(function(r) { return r.code; }).length, legendSize: 0 } };
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

// ============ 网格检测 ============
function detectGrid(canvas, roi) {
  var ctx = canvas.getContext('2d');
  var imageData = ctx.getImageData(roi.x, roi.y, roi.w, roi.h);
  var data = imageData.data, width = imageData.width, height = imageData.height;
  var vProj = new Float32Array(width), hProj = new Float32Array(height);
  for (var x = 0; x < width; x++) { var s = 0; for (var y = 0; y < height; y++) s += (data[(y * width + x) * 4] + data[(y * width + x) * 4 + 1] + data[(y * width + x) * 4 + 2]) / 3; vProj[x] = s / height; }
  for (var y = 0; y < height; y++) { var s = 0; for (var x = 0; x < width; x++) s += (data[(y * width + x) * 4] + data[(y * width + x) * 4 + 1] + data[(y * width + x) * 4 + 2]) / 3; hProj[y] = s / width; }
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
    if (proj[i] < proj[i - 1] && proj[i] < proj[i + 1]) {
      var la = (proj[i - 3] + proj[i - 2] + proj[i - 1] + proj[i + 1] + proj[i + 2] + proj[i + 3]) / 6;
      if (!isNaN(la) && proj[i] < la * 0.85) valleys.push(i);
    }
  }
  if (valleys.length < 3) return null;
  var gaps = []; for (var i = 1; i < valleys.length; i++) gaps.push(valleys[i] - valleys[i - 1]);
  gaps.sort(function(a, b) { return a - b; });
  return gaps[Math.floor(gaps.length / 2)];
}
