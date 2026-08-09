/**
 * 抖动算法模块
 * 在颜色量化时通过误差扩散减少色带，保持图像细节
 */

/**
 * Floyd-Steinberg 误差扩散抖动
 * 经典算法，将量化误差按权重扩散到相邻未处理像素
 *
 * 权重分布 (→ 右侧, ↓ 下一行):
 *       X   7/16
 *   3/16  5/16  1/16
 *
 * @param {ImageData} imageData - 原始图像数据 (会被原地修改)
 * @param {Object} palette - 色板对象 { colors: [{rgb}] }
 * @param {Function} matchColor - 颜色匹配函数 (r,g,b) => {rgb}
 * @returns {ImageData} 处理后的图像数据
 */
function floydSteinberg(imageData, palette, matchColor) {
  const { width, height, data } = imageData;
  const errors = new Float32Array(width * height * 3); // 每个像素的累积误差

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const errIdx = (y * width + x) * 3;

      // 原始颜色 + 累积误差
      let r = data[idx]     + errors[errIdx];
      let g = data[idx + 1] + errors[errIdx + 1];
      let b = data[idx + 2] + errors[errIdx + 2];

      // Clamp 到 [0, 255]
      r = Math.max(0, Math.min(255, r));
      g = Math.max(0, Math.min(255, g));
      b = Math.max(0, Math.min(255, b));

      // 匹配最近色号
      const matched = matchColor(r, g, b);
      const qR = matched.rgb[0];
      const qG = matched.rgb[1];
      const qB = matched.rgb[2];

      // 量化误差
      const errR = r - qR;
      const errG = g - qG;
      const errB = b - qB;

      // 写入量化后的颜色
      data[idx]     = qR;
      data[idx + 1] = qG;
      data[idx + 2] = qB;

      // 扩散误差到相邻像素
      if (x + 1 < width) {
        const e = (y * width + (x + 1)) * 3;
        errors[e]     += errR * (7 / 16);
        errors[e + 1] += errG * (7 / 16);
        errors[e + 2] += errB * (7 / 16);
      }
      if (y + 1 < height) {
        if (x > 0) {
          const e = ((y + 1) * width + (x - 1)) * 3;
          errors[e]     += errR * (3 / 16);
          errors[e + 1] += errG * (3 / 16);
          errors[e + 2] += errB * (3 / 16);
        }
        {
          const e = ((y + 1) * width + x) * 3;
          errors[e]     += errR * (5 / 16);
          errors[e + 1] += errG * (5 / 16);
          errors[e + 2] += errB * (5 / 16);
        }
        if (x + 1 < width) {
          const e = ((y + 1) * width + (x + 1)) * 3;
          errors[e]     += errR * (1 / 16);
          errors[e + 1] += errG * (1 / 16);
          errors[e + 2] += errB * (1 / 16);
        }
      }
    }
  }

  return imageData;
}

/**
 * Bayer 有序抖动 (Ordered Dithering)
 * 使用固定阈值矩阵，不依赖邻域处理，适合需要一致性的场景
 *
 * @param {ImageData} imageData
 * @param {Object} palette
 * @param {Function} matchColor
 * @param {number} matrixSize - 阈值矩阵大小 (4 或 8)
 * @returns {ImageData}
 */
function orderedDither(imageData, palette, matchColor, matrixSize = 4) {
  const { width, height, data } = imageData;

  // 预生成 Bayer 矩阵
  let bayer;
  if (matrixSize === 4) {
    bayer = [
      [ 0,  8,  2, 10],
      [12,  4, 14,  6],
      [ 3, 11,  1,  9],
      [15,  7, 13,  5],
    ];
  } else {
    // 8x8 Bayer matrix
    bayer = generateBayer8();
  }

  const n = bayer.length;
  const n2 = n * n;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // 计算阈值扩散量
      const threshold = (bayer[y % n][x % n] / n2 - 0.5) * 64;

      // 加阈值后 clamp
      const drR = Math.max(0, Math.min(255, r + threshold));
      const drG = Math.max(0, Math.min(255, g + threshold));
      const drB = Math.max(0, Math.min(255, b + threshold));

      const matched = matchColor(drR, drG, drB);
      data[idx]     = matched.rgb[0];
      data[idx + 1] = matched.rgb[1];
      data[idx + 2] = matched.rgb[2];
    }
  }

  return imageData;
}

/** 生成 8×8 Bayer 矩阵 */
function generateBayer8() {
  // 递归构造: M_{2n} = [4*M_n, 4*M_n+2; 4*M_n+3, 4*M_n+1]
  const size = 8;
  const m = new Array(size);
  for (let i = 0; i < size; i++) m[i] = new Array(size).fill(0);
  m[0][0] = 0;
  m[0][1] = 2;
  m[1][0] = 3;
  m[1][1] = 1;

  for (let step = 2; step < size; step *= 2) {
    for (let y = 0; y < step; y++) {
      for (let x = 0; x < step; x++) {
        const v = m[y][x];
        m[y][x]               = 4 * v;
        m[y][x + step]        = 4 * v + 2;
        m[y + step][x]        = 4 * v + 3;
        m[y + step][x + step] = 4 * v + 1;
      }
    }
  }

  // 归一化到 0-63
  const n2 = size * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      m[y][x] = Math.round(m[y][x] * (63 / n2));
    }
  }
  return m;
}
