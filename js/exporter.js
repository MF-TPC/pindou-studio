/**
 * 导出模块
 * 支持: PNG 下载、打印、复制到剪贴板
 */

/**
 * 导出为 PNG 文件并触发下载
 * @param {HTMLCanvasElement} canvas - 要导出的 canvas
 * @param {string} [filename='pindou-pattern'] - 文件名 (不含扩展名)
 * @param {number} [scale=1] - 导出缩放倍率 (用于生成高清图纸)
 */
function exportPNG(canvas, filename = 'pindou-pattern', scale = 1) {
  return new Promise((resolve, reject) => {
    try {
      let sourceCanvas = canvas;

      if (scale !== 1) {
        // 高清导出: 创建放大版 canvas
        sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = canvas.width * scale;
        sourceCanvas.height = canvas.height * scale;
        const ctx = sourceCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, 0, 0, sourceCanvas.width, sourceCanvas.height);
      }

      sourceCanvas.toBlob(blob => {
        if (!blob) {
          reject(new Error('toBlob 失败'));
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        resolve();
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * 触发浏览器打印
 * 配合 CSS @media print 样式使用
 */
function exportPrint() {
  window.print();
}

/**
 * 复制 canvas 内容到剪贴板 (PNG 格式)
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<void>}
 */
async function copyToClipboard(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (!blob) {
        reject(new Error('toBlob 失败'));
        return;
      }
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob }),
        ]);
        resolve();
      } catch (err) {
        reject(err);
      }
    }, 'image/png');
  });
}

/**
 * 将色号矩阵导出为 JSON 数据 (存档/分享用)
 * @param {Array<Array>} matrix
 * @param {Object} stats
 * @param {string} paletteId
 * @returns {string} JSON 字符串
 */
function exportJSON(matrix, stats, paletteId) {
  // 精简矩阵: 只保留色号 ID
  const compact = matrix.map(row =>
    row.map(cell => cell ? cell.id : null)
  );

  const data = {
    version: 1,
    palette: paletteId,
    width: stats.width,
    height: stats.height,
    createdAt: new Date().toISOString(),
    matrix: compact,
    stats: {
      totalBeads: stats.totalBeads,
      colorCount: stats.colorCount,
      colors: stats.colors.map(c => ({ id: c.id, count: c.count })),
    },
  };

  return JSON.stringify(data, null, 2);
}

/**
 * 从导出的 JSON 数据还原色号矩阵
 * @param {string} jsonStr
 * @param {Object} palette - 色板对象 (用于还原完整颜色信息)
 * @returns {{ matrix: Array<Array>, stats: Object, paletteId: string }}
 */
function importJSON(jsonStr, palette) {
  const data = JSON.parse(jsonStr);

  if (!data.version || !data.matrix) {
    throw new Error('无效的图纸数据格式');
  }

  // 构建色号 → 颜色信息的快速查找
  const colorMap = {};
  for (const c of palette.colors) {
    colorMap[c.id] = c;
  }

  // 还原矩阵
  const matrix = data.matrix.map(row =>
    row.map(id => {
      if (!id) return null;
      const color = colorMap[id];
      if (!color) return null;
      return {
        id: color.id,
        name: color.name,
        hex: color.hex,
        rgb: color.rgb,
        category: color.category,
      };
    })
  );

  return {
    matrix,
    paletteId: data.palette,
    version: data.version,
  };
}
