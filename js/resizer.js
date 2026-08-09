/**
 * 高低像素转换模块
 *
 * 核心需求: 将已有的拼豆色号矩阵从一种分辨率转换到另一种
 * 典型场景:
 *   - 29×29 → 58×58 (放大，板子从1块变4块)
 *   - 87×87 → 29×29 (缩小，大图纸转小板)
 *   - 任意比例的自由转换
 *
 * 三种策略:
 *   1. nearest   — 最近邻 (上采样首选，保留像素感)
 *   2. dominant  — 主色采样 (下采样首选，统计窗口内出现最多的颜色)
 *   3. average   — 平均色重匹配 (对不同色彩混合多的区域更柔和)
 */

const RESIZE_METHODS = {
  NEAREST:  'nearest',
  DOMINANT: 'dominant',
  AVERAGE:  'average',
};

/**
 * 上采样 — 最近邻插值
 * 每个源像素扩展为 scaleX × scaleY 的矩形块
 *
 *   源 29×29, 目标 58×58 → scaleX=2, scaleY=2
 *   每个豆子变成 2×2 四颗相同的豆子
 *
 * @param {Array<Array>} matrix - 源色号矩阵
 * @param {number} scaleX - 水平缩放倍数
 * @param {number} scaleY - 垂直缩放倍数
 * @returns {Array<Array>} 新矩阵
 */
function upscaleNearest(matrix, scaleX, scaleY) {
  const srcH = matrix.length;
  const srcW = srcH > 0 ? matrix[0].length : 0;
  const dstW = Math.round(srcW * scaleX);
  const dstH = Math.round(srcH * scaleY);

  const result = [];
  for (let dy = 0; dy < dstH; dy++) {
    const row = [];
    const sy = Math.min(Math.floor(dy / scaleY), srcH - 1);
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.min(Math.floor(dx / scaleX), srcW - 1);
      const src = matrix[sy][sx];
      row.push(src ? { ...src } : null);
    }
    result.push(row);
  }
  return result;
}

/**
 * 下采样 — 主色 (Dominant Color)
 * 将窗口内像素映射到出现频率最高的颜色
 *
 *   源 58×58, 目标 29×29 → 每个目标像素 = 2×2 窗口内最多的颜色
 *
 * @param {Array<Array>} matrix
 * @param {number} scaleX - 缩小倍数 (>1 表示缩小, e.g. 2 表示缩到 1/2)
 * @param {number} scaleY
 * @returns {Array<Array>}
 */
function downscaleDominant(matrix, scaleX, scaleY) {
  const srcH = matrix.length;
  const srcW = srcH > 0 ? matrix[0].length : 0;
  const dstW = Math.round(srcW / scaleX);
  const dstH = Math.round(srcH / scaleY);

  const result = [];
  for (let dy = 0; dy < dstH; dy++) {
    const row = [];
    const sy0 = Math.round(dy * scaleY);
    const sy1 = Math.min(Math.round((dy + 1) * scaleY), srcH);

    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.round(dx * scaleX);
      const sx1 = Math.min(Math.round((dx + 1) * scaleX), srcW);

      // 统计窗口内各颜色出现次数
      const counts = {};
      let maxCount = 0;
      let dominant = null;
      let nullCount = 0;

      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const cell = matrix[sy][sx];
          if (!cell) {
            nullCount++;
            continue;
          }
          const key = cell.id;
          counts[key] = (counts[key] || 0) + 1;
          if (counts[key] > maxCount) {
            maxCount = counts[key];
            dominant = cell;
          }
        }
      }

      // 如果窗口内大多数为空，则结果为空
      const total = (sy1 - sy0) * (sx1 - sx0);
      if (nullCount > total / 2) {
        row.push(null);
      } else {
        row.push(dominant ? { ...dominant } : null);
      }
    }
    result.push(row);
  }
  return result;
}

/**
 * 下采样 — 平均颜色重匹配
 * 将窗口内所有像素的 RGB 取平均，然后用色板重新匹配
 *
 *   适合: 窗口内颜色混合多、想要更平滑过渡的场景
 *
 * @param {Array<Array>} matrix
 * @param {number} scaleX - 缩小倍数
 * @param {number} scaleY
 * @param {Function} matchColor - (r,g,b) => 色板颜色对象
 * @returns {Array<Array>}
 */
