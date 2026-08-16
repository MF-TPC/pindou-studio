/**
 * 图片 → 拼豆色号矩阵 转换引擎 (V4.0)
 *
 * 流程:
 *   Image → 缩放 → 每格主导色提取 → CIEDE2000 直接匹配 → 孤立点清理 → 防AI合并 → 可选限色 → 矩阵
 *
 * V4.0 重构:
 *   去掉"三算法"伪概念 (median-cut / lab-cluster / direct 本质是同一聚类配不同 K)
 *   改为单一流水线: direct 直接匹配(颜色全保留) + 后处理清理杂色
 *   —— 颜色少是灾难(分不开), 颜色多可靠清理
 */

function createConverter(palette) {
  const labPalette = precomputeLab(palette.colors);

  function getDominantColor(ctx, sx, sy, sw, sh) {
    const imageData = ctx.getImageData(sx, sy, sw, sh);
    const { data } = imageData;
    const hist = {};
    let maxC = 0, domK = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128 || (r < 5 && g < 5 && b < 5)) continue;
      const k = quantizeRGB(r, g, b);
      hist[k] = (hist[k] || 0) + 1;
      if (hist[k] > maxC) { maxC = hist[k]; domK = k; }
      total++;
    }
    if (total < (sw * sh) * 0.1) return null;
    return dequantizeRGB(domK);
  }

  /**
   * @param {Image} image
   * @param {number} targetW
   * @param {number} targetH
   * @param {object} opts - { maxColors, cleanNoise, antiAI }
   *   maxColors: 最大颜色数 (0 = 不限制)
   *   cleanNoise: 是否清理孤立杂点 (默认 true)
   *   antiAI: 是否防AI合并相近色分裂 (默认 true)
   */
  function convert(image, targetW, targetH, opts) {
    if (typeof opts === 'string') opts = {}; // 兼容旧版 algo 字符串，忽略
    opts = opts || {};
    const maxColors = opts.maxColors || 0;
    const doCleanNoise = opts.cleanNoise === true;  // 默认关闭，纯 direct
    const doAntiAI = opts.antiAI === true;          // 默认关闭，纯 direct

    const srcW = image.naturalWidth, srcH = image.naturalHeight;
    const src = document.createElement('canvas');
    src.width = srcW; src.height = srcH;
    const sctx = src.getContext('2d');
    sctx.drawImage(image, 0, 0, srcW, srcH);

    const bw = srcW / targetW, bh = srcH / targetH;

    // Step 1: 每格主导色提取
    const cellColors = [];
    for (let y = 0; y < targetH; y++) {
      for (let x = 0; x < targetW; x++) {
        const sx = Math.round(x * bw), sy = Math.round(y * bh);
        const sw = Math.max(1, Math.round(bw)), sh = Math.max(1, Math.round(bh));
        const dom = getDominantColor(sctx, sx, sy, sw, sh);
        if (dom) cellColors.push({ x, y, rgb: dom });
      }
    }

    // Step 2: direct 直接匹配 (每格独立 CIEDE2000，颜色全保留)
    const matrix = Array.from({ length: targetH }, () => new Array(targetW).fill(null));
    let cmap = {};

    for (const cc of cellColors) {
      const bead = matchLab(cc.rgb, labPalette);
      matrix[cc.y][cc.x] = { id: bead.id, name: bead.id, hex: bead.hex, rgb: bead.rgb, category: bead.group || '?' };
      cmap[bead.id] = (cmap[bead.id] || 0) + 1;
    }

    // Step 3: 孤立点/小块清理 (BFS 连通块，小块合并到周围)
    if (doCleanNoise) {
      const cleaned = cleanNoise(matrix, labPalette, 3);
      if (cleaned) cmap = recount(matrix);
    }

    // Step 4: 防AI合并 (相近色极端支配)
    if (doAntiAI) {
      mergeAIColors(matrix, cmap, labPalette);
    }

    // Step 5: 强制限色
    if (maxColors > 0) {
      enforceMaxColors(matrix, cmap, labPalette, maxColors);
    }

    const stats = buildStats(matrix, cmap, palette);
    return { matrix, stats };
  }

  function getStats(matrix) {
    const cmap = recount(matrix);
    return buildStats(matrix, cmap, palette);
  }

  return { convert, getStats, labPalette };
}

