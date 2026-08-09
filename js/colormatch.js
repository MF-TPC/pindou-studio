/**
 * CIELAB 感知色彩匹配引擎
 *
 * 解决加权 RGB 距离的"同色不同号"问题:
 *   1. RGB → XYZ (sRGB, D65 白点) → CIELAB
 *   2. CIE76 ΔE*ab = √(ΔL² + Δa² + Δb²) — 人眼感知均匀
 *   3. 预计算色板 LAB 值，匹配时直接查表
 *
 * 参考: Bruce Lindbloom, http://www.brucelindbloom.com/
 */

// sRGB 逆伽马校正
function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * RGB [0-255]³ → XYZ (D65)
 */
function rgbToXyz(r, g, b) {
  const rL = srgbToLinear(r);
  const gL = srgbToLinear(g);
  const bL = srgbToLinear(b);

  // sRGB → XYZ (D65) 矩阵
  return {
    x: (rL * 0.4124564 + gL * 0.3575761 + bL * 0.1804375) * 100,
    y: (rL * 0.2126729 + gL * 0.7151522 + bL * 0.0721750) * 100,
    z: (rL * 0.0193339 + gL * 0.1191920 + bL * 0.9503041) * 100,
  };
}

/**
 * XYZ → CIELAB (D65 白点)
 */
function xyzToLab(x, y, z) {
  // D65 标准白点
  const refX = 95.047, refY = 100.000, refZ = 108.883;

  const fx = f(x / refX);
  const fy = f(y / refY);
  const fz = f(z / refZ);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function f(t) {
  const delta = 6 / 29;
  return t > delta * delta * delta
    ? Math.cbrt(t)
    : t / (3 * delta * delta) + 4 / 29;
}

/**
 * RGB [0-255]³ → CIELAB (L,a,b) 一步快捷转换
 */
function rgbToLab(r, g, b) {
  const { x, y, z } = rgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

/**
 * CIE76 色差 (ΔE*ab)
 */
function deltaE76(lab1, lab2) {
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * 预计算色板的 LAB 值 — 初始化时调用一次
 * @param {Array} colors - 色板颜色数组 [{id, name, hex, rgb, category}]
 * @returns {Array} 带 lab 字段的深拷贝
 */
function precomputeLab(colors) {
  return colors.map(c => ({
    ...c,
    lab: rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]),
  }));
}

/**
 * 在预计算的 LAB 色板中查找最近颜色
 * @param {Array<number>} targetRGB - [R, G, B]
 * @param {Array} labPalette - precomputeLab() 的结果
 * @param {number} [earlyExit=0.5] - ΔE 低于此值直接返回 (提前结束)
 * @returns 色板颜色对象
 */
function matchLab(targetRGB, labPalette, earlyExit = 0.5) {
  const targetLab = rgbToLab(targetRGB[0], targetRGB[1], targetRGB[2]);

  let best = labPalette[0];
  let bestDist = Infinity;

  for (let i = 0; i < labPalette.length; i++) {
    const dist = deltaE76(targetLab, labPalette[i].lab);
    if (dist < bestDist) {
      bestDist = dist;
      best = labPalette[i];
      if (dist <= earlyExit) break;
    }
  }

  return best;
}

/**
 * 颜色量化: RGB → 4bit/ch 桶索引 (16³ = 4096 桶)
 * 用于构建颜色直方图 (主导色提取)
 */
function quantizeRGB(r, g, b) {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
}

/**
 * 从桶索引还原近似 RGB (取桶中心值)
 */
function dequantizeRGB(key) {
  const r = ((key >> 8) & 0xF) * 16 + 8;
  const g = ((key >> 4) & 0xF) * 16 + 8;
  const b = (key & 0xF) * 16 + 8;
  return [r, g, b];
}
