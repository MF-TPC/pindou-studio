/**
 * 拼豆工作室 — 主控制器 (V2)
 * 双模式: 图纸转换 (convert) + 定位辅助 (assist)
 */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const renderer = createRenderer();

  // ============ State ============
  const S = {
    mode: 'convert',

    // Convert
    image: null, matrix: null, stats: null, converter: null,
    paletteId: 'mard-221', targetW: 58, targetH: 58,
    matchAlgo: 'median-cut',
    renderStyle: 'symbol', showGrid: true, cellSize: 20,
    zoom: 1, lockAspect: false, aspectRatio: 1,

    // Assist
    boardConfig: createBoardConfig(),
    assistant: null, colorMatrix: null,

    // Edit
    editHistory: [],
  };

  // ============ Init ============
  function init() {
    syncConverter();
    bindEvents();
    updateBoardPreview();
    switchMode('convert');
    showPlaceholder();
  }

  function syncConverter() {
    const p = getPalette(S.paletteId);
    if (!p) { toast('色板加载失败', 'error'); return; }
    S.converter = createConverter(p);
  }

  // ============ Mode ============
  function switchMode(mode) {
    S.mode = mode;
    $('#tab-convert').classList.toggle('active', mode === 'convert');
    $('#tab-assist').classList.toggle('active', mode === 'assist');
    $('#conv-panel').classList.toggle('hidden', mode !== 'convert');
    $('#asst-panel').classList.toggle('hidden', mode !== 'assist');

    if (mode === 'convert' && S.matrix) {
      updateRendererOpts(); renderConvert(); updateStatsPanel();
    } else if (mode === 'assist' && S.assistant) {
      updateRendererOpts(); renderAssist(); updateAssistUI();
    } else {
      showPlaceholder();
      if (mode === 'assist') $('#stats-panel').classList.add('hidden');
    }
  }

  // ============ Events ============
  function bindEvents() {
    $('#tab-convert').addEventListener('click', () => switchMode('convert'));
    $('#tab-assist').addEventListener('click', () => switchMode('assist'));

    // Image import
    const dz = $('#drop-zone');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('dragover');
      if (e.dataTransfer.files[0]) loadImage(e.dataTransfer.files[0], false);
    });
    $('#upload-btn').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', () => {
      if ($('#file-input').files[0]) loadImage($('#file-input').files[0], false);
    });
    $('#import-pattern-btn').addEventListener('click', () => {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = function() {
        if (!inp.files[0]) return;
        var reader = new FileReader();
        reader.onload = function(e) {
          var img = new Image();
          img.onload = function() {
            var p = getPalette(S.paletteId);
            var lp = precomputeLab(p.colors);
            var result = importPatternImage(img, lp, S.converter);
            S.matrix = result.matrix;
            S.targetW = result.matrix[0] ? result.matrix[0].length : 29;
            S.targetH = result.matrix.length;
            $('#width-input').value = S.targetW;
            $('#height-input').value = S.targetH;
            S.stats = S.converter.getStats(S.matrix);
            S.image = null; // 标记非原图转换
            updateRendererOpts(); renderConvert(); updateStatsPanel();
            $('#drop-zone').classList.add('has-image');
            var d = result.details || {};
            toast('图纸导入: ' + (d.rows||'?') + '×' + (d.cols||'?') + ' | OCR:' + (d.ocrHits||0) + ' 颜色:' + (d.colorHits||0) + ' [' + result.confidence + ']', 'success');
          };
          img.onerror = function() { toast('图片加载失败', 'error'); };
          img.src = e.target.result;
        };
        reader.readAsDataURL(inp.files[0]);
      };
      inp.click();
    });
    document.addEventListener('paste', e => {
      for (const it of e.clipboardData?.items || []) {
        if (it.type.startsWith('image/')) {
          e.preventDefault(); loadImage(it.getAsFile(), false); break;
        }
      }
    });

    // Match algo
    $('#match-algo').addEventListener('change', () => {
      S.matchAlgo = $('#match-algo').value;
      if (S.image) doConvert();
    });

    // Palette
    $('#palette-select').addEventListener('change', () => {
      S.paletteId = $('#palette-select').value;
      syncConverter(); if (S.image) doConvert();
    });

    // Size
    $('#width-input').addEventListener('input', () => {
      S.targetW = clamp(1, 500, parseInt($('#width-input').value) || 29);
      if (S.lockAspect && S.aspectRatio) {
        S.targetH = clamp(1, 500, Math.round(S.targetW / S.aspectRatio));
        $('#height-input').value = S.targetH;
      }
      if (S.image) doConvert();
    });
    $('#height-input').addEventListener('input', () => {
      S.targetH = clamp(1, 500, parseInt($('#height-input').value) || 29);
      if (S.lockAspect && S.aspectRatio) {
        S.targetW = clamp(1, 500, Math.round(S.targetH * S.aspectRatio));
        $('#width-input').value = S.targetW;
      }
      if (S.image) doConvert();
    });
    $('#aspect-lock').addEventListener('click', () => {
      S.lockAspect = !S.lockAspect;
      const btn = $('#aspect-lock');
      btn.classList.toggle('active', S.lockAspect);
      btn.textContent = S.lockAspect ? '🔒' : '🔓';
      if (S.lockAspect && S.stats) S.aspectRatio = S.stats.width / S.stats.height;
    });

    // Render
    $('#style-solid').addEventListener('click', () => setStyle('solid'));
    $('#style-symbol').addEventListener('click', () => setStyle('symbol'));
    $('#grid-toggle').addEventListener('change', () => {
      S.showGrid = $('#grid-toggle').checked; updateRendererOpts(); rerender();
    });
    // Zoom
    $('#zoom-in').addEventListener('click', () => changeZoom(0.2));
    $('#zoom-out').addEventListener('click', () => changeZoom(-0.2));
    $('#zoom-reset').addEventListener('click', () => { S.zoom = 1; $('#zoom-label').textContent = '100%'; rerender(); });
    $('#btn-fit').addEventListener('click', fitToScreen);
    $('#canvas-wrap').addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); changeZoom(e.deltaY < 0 ? 0.15 : -0.15); }
    }, { passive: false });

    // Export
    $('#export-png').addEventListener('click', handleExportPNG);
    $('#export-print').addEventListener('click', () => { if (S.matrix || S.colorMatrix) exportPrint(); else toast('请先生成图纸', 'warn'); });
    $('#export-json').addEventListener('click', handleExportJSON);
    $('#import-json').addEventListener('click', handleImportJSON);
    $('#copy-clip').addEventListener('click', handleCopyClip);

    // Board
    $('#guide-spacing').addEventListener('input', () => {
      S.boardConfig.guideSpacing = parseInt($('#guide-spacing').value);
      $('#guide-spacing-label').textContent = S.boardConfig.guideSpacing + '格';
      updateBoardPreview(); refreshAssist();
    });
    $('#guide-offset').addEventListener('input', () => {
      S.boardConfig.guideOffset = parseInt($('#guide-offset').value);
      $('#guide-offset-label').textContent = S.boardConfig.guideOffset + '格';
      updateBoardPreview(); refreshAssist();
    });
    $('#guide-presets').addEventListener('change', () => {
      const p = GUIDE_PRESETS[parseInt($('#guide-presets').value)];
      if (p) {
        S.boardConfig.guideSpacing = p.spacing; S.boardConfig.guideOffset = p.offset;
        $('#guide-spacing').value = p.spacing; $('#guide-offset').value = p.offset;
        $('#guide-spacing-label').textContent = p.spacing + '格';
        $('#guide-offset-label').textContent = p.offset + '格';
        updateBoardPreview(); refreshAssist();
      }
    });
    $('#apply-board').addEventListener('click', applyBoardConfig);

    // Assist import
    $('#asst-import-img').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = () => { if (inp.files[0]) loadImage(inp.files[0], true); };
      inp.click();
    });
    $('#asst-from-conv').addEventListener('click', () => {
      if (!S.matrix) { toast('请先在转换模式生成图纸', 'warn'); return; }
      enterAssistMode(S.matrix);
    });

    // Batch
    $('#btn-advance').addEventListener('click', advanceBatch);
    $('#btn-revert').addEventListener('click', revertBatch);
    $('#btn-focus').addEventListener('click', enterFocusMode);

    // Canvas click: assist=toggle, convert=edit cell
    $('#preview-canvas').addEventListener('click', e => {
      if (_cropMode) return;
      if (S.mode === 'assist') { handleCanvasClick(e); return; }
      editCellAtEvent(e);
    });
    // Long press for mobile
    var _longPressTimer = null;
    $('#preview-canvas').addEventListener('touchstart', e => {
      if (_cropMode || S.mode !== 'convert' || !S.matrix) return;
      if (e.touches.length === 1) {
        _longPressTimer = setTimeout(function() {
          editCellAtEvent(e.touches[0]);
          _longPressTimer = null;
        }, 500);
      }
    });
    $('#preview-canvas').addEventListener('touchend', () => { clearTimeout(_longPressTimer); });
    $('#preview-canvas').addEventListener('touchmove', () => { clearTimeout(_longPressTimer); });
    // Right-click also works
    $('#preview-canvas').addEventListener('contextmenu', e => {
      e.preventDefault();
      if (_cropMode) return;
      if (S.mode === 'assist') { handleCanvasClick(e); return; }
      editCellAtEvent(e);
    });

    function editCellAtEvent(e) {
      if (!S.matrix) return;
      var rc = $('#preview-canvas').getBoundingClientRect();
      var cs = S.cellSize * S.zoom, pad = 3 * cs;
      var sx = (e.clientX - rc.left) * ($('#preview-canvas').width / rc.width);
      var sy = (e.clientY - rc.top) * ($('#preview-canvas').height / rc.height);
      var cx = Math.floor((sx - pad) / cs), cy = Math.floor((sy - pad) / cs);
      if (cx >= 0 && cy >= 0 && S.matrix[cy] && cx < S.matrix[cy].length) {
        showColorPicker(e.clientX, e.clientY, function(newColor) {
          replaceCell(cx, cy, newColor);
        });
      }
    }
  }

  function refreshAssist() {
    if (S.mode === 'assist' && S.assistant) renderAssist();
  }

  function handleCanvasClick(e) {
    if (S.mode !== 'assist' || !S.assistant) return;
    const rect = $('#preview-canvas').getBoundingClientRect();
    const cs = S.cellSize * S.zoom;
    const pad = 3 * cs;
    const sx = (e.clientX - rect.left) * ($('#preview-canvas').width / rect.width);
    const sy = (e.clientY - rect.top) * ($('#preview-canvas').height / rect.height);
    const cx = Math.floor((sx - pad) / cs);
    const cy = Math.floor((sy - pad) / cs);
    if (cx < 0 || cy < 0) return;
    S.assistant.toggleCell(cx, cy);
    renderAssist();
    updateAssistUI();
  }

  // ============ Image ============
  function loadImage(file, forAssist) {
    if (!file || !file.type.startsWith('image/')) { toast('请选择图片文件', 'warn'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => forAssist ? importFromImage(img) : loadConvertImage(img);
      img.onerror = () => toast('图片加载失败', 'error');
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function loadConvertImage(img) {
    S.image = img;
    S.aspectRatio = img.naturalWidth / img.naturalHeight;
    if (!S.lockAspect) {
      const sz = smartInitSize(img.naturalWidth, img.naturalHeight);
      S.targetW = sz.width; S.targetH = sz.height;
      $('#width-input').value = S.targetW; $('#height-input').value = S.targetH;
    }
    doConvert();
    $('#drop-zone').classList.add('has-image');
  }

  function importFromImage(img) {
    const p = getPalette(S.paletteId);
    const labPalette = precomputeLab(p.colors);
    const result = importPatternImage(img, labPalette, S.converter);

    const d = result.details || {};
    toast(`导入: ${d.rows||'?'}×${d.cols||'?'} | OCR:${d.ocrHits||0} 颜色:${d.colorHits||0} 一致:${d.agree||0} [${result.confidence}]`, 'success');
    enterAssistMode(result.matrix);
  }

  // ============ Convert ============
  function doConvert() {
    if (!S.image || !S.converter) return;
    const r = S.converter.convert(S.image, S.targetW, S.targetH, S.matchAlgo);
    S.matrix = r.matrix; S.stats = r.stats;
    updateRendererOpts(); renderConvert(); updateStatsPanel();
  }

  function setStyle(s) {
    S.renderStyle = s;
    $('#style-solid').classList.toggle('active', s === 'solid');
    $('#style-symbol').classList.toggle('active', s === 'symbol');
    updateRendererOpts(); rerender();
  }

  function updateRendererOpts() {
    renderer.setOptions({
      cellSize: S.cellSize, renderStyle: S.renderStyle, showGrid: S.showGrid,
      boardLineColor: '#b040e0',
    });
  }

  function renderConvert() {
    if (!S.matrix) return;
    if (S.zoom === 1) renderer.renderConvert($('#preview-canvas'), S.matrix, S.boardConfig);
    else renderer.renderZoomed($('#preview-canvas'), S.matrix, S.zoom, S.boardConfig);
    $('#preview-canvas').classList.remove('empty');
    fixScroll();
  }

  function renderAssist() {
    if (!S.assistant) return;
    renderer.renderAssist(
      $('#preview-canvas'), S.assistant.getPaddedMatrix(),
      S.assistant.getStatusMatrix(), S.boardConfig,
      S.assistant.getIsolated(), S.zoom
    );
    $('#preview-canvas').classList.remove('empty');
    fixScroll();
  }

  function rerender() {
    if (S.mode === 'convert' && S.matrix) {
      if (_cropMode) renderCropOverlay(); else renderConvert();
    }
    else if (S.mode === 'assist' && S.assistant) renderAssist();
  }

  function fixScroll() {
    var area = $('#canvas-area');
    var wrap = $('#canvas-wrap');
    var c = $('#preview-canvas');
    var aw = area.clientWidth, ah = area.clientHeight;
    var cw = c.width, ch = c.height;

    // 居中: canvas 比视口小时用 margin, 大时用 scroll
    if (cw <= aw) {
      wrap.style.marginLeft = Math.floor((aw - cw) / 2) + 'px';
    } else {
      wrap.style.marginLeft = '0';
      area.scrollLeft = Math.max(0, Math.floor((cw - aw) / 2));
    }
    if (ch <= ah) {
      wrap.style.marginTop = Math.floor((ah - ch) / 2) + 'px';
    } else {
      wrap.style.marginTop = '0';
      area.scrollTop = Math.max(0, Math.floor((ch - ah) / 2));
    }
  }

  function changeZoom(d) {
    S.zoom = clamp(0.15, 5, Math.round((S.zoom + d) * 100) / 100);
    $('#zoom-label').textContent = Math.round(S.zoom * 100) + '%';
    rerender();
  }

  function fitToScreen() {
    const area = $('#canvas-area');
    const mw = area.clientWidth - 40, mh = area.clientHeight - 40;
    let cw, ch;
    if (S.mode === 'convert' && S.matrix) {
      cw = S.matrix[0].length * S.cellSize + 6 * S.cellSize;
      ch = S.matrix.length * S.cellSize + 6 * S.cellSize;
    } else if (S.mode === 'assist' && S.assistant) {
      cw = S.boardConfig.width * S.cellSize + 6 * S.cellSize;
      ch = S.boardConfig.height * S.cellSize + 6 * S.cellSize;
    } else return;
    S.zoom = clamp(0.15, 5, Math.min(mw / cw, mh / ch));
    $('#zoom-label').textContent = Math.round(S.zoom * 100) + '%';
    rerender();
  }

  // ============ Stats ============
  function updateStatsPanel() {
    if (!S.stats) return;
    const st = S.stats;
    $('#total-beads').textContent = st.totalBeads;
    $('#total-colors').textContent = st.colorCount;
    $('#total-boards').textContent = st.totalBoards;
    $('#stats-panel').classList.remove('hidden');
    const list = $('#legend-list');
    list.innerHTML = '';
    for (const c of st.colors) {
      const li = document.createElement('li'); li.className = 'legend-item';
      li.innerHTML = `<span class="legend-swatch" style="background:${c.hex}"></span>
        <span class="legend-id">${c.id}</span><span class="legend-name">${c.name}</span>
        <span class="legend-count">×${c.count}</span>`;
      li.style.cursor = 'pointer';
      li.title = '点击批量替换此颜色';
      li.addEventListener('click', function(e) {
        showColorPicker(e.clientX, e.clientY, function(newColor) {
          if (newColor.id === c.id) return;
          replaceAllColor(c.id, newColor);
        });
      });
      list.appendChild(li);
    }
  }

  // ============ Board ============
  function updateBoardPreview() {
    drawBoardPreview($('#board-preview'), S.boardConfig, { cellSize: 6, guideColor: '#e03a3a' });
  }

  function applyBoardConfig() {
    S.boardConfig.width = parseInt($('#board-width').value) || 58;
    S.boardConfig.height = parseInt($('#board-height').value) || 58;
    S.boardConfig.guideSpacing = parseInt($('#guide-spacing').value);
    S.boardConfig.guideOffset = parseInt($('#guide-offset').value);
    if (S.assistant && S.colorMatrix) {
      S.assistant = createAssistant(S.colorMatrix, S.boardConfig);
      renderAssist(); updateAssistUI();
    }
    updateBoardPreview();
    toast('板子参数已更新', 'success');
  }

  // ============ Assist ============
  function enterAssistMode(matrix) {
    S.colorMatrix = matrix;
    // 自动匹配板子尺寸: 至少装下图纸，向上取整到 29 的倍数
    const mw = matrix[0]?.length || 29, mh = matrix.length || 29;
    S.boardConfig.width = Math.ceil(Math.max(mw, 29) / 29) * 29;
    S.boardConfig.height = Math.ceil(Math.max(mh, 29) / 29) * 29;
    $('#board-width').value = S.boardConfig.width;
    $('#board-height').value = S.boardConfig.height;
    updateBoardPreview();

    S.assistant = createAssistant(matrix, S.boardConfig);
    S.stats = S.converter ? S.converter.getStats(matrix) : null;
    switchMode('assist');
    updateAssistUI(); renderAssist();
  }

  function updateAssistUI() {
    if (!S.assistant) return;
    const batch = S.assistant.getCurrentBatch();
    const overview = S.assistant.getBatchOverview();
    const iso = S.assistant.getIsolated();

    if (batch) {
      $('#batch-color').textContent = batch.colorId + ' ' + batch.colorName;
      $('#batch-color').style.color = batch.hex;
      $('#batch-count').textContent = batch.positions.length;
      $('#batch-progress').textContent = `第 ${batch.index + 1} / ${batch.total} 批`;
    } else {
      $('#batch-color').textContent = '—';
      $('#batch-count').textContent = '0';
      $('#batch-progress').textContent = '全部完成 ✓';
    }

    const bl = $('#batch-list');
    if (bl) {
      bl.innerHTML = '';
      for (const b of overview) {
        const li = document.createElement('li'); li.className = `batch-ov-item batch-ov-${b.status}`;
        li.innerHTML = `<span class="bo-swatch" style="background:${b.hex}"></span>
          <span>${b.colorName}</span><span class="bo-count">${b.count}颗</span>`;
        bl.appendChild(li);
      }
    }

    const il = $('#iso-list');
    il.innerHTML = '';
    if (!iso.length) il.innerHTML = '<li class="iso-none">无偏远孤立点</li>';
    else for (const p of iso) {
      const li = document.createElement('li'); li.className = 'iso-item';
      const dir = p.x >= p.fromX ? '↘' : '↙';
      li.textContent = `${dir} ${p.distance}格 (${p.fromX+1},${p.fromY+1})→(${p.x+1},${p.y+1})`;
      il.appendChild(li);
    }

    if (S.stats) {
      $('#total-beads').textContent = S.stats.totalBeads;
      $('#total-colors').textContent = S.stats.colorCount;
      $('#total-boards').textContent = S.stats.totalBoards;
      $('#stats-panel').classList.remove('hidden');
    }
  }

  function advanceBatch() {
    if (!S.assistant) return;
    const r = S.assistant.advanceBatch();
    renderAssist(); updateAssistUI();
    if (r.finished) toast('🎉 全部完成!', 'success');
    else if (r.batch) toast(`下一批: ${r.batch.colorName}`, 'info');
  }

  function revertBatch() {
    if (!S.assistant) return;
    const r = S.assistant.revertBatch();
    renderAssist(); updateAssistUI();
    if (r.batch) toast(`已撤销: ${r.batch.colorName}`, 'info');
    else toast('已回初始', 'info');
  }

  // ============ Export ============
  function handleExportPNG() {
    if (!S.matrix && !S.colorMatrix) { toast('请先生成图纸', 'warn'); return; }
    exportPNG($('#preview-canvas'), 'pindou-pattern', 2)
      .then(() => toast('PNG 已下载', 'success')).catch(() => toast('导出失败', 'error'));
  }

  function handleExportJSON() {
    const m = S.matrix || S.colorMatrix;
    if (!m) { toast('请先生成图纸', 'warn'); return; }
    const st = S.stats || { width: m[0].length, height: m.length, totalBeads: 0, colorCount: 0, colors: [] };
    const json = exportJSON(m, st, S.paletteId);
    downloadBlob(json, 'pindou-pattern.json', 'application/json');
    toast('JSON 已下载', 'success');
  }

  function handleImportJSON() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const text = await f.text();
        const p = getPalette(S.paletteId);
        const { matrix } = importJSON(text, p);
        S.matrix = matrix; S.targetW = matrix[0]?.length || 0; S.targetH = matrix.length;
        $('#width-input').value = S.targetW; $('#height-input').value = S.targetH;
        S.stats = S.converter.getStats(matrix);
        updateRendererOpts(); renderConvert(); updateStatsPanel();
        $('#drop-zone').classList.add('has-image');
        toast('JSON 已导入', 'success');
      } catch (e) { toast('导入失败: ' + e.message, 'error'); }
    };
    inp.click();
  }

  function handleCopyClip() {
    if (!S.matrix && !S.colorMatrix) { toast('请先生成图纸', 'warn'); return; }
    copyToClipboard($('#preview-canvas')).then(() => toast('已复制', 'success')).catch(() => toast('复制失败', 'error'));
  }

  // ============ Utilities ============
  function clamp(min, max, v) { return Math.max(min, Math.min(max, v)); }

  function showPlaceholder() {
    const c = $('#preview-canvas'); c.width = 400; c.height = 280;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f5f3f0'; ctx.fillRect(0, 0, 400, 280);
    ctx.fillStyle = '#bbb'; ctx.font = '15px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('拖拽图片或点击上传开始', 200, 130);
    ctx.fillText('支持 Ctrl+V 粘贴', 200, 155);
    c.classList.add('empty');
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  let t;
  function toast(msg, type) {
    type = type || 'info';
    var el = $('#toast');
    el.textContent = msg; el.className = 'toast toast-' + type + ' visible';
    clearTimeout(t); t = setTimeout(function() { el.classList.remove('visible'); }, 2500);
  }

  // ============ Color Picker Popup ============
  var _pickerEl = null;

  var _pickerCleanup = null;

  function showColorPicker(x, y, callback) {
    // 清理旧 picker
    if (_pickerCleanup) { _pickerCleanup(); _pickerCleanup = null; }
    if (_pickerEl) { _pickerEl.remove(); _pickerEl = null; }

    var p = getPalette(S.paletteId);
    if (!p) return;
    var groups = getColorsByGroup(S.paletteId);

    var div = document.createElement('div');
    div.className = 'color-picker-popup';
    div.style.left = Math.min(x, window.innerWidth - 260) + 'px';
    div.style.top = Math.min(y, window.innerHeight - 400) + 'px';

    var html = '<div class="cp-header">选择色号 <button class="cp-close">&times;</button></div>';
    var entries = Object.entries(groups);
    for (var gi = 0; gi < entries.length; gi++) {
      var group = entries[gi];
      html += '<div class="cp-group-label">' + (group[1].label || group[0]) + '</div><div class="cp-row">';
      var colors = group[1].colors;
      for (var ci = 0; ci < colors.length; ci++) {
        var c = colors[ci];
        html += '<span class="cp-swatch" title="' + c.id + '" data-id="' + c.id + '" style="background:' + c.hex + '">' + c.id + '</span>';
      }
      html += '</div>';
    }
    div.innerHTML = html;
    document.body.appendChild(div);

    var close = function() {
      if (_pickerEl) { _pickerEl.remove(); _pickerEl = null; }
      if (_pickerCleanup) { _pickerCleanup(); _pickerCleanup = null; }
    };

    div.querySelector('.cp-close').onclick = close;

    var swatches = div.querySelectorAll('.cp-swatch');
    for (var si = 0; si < swatches.length; si++) {
      swatches[si].onclick = function(e) {
        e.stopPropagation();
        var id = this.getAttribute('data-id');
        var found = p.colors.find(function(c) { return c.id === id; });
        if (found) {
          close();
          callback(found);
        }
      };
    }
    _pickerEl = div;

    // 点击外部关闭 (延迟注册避免当前事件触发)
    var docHandler = function(e) {
      if (_pickerEl && !_pickerEl.contains(e.target)) {
        close();
      }
    };
    _pickerCleanup = function() {
      document.removeEventListener('click', docHandler);
    };
    setTimeout(function() {
      document.addEventListener('click', docHandler);
    }, 80);
  }

  // ============ Edit Operations ============

  function saveUndo() {
    if (!S.matrix) return;
    // 存当前矩阵的深拷贝 (只存色号ID)
    var snap = S.matrix.map(function(row) {
      return row.map(function(c) { return c ? c.id : null; });
    });
    S.editHistory.push(snap);
    if (S.editHistory.length > 20) S.editHistory.shift();
  }

  function replaceAllColor(fromId, toColor) {
    if (!S.matrix) return;
    saveUndo();
    var count = 0;
    for (var y = 0; y < S.matrix.length; y++) {
      for (var x = 0; x < S.matrix[y].length; x++) {
        var c = S.matrix[y][x];
        if (c && c.id === fromId) {
          S.matrix[y][x] = {
            id: toColor.id, name: toColor.id,
            hex: toColor.hex, rgb: toColor.rgb,
            category: toColor.group || '?',
          };
          count++;
        }
      }
    }
    S.stats = S.converter.getStats(S.matrix);
    updateRendererOpts(); renderConvert(); updateStatsPanel();
    toast('已替换 ' + count + ' 个: ' + fromId + ' → ' + toColor.id, 'success');
  }

  function replaceCell(x, y, toColor) {
    if (!S.matrix) return;
    saveUndo();
    S.matrix[y][x] = {
      id: toColor.id, name: toColor.id,
      hex: toColor.hex, rgb: toColor.rgb,
      category: toColor.group || '?',
    };
    S.stats = S.converter.getStats(S.matrix);
    updateRendererOpts(); renderConvert(); updateStatsPanel();
    toast('(' + (x+1) + ',' + (y+1) + ') → ' + toColor.id, 'success');
  }

  function undoEdit() {
    if (!S.editHistory.length) { toast('没有可撤销的操作', 'warn'); return; }
    var snap = S.editHistory.pop();
    var p = getPalette(S.paletteId);
    for (var y = 0; y < snap.length; y++) {
      for (var x = 0; x < snap[y].length; x++) {
        var id = snap[y][x];
        if (id) {
          var def = p.colors.find(function(c) { return c.id === id; });
          S.matrix[y][x] = def ? { id: def.id, name: def.id, hex: def.hex, rgb: def.rgb, category: def.group || '?' } : null;
        } else {
          S.matrix[y][x] = null;
        }
      }
    }
    S.stats = S.converter.getStats(S.matrix);
    updateRendererOpts(); renderConvert(); updateStatsPanel();
    toast('已撤销', 'info');
  }

  // Ctrl+Z
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && S.mode === 'convert') {
      e.preventDefault(); undoEdit();
    }
  });

  // ============ Crop Mode ============
  var _cropMode = false, _cropRect = null, _cropDrag = null;

  function enterCropMode() {
    if (!S.matrix) { toast('请先导入图纸', 'warn'); return; }
    _cropMode = true;
    var w = S.matrix[0].length, h = S.matrix.length;
    _cropRect = { left: 0, top: 0, right: w - 1, bottom: h - 1 };
    $('#crop-section').style.display = 'block';
    $('#crop-btn').textContent = '✂️ 裁剪中...';
    updateCropInputs();
    renderCropOverlay();
    // 鼠标事件
    $('#preview-canvas').addEventListener('mousedown', onCropMouseDown);
    window.addEventListener('mousemove', onCropMouseMove);
    window.addEventListener('mouseup', onCropMouseUp);
  }

  function exitCropMode(skipRender) {
    _cropMode = false; _cropRect = null; _cropDrag = null;
    $('#crop-section').style.display = 'none';
    $('#crop-btn').textContent = '✂️ 裁剪图纸';
    $('#preview-canvas').removeEventListener('mousedown', onCropMouseDown);
    window.removeEventListener('mousemove', onCropMouseMove);
    window.removeEventListener('mouseup', onCropMouseUp);
    if (!skipRender) renderConvert();
  }

  function updateCropInputs() {
    if (!_cropRect) return;
    $('#crop-left').value = _cropRect.left;
    $('#crop-right').value = _cropRect.right;
    $('#crop-top').value = _cropRect.top;
    $('#crop-bottom').value = _cropRect.bottom;
    $('#crop-left').max = _cropRect.right - 1;
    $('#crop-right').min = _cropRect.left + 1;
    $('#crop-top').max = _cropRect.bottom - 1;
    $('#crop-bottom').min = _cropRect.top + 1;
  }

  function canvasToGrid(ex, ey) {
    var rc = $('#preview-canvas').getBoundingClientRect();
    var cs = S.cellSize * S.zoom, pad = 3 * cs;
    var sx = (ex - rc.left) * ($('#preview-canvas').width / rc.width);
    var sy = (ey - rc.top) * ($('#preview-canvas').height / rc.height);
    return {
      x: Math.floor((sx - pad) / cs),
      y: Math.floor((sy - pad) / cs),
    };
  }

  function onCropMouseDown(e) {
    if (!_cropMode || !_cropRect) return;
    var g = canvasToGrid(e.clientX, e.clientY);
    if (g.x < 0 || g.y < 0) return;
    // 检测是否在角或边附近 (4px 容差)
    var edge = getCropEdge(g.x, g.y);
    if (edge) {
      _cropDrag = { edge: edge, startX: g.x, startY: g.y };
    } else if (g.x >= _cropRect.left && g.x <= _cropRect.right && g.y >= _cropRect.top && g.y <= _cropRect.bottom) {
      // 在选框内 → 拖拽移动整个选框
      _cropDrag = { edge: 'move', startX: g.x, startY: g.y, origRect: Object.assign({}, _cropRect) };
    }
  }

  function getCropEdge(gx, gy) {
    var r = _cropRect, tol = Math.max(4, Math.floor(12 / Math.max(1, S.zoom)));
    var nearLeft = Math.abs(gx - r.left) <= tol;
    var nearRight = Math.abs(gx - r.right) <= tol;
    var nearTop = Math.abs(gy - r.top) <= tol;
    var nearBottom = Math.abs(gy - r.bottom) <= tol;
    var inH = gy >= r.top - tol && gy <= r.bottom + tol;
    var inV = gx >= r.left - tol && gx <= r.right + tol;
    if (nearLeft && nearTop) return 'tl';
    if (nearRight && nearTop) return 'tr';
    if (nearLeft && nearBottom) return 'bl';
    if (nearRight && nearBottom) return 'br';
    if (nearLeft && inH) return 'left';
    if (nearRight && inH) return 'right';
    if (nearTop && inV) return 'top';
    if (nearBottom && inV) return 'bottom';
    if (gx > r.left && gx < r.right && gy > r.top && gy < r.bottom) return 'move';
    return null;
  }

  function onCropMouseMove(e) {
    if (!_cropDrag || !_cropRect) return;
    var g = canvasToGrid(e.clientX, e.clientY);
    var w = S.matrix[0].length, h = S.matrix.length;
    var r = _cropRect;
    var edge = _cropDrag.edge;

    if (edge === 'move') {
      var dx = g.x - _cropDrag.startX;
      var dy = g.y - _cropDrag.startY;
      var or = _cropDrag.origRect;
      var rw = or.right - or.left, rh = or.bottom - or.top;
      var nl = clamp(0, w - 1 - rw, or.left + dx);
      var nt = clamp(0, h - 1 - rh, or.top + dy);
      r.left = nl; r.right = nl + rw;
      r.top = nt; r.bottom = nt + rh;
    } else if (edge.indexOf('l') >= 0) {
      r.left = clamp(0, r.right - 1, g.x);
    } else if (edge.indexOf('r') >= 0) {
      r.right = clamp(r.left + 1, w - 1, g.x);
    }
    if (edge.indexOf('t') >= 0) {
      r.top = clamp(0, r.bottom - 1, g.y);
    } else if (edge.indexOf('b') >= 0) {
      r.bottom = clamp(r.top + 1, h - 1, g.y);
    }
    updateCropInputs();
    renderCropOverlay();
  }

  function onCropMouseUp(e) {
    _cropDrag = null;
  }

  function renderCropOverlay() {
    if (!S.matrix) return;
    renderConvert(); // 先画底图
    var cv = $('#preview-canvas');
    var ctx = cv.getContext('2d');
    var cs = S.cellSize * S.zoom, pad = 3 * cs;
    var r = _cropRect;
    if (!r) return;

    // 选框外半透明黑
    var cw = cv.width, ch = cv.height;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    // 上
    var ry0 = pad + r.top * cs;
    ctx.fillRect(0, 0, cw, ry0);
    // 下
    var ry1 = pad + (r.bottom + 1) * cs;
    ctx.fillRect(0, ry1, cw, ch - ry1);
    // 左
    ctx.fillRect(0, ry0, pad + r.left * cs, ry1 - ry0);
    // 右
    var rx1 = pad + (r.right + 1) * cs;
    ctx.fillRect(rx1, ry0, cw - rx1, ry1 - ry0);

    // 选框边线
    ctx.strokeStyle = '#4090ff'; ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(pad + r.left * cs, pad + r.top * cs, (r.right - r.left + 1) * cs, (r.bottom - r.top + 1) * cs);
    ctx.setLineDash([]);

    // 四角手柄 (外圈+内圈，大号可见)
    var corners = [
      [r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom],
    ];
    var hSize = Math.max(5, Math.floor(cs * 0.28));
    for (var ci = 0; ci < corners.length; ci++) {
      var hx = pad + corners[ci][0] * cs, hy = pad + corners[ci][1] * cs;
      // 外圈白边
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hx, hy, hSize + 1, 0, Math.PI * 2); ctx.fill();
      // 内圈蓝色
      ctx.fillStyle = '#4090ff';
      ctx.beginPath(); ctx.arc(hx, hy, hSize, 0, Math.PI * 2); ctx.fill();
    }

    // 选框四个边的中点手柄
    var mids = [
      [Math.round((r.left + r.right) / 2), r.top],
      [Math.round((r.left + r.right) / 2), r.bottom],
      [r.left, Math.round((r.top + r.bottom) / 2)],
      [r.right, Math.round((r.top + r.bottom) / 2)],
    ];
    var mSize = Math.max(3, Math.floor(cs * 0.16));
    for (var mi = 0; mi < mids.length; mi++) {
      var mx2 = pad + mids[mi][0] * cs, my2 = pad + mids[mi][1] * cs;
      ctx.fillStyle = '#4090ff';
      ctx.beginPath(); ctx.arc(mx2, my2, mSize, 0, Math.PI * 2); ctx.fill();
    }

    // 尺寸标注
    var rw = r.right - r.left + 1, rh = r.bottom - r.top + 1;
    var midX = pad + (r.left + r.right) / 2 * cs;
    var lblY = Math.max(18, pad + r.top * cs - 10);
    ctx.fillStyle = '#4090ff'; ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(rw + '×' + rh, midX, lblY);
  }

  function applyCrop() {
    if (!_cropRect || !S.matrix) return;
    saveUndo();
    var r = _cropRect;
    var newMatrix = [];
    for (var y = r.top; y <= r.bottom; y++) {
      var row = [];
      for (var x = r.left; x <= r.right; x++) {
        row.push(S.matrix[y] ? S.matrix[y][x] : null);
      }
      newMatrix.push(row);
    }
    S.matrix = newMatrix;
    S.targetW = newMatrix[0].length; S.targetH = newMatrix.length;
    $('#width-input').value = S.targetW;
    $('#height-input').value = S.targetH;
    S.stats = S.converter.getStats(S.matrix);
    exitCropMode(true);
    updateRendererOpts(); renderConvert(); updateStatsPanel();
    toast('裁剪完成: ' + S.targetW + '×' + S.targetH, 'success');
  }

  // Crop events
  $('#crop-btn').addEventListener('click', function() {
    if (_cropMode) exitCropMode(); else enterCropMode();
  });
  $('#crop-apply').addEventListener('click', applyCrop);
  $('#crop-cancel').addEventListener('click', exitCropMode);
  var cropInputs = ['crop-left', 'crop-right', 'crop-top', 'crop-bottom'];
  for (var cii = 0; cii < cropInputs.length; cii++) {
    document.getElementById(cropInputs[cii]).addEventListener('input', function() {
      if (!_cropRect) return;
      _cropRect.left = parseInt($('#crop-left').value) || 0;
      _cropRect.right = parseInt($('#crop-right').value) || _cropRect.left + 1;
      _cropRect.top = parseInt($('#crop-top').value) || 0;
      _cropRect.bottom = parseInt($('#crop-bottom').value) || _cropRect.top + 1;
      updateCropInputs();
      renderCropOverlay();
    });
  }

  // ============ Panel Toggle (mobile/tablet) ============
  var _panelLeftOpen = true, _panelRightOpen = true;
  function togglePanel(side) {
    if (side === 'left') {
      _panelLeftOpen = !_panelLeftOpen;
      $('#conv-panel').classList.toggle('collapsed', !_panelLeftOpen);
      $('#asst-panel').classList.toggle('collapsed', !_panelLeftOpen);
      $('#toggle-left').textContent = _panelLeftOpen ? '☰' : '▶';
    } else {
      _panelRightOpen = !_panelRightOpen;
      $('#stats-panel').classList.toggle('collapsed', !_panelRightOpen);
      $('#toggle-right').textContent = _panelRightOpen ? '◫' : '◀';
    }
    // 面板折叠后重新居中
    setTimeout(fixScroll, 300);
  }
  $('#toggle-left').addEventListener('click', function() { togglePanel('left'); });
  $('#toggle-right').addEventListener('click', function() { togglePanel('right'); });

  // 小屏默认折叠面板
  if (window.innerWidth < 768) {
    togglePanel('left'); togglePanel('right');
  }

  // ============ Touch support for Canvas ============
  (function() {
    var touches0 = null, dist0 = 0, zoom0 = 1;
    var cv = null;
    function getCanvas() { return $('#preview-canvas'); }

    document.addEventListener('touchstart', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
      if (!getCanvas().contains(e.target) && e.target !== getCanvas()) return;
      if (e.touches.length === 2) {
        // 双指: 记录初始距离
        e.preventDefault();
        zoom0 = S.zoom;
        var t1 = e.touches[0], t2 = e.touches[1];
        dist0 = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        touches0 = { x1: t1.clientX, y1: t1.clientY, x2: t2.clientX, y2: t2.clientY };
      }
    }, { passive: false });

    document.addEventListener('touchmove', function(e) {
      if (!touches0) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        var t1 = e.touches[0], t2 = e.touches[1];
        var dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        if (dist0 > 0) {
          var scale = dist / dist0;
          var newZoom = clamp(0.15, 5, zoom0 * scale);
          S.zoom = newZoom;
          $('#zoom-label').textContent = Math.round(S.zoom * 100) + '%';
          rerender();
        }
      }
    }, { passive: false });

    document.addEventListener('touchend', function(e) {
      if (touches0) { touches0 = null; dist0 = 0; }
    });
  })();

  // ============ Focus Mode ============
  var _focusActive = false, _focusZoom = 1, _focusBaseScale = 1;

  function enterFocusMode() {
    if (!S.assistant) { toast('请先进入辅助模式', 'warn'); return; }
    _focusActive = true; _focusZoom = 1;

    // 渲染到 focus canvas (always at 1x, scale via CSS)
    var fc = $('#focus-canvas');
    renderer.renderAssist(fc, S.assistant.getPaddedMatrix(),
      S.assistant.getStatusMatrix(), S.boardConfig,
      S.assistant.getIsolated(), 1);

    // 自动 fit 缩放
    var sw = window.innerWidth - 16, sh = window.innerHeight - 84;
    _focusBaseScale = Math.min(sw / fc.width, sh / fc.height, 5);
    applyFocusScale();

    updateFocusInfo();
    $('#focus-overlay').classList.remove('hidden');

    var kh = function(e) {
      if (!_focusActive) return;
      if (e.key === 'Escape') exitFocusMode();
      if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); advanceBatch(); updateFocusInfo(); updateFocusCanvas(); }
      if (e.key === 'Backspace') { e.preventDefault(); revertBatch(); updateFocusInfo(); updateFocusCanvas(); }
    };
    document.addEventListener('keydown', kh);
    $('#focus-overlay')._kh = kh;
  }

  function applyFocusScale() {
    var fc = $('#focus-canvas');
    var s = _focusBaseScale * _focusZoom;
    fc.style.width = Math.floor(fc.width * s / (fc.style.width ? parseFloat(fc.style.width) / fc.width : _focusBaseScale) * s / s) + '';
    // Simpler: fc.width is the natural pixel width. Scale = _focusBaseScale * _focusZoom.
    fc.style.width = Math.floor(fc.width * _focusBaseScale * _focusZoom) + 'px';
    fc.style.height = Math.floor(fc.height * _focusBaseScale * _focusZoom) + 'px';
    $('#focus-zoom-label').textContent = Math.round(_focusZoom * 100) + '%';
  }

  function exitFocusMode() {
    _focusActive = false;
    $('#focus-overlay').classList.add('hidden');
    if ($('#focus-overlay')._kh) {
      document.removeEventListener('keydown', $('#focus-overlay')._kh);
      $('#focus-overlay')._kh = null;
    }
    updateAssistUI(); renderAssist();
  }

  function updateFocusInfo() {
    if (!S.assistant) return;
    var b = S.assistant.getCurrentBatch();
    if (b) {
      $('#focus-color').textContent = b.colorName + ' (' + b.colorId + ')';
      $('#focus-progress').textContent = '第 ' + (b.index + 1) + ' / ' + b.total + ' 批 · ' + b.positions.length + ' 颗';
    } else {
      $('#focus-color').textContent = '全部完成!';
      $('#focus-progress').textContent = '';
    }
  }

  function updateFocusCanvas() {
    var fc = $('#focus-canvas');
    renderer.renderAssist(fc, S.assistant.getPaddedMatrix(),
      S.assistant.getStatusMatrix(), S.boardConfig,
      S.assistant.getIsolated(), 1);
    applyFocusScale();
  }

  // Focus zoom events
  $('#focus-zoom-in').addEventListener('click', function() {
    _focusZoom = Math.min(5, _focusZoom + 0.25);
    applyFocusScale();
  });
  $('#focus-zoom-out').addEventListener('click', function() {
    _focusZoom = Math.max(0.25, _focusZoom - 0.25);
    applyFocusScale();
  });
  $('#focus-zoom-fit').addEventListener('click', function() {
    _focusZoom = 1;
    applyFocusScale();
  });

  // Focus touch pinch
  (function() {
    var fTouches = null, fDist0 = 0, fZoom0 = 1;
    document.addEventListener('touchstart', function(e) {
      if (!_focusActive) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        fZoom0 = _focusZoom;
        var t1 = e.touches[0], t2 = e.touches[1];
        fDist0 = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        fTouches = true;
      }
    }, { passive: false });
    document.addEventListener('touchmove', function(e) {
      if (!_focusActive || !fTouches) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        var t1 = e.touches[0], t2 = e.touches[1];
        var dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        if (fDist0 > 0) {
          _focusZoom = Math.max(0.25, Math.min(5, fZoom0 * dist / fDist0));
          applyFocusScale();
        }
      }
    }, { passive: false });
    document.addEventListener('touchend', function() { fTouches = null; });
  })();

  // 事件
  $('#focus-exit').addEventListener('click', exitFocusMode);
  $('#focus-advance').addEventListener('click', function() { advanceBatch(); updateFocusInfo(); updateFocusCanvas(); });
  $('#focus-revert').addEventListener('click', function() { revertBatch(); updateFocusInfo(); updateFocusCanvas(); });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && S.mode === 'assist' && !_focusActive) {
      // 确保不在输入框内
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (document.activeElement && document.activeElement.tagName === 'SELECT') return;
      e.preventDefault();
      enterFocusMode();
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