// ============ 孤立点/小块清理 ============

const _DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * BFS 找同色连通块，把小于 minBlockSize 的块合并到周围最多颜色
 * 用于清理 direct 匹配产生的孤立杂点
 * @returns {boolean} 是否发生了合并
 */
function cleanNoise(matrix, labPalette, minBlockSize) {
  minBlockSize = minBlockSize || 3;
  const h = matrix.length, w = h > 0 ? matrix[0].length : 0;
  if (!w) return false;

  const visited = Array.from({ length: h }, () => new Array(w).fill(false));
  const blocks = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (visited[y][x]) continue;
      const cell = matrix[y][x];
      if (!cell) { visited[y][x] = true; continue; }

      const colorId = cell.id;
      const queue = [[x, y]];
      visited[y][x] = true;
      const cells = [];

      while (queue.length) {
        const p = queue.pop();
        cells.push(p);
        for (let d = 0; d < 4; d++) {
          const nx = p[0] + _DIR4[d][0], ny = p[1] + _DIR4[d][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (visited[ny][nx]) continue;
          const nc = matrix[ny][nx];
          if (!nc || nc.id !== colorId) continue;
          visited[ny][nx] = true;
          queue.push([nx, ny]);
        }
      }
      blocks.push({ colorId, cells });
    }
  }

  let changed = false;

  for (const block of blocks) {
    if (block.cells.length >= minBlockSize) continue;

    // 统计周围颜色
    const neighborColors = {};
    for (const p of block.cells) {
      for (let d = 0; d < 4; d++) {
        const nx = p[0] + _DIR4[d][0], ny = p[1] + _DIR4[d][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nc = matrix[ny][nx];
        if (!nc || nc.id === block.colorId) continue;
        neighborColors[nc.id] = (neighborColors[nc.id] || 0) + 1;
      }
    }

    let bestId = null, bestCount = 0;
    for (const id in neighborColors) {
      if (neighborColors[id] > bestCount) { bestCount = neighborColors[id]; bestId = id; }
    }
    if (!bestId) continue;

    const def = labPalette.find(c => c.id === bestId);
    if (!def) continue;

    for (const p of block.cells) {
      matrix[p[1]][p[0]] = { id: def.id, name: def.id, hex: def.hex, rgb: def.rgb, category: def.group || '?' };
    }
    changed = true;
  }

  return changed;
}

function recount(matrix) {
  const cmap = {};
  for (const row of matrix) {
    for (const c of row) {
      if (c) cmap[c.id] = (cmap[c.id] || 0) + 1;
    }
  }
  return cmap;
}

// ============ 防AI合并 ============

function mergeAIColors(matrix, cmap, labPalette) {
  const SIMILARITY_THRESHOLD = 2.5; // CIE76 ΔE*ab，肉眼几乎难分的相近色
  const DOMINANCE_RATIO = 0.05;

  const entries = Object.entries(cmap)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);

  const merges = {};

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const idA = entries[i].id, idB = entries[j].id;
      if (merges[idA] || merges[idB]) continue;

      const countA = cmap[idA], countB = cmap[idB];
      if (countA === 0 || countB === 0) continue;

      const ratio = Math.min(countA, countB) / Math.max(countA, countB);
      if (ratio >= DOMINANCE_RATIO) continue;

      const ca = labPalette.find(c => c.id === idA);
      const cb = labPalette.find(c => c.id === idB);
      if (!ca || !cb) continue;

      const de = deltaE76(ca.lab, cb.lab);
      if (de < SIMILARITY_THRESHOLD) {
        if (countA >= countB) merges[idB] = idA;
        else merges[idA] = idB;
      }
    }
  }

  if (Object.keys(merges).length === 0) return;

  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      const cell = matrix[y][x];
      if (cell && merges[cell.id]) {
        const newId = merges[cell.id];
        const def = labPalette.find(c => c.id === newId);
        matrix[y][x] = {
          id: newId, name: newId,
          hex: def ? def.hex : cell.hex,
          rgb: def ? def.rgb : cell.rgb,
          category: def ? def.group : cell.category,
        };
      }
    }
  }

  for (const oldId of Object.keys(merges)) {
    const newId = merges[oldId];
    cmap[newId] = (cmap[newId] || 0) + (cmap[oldId] || 0);
    delete cmap[oldId];
  }
}

