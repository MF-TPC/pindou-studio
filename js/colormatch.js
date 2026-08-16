/**
 * CIELAB 感知色彩匹配引擎 (V1.0 恢复版)
 *
 * RGB → XYZ (D65) → CIELAB → CIE76 ΔE*ab 欧氏距离
 * 这是最早验证有效 (90分) 的"直接 Lab 匹配"方案
 */

// ============ sRGB → XYZ (D65) ============

function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToXyz(r, g, b) {
  const rL = srgbToLinear(r);
  const gL = srgbToLinear(g);
  const bL = srgbToLinear(b);
  return {
    x: (rL * 0.4124564 + gL * 0.3575761 + bL * 0.1804375) * 100,
    y: (rL * 0.2126729 + gL * 0.7151522 + bL * 0.0721750) * 100,
    z: (rL * 0.0193339 + gL * 0.1191920 + bL * 0.9503041) * 100,
  };
}

// ============ XYZ → CIELAB (D65) ============

function fLab(t) {
  const delta = 6 / 29;
  return t > delta * delta * delta
    ? Math.cbrt(t)
    : t / (3 * delta * delta) + 4 / 29;
}

function xyzToLab(x, y, z) {
  const refX = 95.047, refY = 100.000, refZ = 108.883;
  return {
    L: 116 * fLab(y / refY) - 16,
    a: 500 * (fLab(x / refX) - fLab(y / refY)),
    b: 200 * (fLab(y / refY) - fLab(z / refZ)),
  };
}

function rgbToLab(r, g, b) {
  const { x, y, z } = rgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

// ============ CIE76 ΔE*ab ============

function deltaE76(lab1, lab2) {
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

// ============ 色板预计算 ============

function precomputeLab(colors) {
  return colors.map(function(c) {
    return {
      id: c.id, name: c.name, hex: c.hex, rgb: c.rgb, group: c.group,
      lab: rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]),
    };
  });
}

// ============ 匹配 ============

/**
 * 在预计算的 CIELAB 色板中查找最近颜色 (CIE76)
 * @param {Array<number>} targetRGB - [R, G, B]
 * @param {Array} labPalette - precomputeLab() 的结果
 * @param {number} [earlyExit=0.5] - ΔE*ab 低于此值直接返回
 */
function matchLab(targetRGB, labPalette, earlyExit) {
  if (earlyExit === undefined) earlyExit = 0.01; // 几乎不提前退出，确保找到真正最近色(相近色不再误配)
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

// ============ 颜色量化 (主导色直方图用) ============

function quantizeRGB(r, g, b) {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
}

function dequantizeRGB(key) {
  return [
    ((key >> 8) & 0xF) * 16 + 8,
    ((key >> 4) & 0xF) * 16 + 8,
    (key & 0xF) * 16 + 8,
  ];
}

/**
 * 返回前 N 个最接近的颜色
 */
function matchLabTopN(targetRGB, labPalette, n) {
  n = n || 3;
  const targetLab = rgbToLab(targetRGB[0], targetRGB[1], targetRGB[2]);
  const dists = [];
  for (let i = 0; i < labPalette.length; i++) {
    dists.push({
      id: labPalette[i].id, hex: labPalette[i].hex,
      rgb: labPalette[i].rgb, group: labPalette[i].group,
      distance: deltaE76(targetLab, labPalette[i].lab),
    });
  }
  dists.sort((a, b) => a.distance - b.distance);
  return dists.slice(0, n);
}