function downscaleAverage(matrix, scaleX, scaleY, matchColor) {
  const srcH = matrix.length;
  const srcW = srcH > 0 ? matrix[0].length : 0;
  const dstW = Math.round(srcW / scaleX);
  const dstH = Math.round(srcH / scaleY);

  const result = [];
  for (let dy = 0; dy < dstH; dy++) {
    const row = [];
    const sy0 = Math.round(dy * scaleY);
    const sy1 = Math.min(Math.round((dy + 1) * scaleY), srcH);

    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.round(dx * scaleX);
      const sx1 = Math.min(Math.round((dx + 1) * scaleX), srcW);

      let sumR = 0, sumG = 0, sumB = 0, count = 0;

      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const cell = matrix[sy][sx];
          if (cell && cell.rgb) {
            sumR += cell.rgb[0];
            sumG += cell.rgb[1];
            sumB += cell.rgb[2];
            count++;
          }
        }
      }

      if (count > 0) {
        const matched = matchColor(
          Math.round(sumR / count),
          Math.round(sumG / count),
          Math.round(sumB / count)
        );
        row.push({
          id: matched.id,
          name: matched.name,
          hex: matched.hex,
          rgb: matched.rgb,
          category: matched.category,
        });
      } else {
        row.push(null);
      }
    }
    result.push(row);
  }
  return result;
}

/**
 * 通用分辨率转换入口
 *
 * 根据源尺寸和目标尺寸自动选择策略:
 *   - 仅放大 → nearest
 *   - 仅缩小 → dominant (默认) 或 average
 *   - 混合 → 按维度分别处理
 *
 * @param {Array<Array>} matrix - 源色号矩阵
 * @param {number} targetW - 目标宽度
 * @param {number} targetH - 目标高度
 * @param {Function} matchColor - 颜色匹配函数 (用于 average 模式)
 * @param {string} [method='auto'] - 'nearest' | 'dominant' | 'average' | 'auto'
 * @returns {{ matrix: Array<Array>, method: string }}
 */
function resizeMatrix(matrix, targetW, targetH, matchColor, method = 'auto') {
  const srcH = matrix.length;
  const srcW = srcH > 0 ? matrix[0].length : 0;

  if (srcW === 0 || srcH === 0) {
    return { matrix: [], method: 'none' };
  }

  if (srcW === targetW && srcH === targetH) {
    // 同尺寸，深拷贝
    return {
      matrix: matrix.map(row => row.map(cell => cell ? { ...cell } : null)),
      method: 'none',
    };
  }

  const scaleX = targetW / srcW;
  const scaleY = targetH / srcH;

  // 自动选择策略
  let actualMethod = method;
  if (method === 'auto') {
    if (scaleX >= 1 && scaleY >= 1) {
      actualMethod = 'nearest';
    } else if (scaleX <= 1 && scaleY <= 1) {
      actualMethod = 'dominant';
    } else {
      // 混合情况: 宽放大、高缩小 (或反之)
      // 分两步: 第一步处理缩小维度，第二步处理放大维度
      actualMethod = 'mixed';
    }
  }

  let result;

  switch (actualMethod) {
    case 'nearest':
      result = upscaleNearest(matrix, scaleX, scaleY);
      break;

    case 'dominant':
      result = downscaleDominant(matrix, 1 / scaleX, 1 / scaleY);
      break;

    case 'average':
      result = downscaleAverage(matrix, 1 / scaleX, 1 / scaleY, matchColor);
      break;

    case 'mixed': {
      // 分两步: 先缩小再放大
      // Step 1 — 缩小需要缩的维度
      const shrinkX = Math.min(scaleX, 1);
      const shrinkY = Math.min(scaleY, 1);
      let temp = downscaleDominant(matrix, 1 / shrinkX, 1 / shrinkY);

      // Step 2 — 放大需要放的维度
      const growX = scaleX / shrinkX;
      const growY = scaleY / shrinkY;
      if (growX > 1 || growY > 1) {
        temp = upscaleNearest(temp, growX, growY);
      }

      result = temp;
      break;
    }
  }

  return { matrix: result, method: actualMethod };
}