// ============ 强制限制最大颜色数 ============

function enforceMaxColors(matrix, cmap, labPalette, maxColors) {
  const CLOSE = 15; // CIE76 ΔE*ab，"相近才并"的阈值（第一轮）
  const entries = Object.entries(cmap).map(([id, count]) => ({ id, count }));
  if (entries.length <= maxColors) return;

  entries.sort((a, b) => a.count - b.count);

  const merges = {};  // oldId -> newId
  const kept = {};    // 第一轮：独一无二、保留的颜色

  function nearestOf(id) {
    const sc = labPalette.find(c => c.id === id);
    if (!sc) return null;
    let best = null, bestDist = Infinity;
    for (const e of entries) {
      if (e.id === id || merges[e.id]) continue;
      const ec = labPalette.find(c => c.id === e.id);
      if (!ec) continue;
      const de = deltaE76(sc.lab, ec.lab);
      if (de < bestDist) { bestDist = de; best = e; }
    }
    return { best, bestDist };
  }

  // 第一轮：从数量最少的开始，只并"相近"的颜色，独一无二的保留
  while (entries.filter(e => !merges[e.id] && !kept[e.id]).length > maxColors) {
    let smallest = null;
    for (const e of entries) if (!merges[e.id] && !kept[e.id]) { smallest = e; break; }
    if (!smallest) break;
    const r = nearestOf(smallest.id);
    if (r.best && r.bestDist <= CLOSE) merges[smallest.id] = r.best.id;
    else kept[smallest.id] = true;
  }

  // 第二轮：若仍超过 maxColors，强制并到最近，保证能达到目标颜色数
  while (entries.filter(e => !merges[e.id]).length > maxColors) {
    let smallest = null;
    for (const e of entries) if (!merges[e.id]) { smallest = e; break; }
    if (!smallest) break;
    const r = nearestOf(smallest.id);
    if (r.best) merges[smallest.id] = r.best.id;
    else break;
  }

  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      const cell = matrix[y][x];
      if (cell && merges[cell.id]) {
        const newId = merges[cell.id];
        const def = labPalette.find(c => c.id === newId);
        matrix[y][x] = {
          id: newId, name: newId,
          hex: def ? def.hex : cell.hex,
          rgb: def ? def.rgb : cell.rgb,
          category: def ? def.group : cell.category,
        };
      }
    }
  }

  for (const oldId of Object.keys(merges)) {
    const newId = merges[oldId];
    if (newId !== oldId) {
      cmap[newId] = (cmap[newId] || 0) + (cmap[oldId] || 0);
      delete cmap[oldId];
    }
  }
}

// ============ Stats ============

function buildStats(matrix, cmap, palette) {
  const total = Object.values(cmap).reduce((a, b) => a + b, 0);
  const h = matrix.length, w = h > 0 ? matrix[0].length : 0;
  const bs = palette.boardSize;
  const bw = Math.ceil(w / bs), bh = Math.ceil(h / bs);
  const clist = Object.entries(cmap)
    .map(([id, cnt]) => {
      const def = palette.colors.find(c => c.id === id);
      return {
        id, name: id, hex: def ? def.hex : '#000',
        rgb: def ? def.rgb : [0, 0, 0],
        category: def ? def.group : '?', count: cnt,
      };
    })
    .sort((a, b) => b.count - a.count);
  return {
    width: w, height: h, totalBeads: total,
    colorCount: clist.length, colors: clist,
    boardsW: bw, boardsH: bh, totalBoards: bw * bh, boardSize: bs,
  };
}

function smartInitSize(imgW, imgH, refTotal) {
  refTotal = refTotal || 3364;
  const r = imgW / imgH;
  const h = Math.max(1, Math.round(Math.sqrt(refTotal / r)));
  const w = Math.max(1, Math.round(h * r));
  return { width: w, height: h };
}
