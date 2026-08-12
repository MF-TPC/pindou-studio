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
    image: null, patternImage: null, matrix: null, stats: null, converter: null,
    paletteId: 'mard-221', targetW: 58, targetH: 58,
    matchAlgo: 'median-cut',
    renderStyle: 'symbol', showGrid: true, cellSize: 20,
    zoom: 1, lockAspect: false, aspectRatio: 1,

    // Assist
    boardConfig: createBoardConfig(),
    assistant: null, colorMatrix: null,
    shiftX: 0, shiftY: 0,

    // Edit
    editHistory: [],
  };

  // ============ Init ============
  function init() {
    syncConverter();
    bindEvents();
    $('#guide-offset-label').textContent = '4格';
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
            var useOCR = $('#ocr-toggle').checked;
            showLoading(useOCR ? '正在识别(OCR增强)...' : '正在识别图纸...');
            importPatternImage(img, lp, S.converter, useOCR).then(function(result) {
            hideLoading();
            if (!result || !result.matrix) { toast('识别失败', 'error'); return; }
            S.matrix = result.matrix;
            S.targetW = result.matrix[0] ? result.matrix[0].length : 29;
            S.targetH = result.matrix.length;
            $('#width-input').value = S.targetW;
            $('#height-input').value = S.targetH;
            S.stats = S.converter.getStats(S.matrix);
            S.image = null;
            S.patternImage = img; // 存原图，允许后续改尺寸重解析
            updateRendererOpts(); renderConvert(); updateStatsPanel();
            $('#drop-zone').classList.add('has-image');
            var d = result.details || {};
            var msg = '图纸导入: ' + (d.rows||'?') + '×' + (d.cols||'?') + ' | OCR:' + (d.ocrHits||0) + ' [' + result.confidence + ']';
            if (result.validation && result.validation.length > 0) {
              msg += ' ⚠️ 校验差异:';
              for (var vi = 0; vi < Math.min(result.validation.length, 3); vi++) {
                var vm = result.validation[vi];
                msg += ' ' + vm.id + '(' + vm.recognized + '/' + vm.expected + ')';
              }
              toast(msg, 'warn');
            } else {
              toast(msg, 'success');
            }
            }).catch(function(err) {
              hideLoading();
              console.error(err);
              toast('识别出错: ' + (err.message || '未知'), 'error');
            });
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
      if (S.patternImage) resampleFromStored(); else if (S.image) doConvert();
    });

    // Palette
    $('#palette-select').addEventListener('change', () => {
      S.paletteId = $('#palette-select').value;
      syncConverter(); if (S.patternImage) resampleFromStored(); else if (S.image) doConvert();
    });

    // Size
    $('#width-input').addEventListener('input', () => {
      S.targetW = clamp(1, 500, parseInt($('#width-input').value) || 29);
      if (S.lockAspect && S.aspectRatio) {
        S.targetH = clamp(1, 500, Math.round(S.targetW / S.aspectRatio));
        $('#height-input').value = S.targetH;
      }
      if (S.patternImage) resampleFromStored(); else if (S.image) doConvert();
    });
    $('#height-input').addEventListener('input', () => {
      S.targetH = clamp(1, 500, parseInt($('#height-input').value) || 29);
      if (S.lockAspect && S.aspectRatio) {
        S.targetW = clamp(1, 500, Math.round(S.targetH * S.aspectRatio));
        $('#width-input').value = S.targetW;
      }
      if (S.patternImage) resampleFromStored(); else if (S.image) doConvert();
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
    $('#edit-undo').addEventListener('click', undoEdit);

    // Mirror
    $('#flip-h').addEventListener('click', function() { flipMatrix('h'); });
    $('#flip-v').addEventListener('click', function() { flipMatrix('v'); });

    // Vault
    // Vault
    $('#save-to-vault').addEventListener('click', function() {
      if (!S.matrix) { toast('请先导入图纸', 'warn'); return; }
      var dlg = $('#vault-save-dlg');
      dlg.style.display = dlg.style.display === 'none' ? 'block' : 'none';
      $('#vault-name-input').value = '图纸 ' + new Date().toLocaleDateString();
      $('#vault-name-input').focus();
    });
    $('#vault-save-confirm').addEventListener('click', function() {
      var name = $('#vault-name-input').value.trim();
      if (!name) { toast('请输入名称', 'warn'); return; }
      saveToVault(name);
      $('#vault-save-dlg').style.display = 'none';
    });
    $('#qc-apply').addEventListener('click', applyQC);
    loadVaultList();

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

    // Pattern shift arrows
    function shiftPattern(dx, dy) {
      if (!S.assistant) return;
      S.shiftX += dx; S.shiftY += dy;
      var area = $('#canvas-area');
      var sx = area.scrollLeft, sy = area.scrollTop;
      S.assistant = createAssistant(S.colorMatrix, S.boardConfig, S.shiftX, S.shiftY);
      renderAssist(); updateAssistUI();
      area.scrollLeft = sx; area.scrollTop = sy;
    }
    $('#shift-up').addEventListener('click', function() { shiftPattern(0, -1); });
    $('#shift-down').addEventListener('click', function() { shiftPattern(0, 1); });
    $('#shift-left').addEventListener('click', function() { shiftPattern(-1, 0); });
    $('#shift-right').addEventListener('click', function() { shiftPattern(1, 0); });

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
    var p = getPalette(S.paletteId);
    var lp = precomputeLab(p.colors);
    var useOCR = $('#ocr-toggle').checked;
    showLoading(useOCR ? '正在识别(OCR增强)...' : '正在识别图纸...');
    importPatternImage(img, lp, S.converter, useOCR).then(function(result) {
      hideLoading();
      if (!result || !result.matrix) { toast('识别失败，请重试', 'error'); return; }
      var d = result.details || {};
      var msg = '导入: ' + (d.rows||'?') + '×' + (d.cols||'?') + ' | 颜色:' + (d.colorHits||0) + ' | 图例:' + (d.legendSize||0);
      if (d.tesseractLegendHits) msg += ' | Tess:' + d.tesseractLegendHits;
      msg += ' [' + (result.confidence || 'ok') + ']';
      if (result.validation && result.validation.length > 0) {
        msg += ' ⚠️';
        for (var vi = 0; vi < Math.min(result.validation.length, 2); vi++)
          msg += ' ' + result.validation[vi].id + '(' + result.validation[vi].recognized + '/' + result.validation[vi].expected + ')';
        toast(msg, 'warn');
      } else { toast(msg, 'success'); }
      enterAssistMode(result.matrix);
    }).catch(function(err) {
      hideLoading();
      console.error(err);
      toast('识别出错: ' + (err.message || '未知错误'), 'error');
    });
  }

  // ============ Convert ============
  function doConvert() {
    if (!S.image || !S.converter) return;
    S.patternImage = null; // 原图转换清除图纸标记
    const r = S.converter.convert(S.image, S.targetW, S.targetH, S.matchAlgo);
    S.matrix = r.matrix; S.stats = r.stats;
    updateRendererOpts(); renderConvert(); updateStatsPanel();
  }

  function resampleFromStored() {
    if (!S.patternImage || !S.converter) return;
    var p = getPalette(S.paletteId);
    var lp = precomputeLab(p.colors);
    var result = resamplePatternImage(S.patternImage, S.targetW, S.targetH, lp, S.converter);
    S.matrix = result.matrix;
    S.stats = S.converter.getStats(S.matrix);
    updateRendererOpts(); renderConvert(); updateStatsPanel();
    var d = result.details || {};
    toast('重采样: ' + (d.rows||'?') + '×' + (d.cols||'?') + ' | OCR:' + (d.ocrHits||0) + ' [' + result.confidence + ']', 'info');
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
      boardLineColor: '#d03030',
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
      if (_cropMode) { renderConvert(); updateCropBox(); } else renderConvert();
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
    showQCPanel();
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
      S.assistant = createAssistant(S.colorMatrix, S.boardConfig, S.shiftX, S.shiftY);
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
    S.boardConfig.width = Math.ceil(Math.max(mw, 78) / 78) * 78;
    S.boardConfig.height = Math.ceil(Math.max(mh, 78) / 78) * 78;
    $('#board-width').value = S.boardConfig.width;
    $('#board-height').value = S.boardConfig.height;
    updateBoardPreview();

    S.assistant = createAssistant(matrix, S.boardConfig, S.shiftX, S.shiftY);
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
      for (var bi = 0; bi < overview.length; bi++) {
        var b = overview[bi];
        var li = document.createElement('li');
        li.className = 'batch-ov-item batch-ov-' + b.status;
        if (b.status === 'pending') {
          li.draggable = true;
          li.setAttribute('data-batch-idx', b.index);
          li.style.cursor = 'grab';
        }
        var btns = '';
        if (b.status === 'pending') {
          btns = '<span class="bo-arrows">' +
            (bi > 0 ? '<button class="bo-arr" data-from="' + b.index + '" data-to="' + (bi - 1) + '">⬆</button>' : '') +
            (bi < overview.length - 1 ? '<button class="bo-arr" data-from="' + b.index + '" data-to="' + (bi + 1) + '">⬇</button>' : '') +
            '</span>';
        }
        li.innerHTML = '<span class="bo-swatch" style="background:' + b.hex + '"></span>' +
          '<span>' + b.colorName + '</span><span class="bo-count">' + b.count + '颗</span>' + btns;
        bl.appendChild(li);
      }
      // 排序按钮
      var arrs = bl.querySelectorAll('.bo-arr');
      for (var ai = 0; ai < arrs.length; ai++) {
        arrs[ai].addEventListener('click', function(e) {
          e.stopPropagation();
          var from = parseInt(this.getAttribute('data-from'));
          var to = parseInt(this.getAttribute('data-to'));
          S.assistant.moveBatch(from, to);
          assistBatchMoved();
        });
      }
      // 拖拽排序 (dataTransfer 方式)
      var items = bl.querySelectorAll('[draggable]');
      for (var di = 0; di < items.length; di++) {
        items[di].addEventListener('dragstart', function(e) {
          e.dataTransfer.setData('text/plain', this.getAttribute('data-batch-idx'));
          e.dataTransfer.effectAllowed = 'move';
          this.style.opacity = '0.4';
        });
        items[di].addEventListener('dragend', function(e) {
          this.style.opacity = '1';
        });
        items[di].addEventListener('dragover', function(e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        });
        items[di].addEventListener('drop', function(e) {
          e.preventDefault();
          var from = parseInt(e.dataTransfer.getData('text/plain'));
          var to = parseInt(this.getAttribute('data-batch-idx'));
          if (!isNaN(from) && !isNaN(to) && from !== to) {
            S.assistant.moveBatch(from, to);
            assistBatchMoved();
          }
        });
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

  function assistBatchMoved() {
    renderAssist(); updateAssistUI();
    toast('批次顺序已调整', 'info');
  }

  function advanceBatch() {
    if (!S.assistant) return;
    // 第一批自动启动
    if (S.assistant.getCurrentBatch() === null) {
      S.assistant.startFirstBatch();
      renderAssist(); updateAssistUI();
      var b = S.assistant.getCurrentBatch();
      if (b) toast('开始: ' + b.colorName, 'info');
      return;
    }
    var r = S.assistant.advanceBatch();
    renderAssist(); updateAssistUI();
    if (r.finished) toast('🎉 全部完成!', 'success');
    else if (r.batch) toast(`下一批: ${r.batch.colorName}`, 'info');
  }

  function revertBatch() {
    if (!S.assistant) return;
    var r = S.assistant.revertBatch();
    if (r.atStart && !r.batch) { toast('已是第一步', 'warn'); return; }
    renderAssist(); updateAssistUI();
    if (r.batch) toast('已撤销到: ' + r.batch.colorName, 'info');
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

  var _loading = false;
  function showLoading(msg) {
    _loading = true;
    $('#loading-text').textContent = msg || '加载中...';
    $('#loading-bar').style.display = 'block';
  }
  function hideLoading() {
    _loading = false;
    $('#loading-bar').style.display = 'none';
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

  // ============ Mirror ============
  function flipMatrix(dir) {
    if (!S.matrix) { toast('请先导入图纸', 'warn'); return; }
    saveUndo();
    var h = S.matrix.length, w = h > 0 ? S.matrix[0].length : 0;
    var flipped = [];
    if (dir === 'h') {
      for (var y = 0; y < h; y++) {
        var row = [];
        for (var x = w - 1; x >= 0; x--) row.push(S.matrix[y][x]);
        flipped.push(row);
      }
    } else {
      for (var y = h - 1; y >= 0; y--) {
        flipped.push(S.matrix[y].slice());
      }
    }
    S.matrix = flipped;
    S.stats = S.converter.getStats(S.matrix);
    updateRendererOpts(); renderConvert(); updateStatsPanel();
    toast(dir === 'h' ? '水平翻转完成' : '垂直翻转完成', 'success');
  }

  // ============ Vault (localStorage 图纸仓库) ============
  var VAULT_KEY = 'pindou_vault';

  function getVault() {
    try { return JSON.parse(localStorage.getItem(VAULT_KEY)) || []; }
    catch(e) { return []; }
  }

  function saveVault(v) {
    localStorage.setItem(VAULT_KEY, JSON.stringify(v));
  }

  function saveToVault(name) {
    if (!S.matrix) { toast('请先导入图纸', 'warn'); return; }
    if (!name) return;
    var vault = getVault();
    // 精简存储: 只存色号ID矩阵
    var compact = S.matrix.map(function(row) {
      return row.map(function(c) { return c ? c.id : null; });
    });
    vault.push({
      name: name,
      date: new Date().toISOString(),
      w: S.matrix[0].length,
      h: S.matrix.length,
      palette: S.paletteId,
      data: compact,
    });
    if (vault.length > 50) vault = vault.slice(-50);
    saveVault(vault);
    loadVaultList();
    toast('已保存: ' + name, 'success');
  }

  // ============ QC 数量校验 ============
  function showQCPanel() {
    if (!S.stats || !S.stats.colors) return;
    var qc = $('#qc-section');
    qc.style.display = 'block';
    var list = $('#qc-list');
    list.innerHTML = '';
    for (var qi = 0; qi < S.stats.colors.length; qi++) {
      var c = S.stats.colors[qi];
      var li = document.createElement('li');
      li.className = 'qc-item';
      li.innerHTML = '<span class="qc-swatch" style="background:' + c.hex + '"></span>' +
        '<span class="qc-id">' + c.id + '</span>' +
        '<span class="qc-rec">识别: <b>' + c.count + '</b></span>' +
        '<input type="number" class="qc-input" value="' + c.count + '" data-id="' + c.id + '" min="0" style="width:60px">';
      list.appendChild(li);
    }
  }

  function applyQC() {
    if (!S.stats) return;
    var inputs = document.querySelectorAll('.qc-input');
    var mismatches = [];
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var id = inp.getAttribute('data-id');
      var actual = parseInt(inp.value) || 0;
      var recognized = S.stats.colors.find(function(c) { return c.id === id; });
      if (recognized && actual !== recognized.count) {
        mismatches.push({ id: id, name: recognized.name, recognized: recognized.count, actual: actual, diff: actual - recognized.count });
      }
    }
    if (mismatches.length === 0) {
      toast('✅ 所有颜色数量一致，图纸无误', 'success');
    } else {
      var msg = '⚠️ ' + mismatches.length + ' 项不一致:';
      for (var mi = 0; mi < Math.min(mismatches.length, 5); mi++) {
        var m = mismatches[mi];
        msg += ' ' + m.id + '(识' + m.recognized + '/实' + m.actual + ')';
      }
      if (mismatches.length > 5) msg += ' ...';
      toast(msg, 'warn');
      // 高亮差异项
      for (var j = 0; j < inputs.length; j++) {
        var inp2 = inputs[j];
        var id2 = inp2.getAttribute('data-id');
        var mm = mismatches.find(function(x) { return x.id === id2; });
        inp2.style.background = mm ? '#fff0f0' : '#f0fff0';
      }
    }
  }

  function loadVaultList() {
    var vault = getVault();
    var list = $('#vault-list');
    var section = $('#vault-section');
    if (vault.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    list.innerHTML = '';
    for (var i = vault.length - 1; i >= 0; i--) {
      (function(idx) {
        var item = vault[idx];
        var li = document.createElement('li');
        li.className = 'vault-item';
        li.innerHTML = '<span class="vault-name">' + item.name + '</span>' +
          '<span class="vault-meta">' + item.w + '×' + item.h + '</span>' +
          '<button class="vault-load">载入</button>' +
          '<button class="vault-del">×</button>';
        li.querySelector('.vault-load').addEventListener('click', function() { loadFromVault(idx); });
        li.querySelector('.vault-del').addEventListener('click', function(e) {
          e.stopPropagation();
          var v = getVault();
          v.splice(idx, 1);
          saveVault(v);
          loadVaultList();
          toast('已删除', 'info');
        });
        list.appendChild(li);
      })(i);
    }
  }

  function loadFromVault(idx) {
    var vault = getVault();
    var item = vault[idx];
    if (!item) return;
    var p = getPalette(item.palette || S.paletteId);
    // 还原矩阵
    var matrix = [];
    for (var y = 0; y < item.h; y++) {
      var row = [];
      for (var x = 0; x < item.w; x++) {
        var id = item.data[y][x];
        if (id) {
          var def = p.colors.find(function(c) { return c.id === id; });
          row.push(def ? { id: def.id, name: def.id, hex: def.hex, rgb: def.rgb, category: def.group || '?' } : { id: id, name: id, hex: '#ccc', rgb: [204,204,204], category: '?' });
        } else {
          row.push(null);
        }
      }
      matrix.push(row);
    }
    S.matrix = matrix;
    S.targetW = item.w; S.targetH = item.h;
    $('#width-input').value = S.targetW;
    $('#height-input').value = S.targetH;
    S.stats = S.converter.getStats(S.matrix);
    S.image = null; S.patternImage = null;
    updateRendererOpts(); renderConvert(); updateStatsPanel();
    $('#drop-zone').classList.add('has-image');
    toast('已载入: ' + item.name, 'success');
  }
  var _cropMode = false, _cropRect = null, _cropDragEdge = null;
  var _cropStart = null, _cropOrigRect = null;

  function gridToPixel(gx, gy) {
    var cs = S.cellSize * S.zoom, pad = 3 * cs;
    return { x: pad + gx * cs, y: pad + gy * cs };
  }

  function updateCropBox() {
    var r = _cropRect; if (!r) return;
    var tl = gridToPixel(r.left, r.top);
    var br = gridToPixel(r.right + 1, r.bottom + 1);
    var box = $('#crop-box');
    box.style.left = tl.x + 'px'; box.style.top = tl.y + 'px';
    box.style.width = (br.x - tl.x) + 'px'; box.style.height = (br.y - tl.y) + 'px';

    var w = $('#preview-canvas').width, h = $('#preview-canvas').height;
    function setStyle(id, l, t, w2, h2) {
      var el = document.getElementById(id);
      el.style.left = l + 'px'; el.style.top = t + 'px';
      el.style.width = w2 + 'px'; el.style.height = h2 + 'px';
    }
    setStyle('crop-mask-t', 0, 0, w, tl.y);
    setStyle('crop-mask-b', 0, br.y, w, Math.max(0, h - br.y));
    setStyle('crop-mask-l', 0, tl.y, tl.x, br.y - tl.y);
    setStyle('crop-mask-r', br.x, tl.y, Math.max(0, w - br.x), br.y - tl.y);

    updateCropInputs();
  }

  function enterCropMode() {
    if (!S.matrix) { toast('请先导入图纸', 'warn'); return; }
    _cropMode = true;
    var w = S.matrix[0].length, h = S.matrix.length;
    _cropRect = { left: 0, top: 0, right: w - 1, bottom: h - 1 };
    $('#crop-section').style.display = 'block';
    $('#crop-overlay').style.display = 'block';
    $('#crop-btn').textContent = '✂️ 裁剪中...';
    updateCropBox();
    bindCropEvents();
  }

  function exitCropMode(skipRender) {
    _cropMode = false; _cropRect = null; _cropDragEdge = null;
    $('#crop-section').style.display = 'none';
    $('#crop-overlay').style.display = 'none';
    $('#crop-btn').textContent = '✂️ 裁剪图纸';
    unbindCropEvents();
    if (!skipRender) renderConvert();
  }

  function updateCropInputs() {
    if (!_cropRect) return;
    $('#crop-left').value = _cropRect.left;
    $('#crop-right').value = _cropRect.right;
    $('#crop-top').value = _cropRect.top;
    $('#crop-bottom').value = _cropRect.bottom;
  }

  function bindCropEvents() {
    $('#crop-overlay').addEventListener('mousedown', onCropStart);
    $('#crop-overlay').addEventListener('touchstart', onCropStart, { passive: false });
    window.addEventListener('mousemove', onCropMove);
    window.addEventListener('touchmove', onCropMove, { passive: false });
    window.addEventListener('mouseup', onCropEnd);
    window.addEventListener('touchend', onCropEnd);
  }

  function unbindCropEvents() {
    $('#crop-overlay').removeEventListener('mousedown', onCropStart);
    $('#crop-overlay').removeEventListener('touchstart', onCropStart);
    window.removeEventListener('mousemove', onCropMove);
    window.removeEventListener('touchmove', onCropMove);
    window.removeEventListener('mouseup', onCropEnd);
    window.removeEventListener('touchend', onCropEnd);
  }

  function getClientPos(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function onCropStart(e) {
    if (!_cropMode) return;
    var target = e.target;
    var edge = null;
    if (target.hasAttribute && target.hasAttribute('data-edge')) edge = target.getAttribute('data-edge');
    else if (target.id === 'crop-box' || target.closest('#crop-box')) edge = 'move';
    if (!edge) return;
    e.preventDefault();
    var pos = getClientPos(e);
    _cropDragEdge = edge;
    _cropStart = snapToGrid(pos.x, pos.y);
    _cropOrigRect = Object.assign({}, _cropRect);
  }

  function snapToGrid(cx, cy) {
    var rc = $('#preview-canvas').getBoundingClientRect();
    var cs = S.cellSize * S.zoom, pad = 3 * cs;
    var sx = (cx - rc.left) * ($('#preview-canvas').width / rc.width);
    var sy = (cy - rc.top) * ($('#preview-canvas').height / rc.height);
    return {
      x: Math.round((sx - pad) / cs),
      y: Math.round((sy - pad) / cs),
    };
  }

  function onCropMove(e) {
    if (!_cropDragEdge) return;
    e.preventDefault();
    var pos = getClientPos(e);
    var g = snapToGrid(pos.x, pos.y);
    var r = _cropRect, o = _cropOrigRect;
    var mw = S.matrix[0].length - 1, mh = S.matrix.length - 1;
    var dx = g.x - _cropStart.x, dy = g.y - _cropStart.y;

    switch (_cropDragEdge) {
      case 'move':
        var ow = o.right - o.left, oh = o.bottom - o.top;
        r.left = clamp(0, mw - ow, o.left + dx);
        r.top = clamp(0, mh - oh, o.top + dy);
        r.right = r.left + ow;
        r.bottom = r.top + oh;
        break;
      case 'tl': r.left = clamp(0, r.right - 1, o.left + dx); r.top = clamp(0, r.bottom - 1, o.top + dy); break;
      case 'tr': r.right = clamp(r.left + 1, mw, o.right + dx); r.top = clamp(0, r.bottom - 1, o.top + dy); break;
      case 'bl': r.left = clamp(0, r.right - 1, o.left + dx); r.bottom = clamp(r.top + 1, mh, o.bottom + dy); break;
      case 'br': r.right = clamp(r.left + 1, mw, o.right + dx); r.bottom = clamp(r.top + 1, mh, o.bottom + dy); break;
      case 't': r.top = clamp(0, r.bottom - 1, o.top + dy); break;
      case 'b': r.bottom = clamp(r.top + 1, mh, o.bottom + dy); break;
      case 'l': r.left = clamp(0, r.right - 1, o.left + dx); break;
      case 'r': r.right = clamp(r.left + 1, mw, o.right + dx); break;
    }
    updateCropBox();
  }

  function onCropEnd(e) {
    _cropDragEdge = null;
    _cropStart = null;
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

  $('#crop-btn').addEventListener('click', function() {
    if (_cropMode) exitCropMode(); else enterCropMode();
  });
  $('#crop-apply').addEventListener('click', applyCrop);
  $('#crop-cancel').addEventListener('click', exitCropMode);

  // 手动输入裁剪参数
  var cropInputs2 = ['crop-left', 'crop-right', 'crop-top', 'crop-bottom'];
  for (var cii2 = 0; cii2 < cropInputs2.length; cii2++) {
    document.getElementById(cropInputs2[cii2]).addEventListener('input', function() {
      if (!_cropRect) return;
      _cropRect.left = parseInt($('#crop-left').value) || 0;
      _cropRect.right = parseInt($('#crop-right').value) || _cropRect.left + 1;
      _cropRect.top = parseInt($('#crop-top').value) || 0;
      _cropRect.bottom = parseInt($('#crop-bottom').value) || _cropRect.top + 1;
      updateCropBox();
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
