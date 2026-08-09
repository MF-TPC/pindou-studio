/**
 * 图片 → 拼豆色号矩阵 转换引擎 (V2.2)
 *
 * 流程:
 *   Image → 缩放 → 每格主导色提取 → Median Cut 量化 → CIELAB 1:1匹配 → 矩阵
 *
 * Median Cut 保证: 相似视觉颜色 → 同一簇 → 同一色号 (杜绝一对多)
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
   * @param {string} algo - 'median-cut' | 'direct' | 'lab-cluster'
   */
  function convert(image, targetW, targetH, algo) {
    algo = algo || 'median-cut';
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

    // Step 2: 颜色匹配 (算法可选)
    const matrix = Array.from({ length: targetH }, () => new Array(targetW).fill(null));
    const cmap = {};

    if (algo === 'direct') {
      // 直接 CIELAB — 每格独立匹配，保留最多颜色细节
      for (const cc of cellColors) {
        const bead = matchLab(cc.rgb, labPalette);
        matrix[cc.y][cc.x] = { id: bead.id, name: bead.id, hex: bead.hex, rgb: bead.rgb, category: bead.group || '?' };
        cmap[bead.id] = (cmap[bead.id] || 0) + 1;
      }
    } else if (algo === 'lab-cluster') {
      // 轻度聚类 — K 更大，保留更多颜色
      const K = Math.min(cellColors.length, 64);
      matchViaClusters(cellColors, K, matrix, cmap, labPalette);
    } else {
      // median-cut (默认) — 强力聚类，颜色简化
      const K = Math.min(cellColors.length, 24);
      matchViaClusters(cellColors, K, matrix, cmap, labPalette);
    }

    const stats = buildStats(matrix, cmap, palette);
    return { matrix, stats };
  }

  function getStats(matrix) {
    const cmap = {};
    for (const row of matrix)
      for (const c of row)
        if (c) cmap[c.id] = (cmap[c.id] || 0) + 1;
    return buildStats(matrix, cmap, palette);
  }

  return { convert, getStats, labPalette };
}

/** 聚类匹配辅助 */
function matchViaClusters(cellColors, K, matrix, cmap, labPalette) {
  const clusters = medianCut(cellColors.map(c => c.rgb), K);
  const beadMap = clusters.map(cl => matchLab(cl.center, labPalette));
  for (const cc of cellColors) {
    const clId = nearestCluster(cc.rgb, clusters);
    const bead = beadMap[clId];
    matrix[cc.y][cc.x] = {
      id: bead.id, name: bead.id, hex: bead.hex, rgb: bead.rgb, category: bead.group || '?',
    };
    cmap[bead.id] = (cmap[bead.id] || 0) + 1;
  }
}

// ============ Median Cut ============

/**
 * 递归 Median Cut，返回 K 个簇的中心色
 */
function medianCut(pixels, K) {
  if (!pixels.length) return [];
  K = Math.min(K, pixels.length);

  function recurse(box, depth) {
    if (box.length < 2 || depth >= K) {
      // 叶节点 → 返回中心色
      let sr = 0, sg = 0, sb = 0;
      for (const p of box) { sr += p[0]; sg += p[1]; sb += p[2]; }
      const n = box.length;
      return [{ center: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] }];
    }

    // 找跨度最大的通道
    let min = [255, 255, 255], max = [0, 0, 0];
    for (const p of box) {
      for (let c = 0; c < 3; c++) {
        if (p[c] < min[c]) min[c] = p[c];
        if (p[c] > max[c]) max[c] = p[c];
      }
    }
    const ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let ch = 0;
    if (ranges[1] >= ranges[0] && ranges[1] >= ranges[2]) ch = 1;
    else if (ranges[2] >= ranges[0] && ranges[2] >= ranges[1]) ch = 2;

    // 按该通道排序，中位数劈开
    box.sort((a, b) => a[ch] - b[ch]);
    const mid = Math.floor(box.length / 2);
    return [
      ...recurse(box.slice(0, mid), depth * 2 + 1),
      ...recurse(box.slice(mid), depth * 2 + 2),
    ];
  }

  return recurse(pixels.map(p => [...p]), 0);
}

/** 找最近簇中心 */
function nearestCluster(rgb, clusters) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < clusters.length; i++) {
    const dr = rgb[0] - clusters[i].center[0];
    const dg = rgb[1] - clusters[i].center[1];
    const db = rgb[2] - clusters[i].center[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
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
