/**
 * 拼豆定位辅助引擎
 *
 * 四色状态:
 *   INVALID=0(黑)  PENDING=1(白)  COMPLETED=2(红)  CURRENT=3(绿)
 *
 * 图纸自动居中在板子上，图案外为 INVALID(黑)，图案内初始全为 PENDING(白)
 */

const STATUS = { INVALID: 0, PENDING: 1, COMPLETED: 2, CURRENT: 3 };

function createAssistant(colorMatrix, boardConfig, shiftX, shiftY) {
  shiftX = shiftX || 0; shiftY = shiftY || 0;
  const mh = colorMatrix.length, mw = mh > 0 ? colorMatrix[0].length : 0;
  const bw = boardConfig.width, bh = boardConfig.height;
  const base = centerOffset(boardConfig, mw, mh);
  const off = { ox: base.ox + shiftX, oy: base.oy + shiftY };

  // 构建板子尺寸的状态矩阵
  const statusMatrix = [];
  const paddedMatrix = []; // 板子尺寸的色号矩阵 (图案区外为 null)

  for (let y = 0; y < bh; y++) {
    const srow = [], prow = [];
    for (let x = 0; x < bw; x++) {
      const mx = x - off.ox, my = y - off.oy;
      const inPattern = mx >= 0 && mx < mw && my >= 0 && my < mh;
      const cell = inPattern ? colorMatrix[my][mx] : null;

      if (!cell) {
        srow.push(STATUS.INVALID);
        prow.push(null);
      } else {
        srow.push(STATUS.PENDING);
        prow.push(cell);
      }
    }
    statusMatrix.push(srow);
    paddedMatrix.push(prow);
  }

  // 统计图案内的位置 (排除 INVALID)
  const patternPositions = [];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (statusMatrix[y][x] !== STATUS.INVALID) {
        patternPositions.push({ x, y });
      }
    }
  }

  // 构建颜色批次 (只包含图案内有效位置)
  const batches = buildBatches(paddedMatrix, statusMatrix);
  let currentBatchIndex = -1;
  let isolatedList = [];

  if (batches.length > 0) {
    currentBatchIndex = 0;
    setBatchStatus(batches[0], statusMatrix, STATUS.CURRENT);
    isolatedList = detectIsolated(
      batches[0].positions,
      getCompletedPositions(statusMatrix),
    );
  }

  // --- API ---

  function advanceBatch() {
    if (currentBatchIndex < 0 || currentBatchIndex >= batches.length) {
      return { advanced: false, finished: true, batch: null };
    }
    const cur = batches[currentBatchIndex];
    setBatchStatus(cur, statusMatrix, STATUS.COMPLETED);
    cur.status = 'completed';
    currentBatchIndex++;
    if (currentBatchIndex >= batches.length) {
      isolatedList = [];
      return { advanced: true, finished: true, batch: null };
    }
    const next = batches[currentBatchIndex];
    setBatchStatus(next, statusMatrix, STATUS.CURRENT);
    next.status = 'current';
    isolatedList = detectIsolated(next.positions, getCompletedPositions(statusMatrix));
    return { advanced: true, finished: false, batch: next };
  }

  function revertBatch() {
    if (currentBatchIndex < 0) return { reverted: false, finished: false, batch: null, atStart: true };
    if (currentBatchIndex < batches.length) {
      setBatchStatus(batches[currentBatchIndex], statusMatrix, STATUS.PENDING);
      batches[currentBatchIndex].status = 'pending';
    }
    if (currentBatchIndex <= 0) { currentBatchIndex = -1; isolatedList = []; return { reverted: true, batch: null, atStart: true }; }
    currentBatchIndex--;
    const prev = batches[currentBatchIndex];
    setBatchStatus(prev, statusMatrix, STATUS.CURRENT);
    prev.status = 'current';
    isolatedList = detectIsolated(prev.positions, getCompletedPositions(statusMatrix));
    return { reverted: true, batch: prev };
  }

  function toggleCell(x, y) {
    if (x < 0 || x >= bw || y < 0 || y >= bh) return;
    const s = statusMatrix[y][x];
    if (s === STATUS.INVALID || s === STATUS.CURRENT) return;
    statusMatrix[y][x] = (s === STATUS.PENDING) ? STATUS.COMPLETED : STATUS.PENDING;
    if (currentBatchIndex >= 0 && currentBatchIndex < batches.length) {
      isolatedList = detectIsolated(batches[currentBatchIndex].positions, getCompletedPositions(statusMatrix));
    }
  }

  function getCurrentBatch() {
    if (currentBatchIndex < 0 || currentBatchIndex >= batches.length) return null;
    return { ...batches[currentBatchIndex], index: currentBatchIndex, total: batches.length };
  }

  function getBatchOverview() {
    return batches.map((b, i) => ({
      colorId: b.colorId, colorName: b.colorName, hex: b.hex,
      count: b.positions.length,
      status: i < currentBatchIndex ? 'completed' : i === currentBatchIndex ? 'current' : 'pending',
      index: i,
    }));
  }

  function moveBatch(fromIdx, toIdx) {
    if (fromIdx < 0 || fromIdx >= batches.length || toIdx < 0 || toIdx >= batches.length) return;
    if (fromIdx <= currentBatchIndex || toIdx <= currentBatchIndex) return; // 不能移动已完成或当前批
    var item = batches.splice(fromIdx, 1)[0];
    batches.splice(toIdx, 0, item);
    // 重新计算当前批次的孤立点
    if (currentBatchIndex >= 0 && currentBatchIndex < batches.length) {
      isolatedList = detectIsolated(batches[currentBatchIndex].positions, getCompletedPositions(statusMatrix));
    }
  }

  function getStatusMatrix() { return statusMatrix.map(r => [...r]); }
  function getIsolated() { return isolatedList; }
  function getPaddedMatrix() { return paddedMatrix; }

  return {
    statusMatrix, paddedMatrix: getPaddedMatrix(),
    advanceBatch, revertBatch, toggleCell, moveBatch,
    getCurrentBatch, getBatchOverview,
    getStatusMatrix, getIsolated, getPaddedMatrix,
    batches,
  };
}

// --- 内部 ---

function buildBatches(colorMatrix, statusMatrix) {
  const groups = {};
  const h = colorMatrix.length, w = h > 0 ? colorMatrix[0].length : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (statusMatrix[y][x] === STATUS.INVALID) continue;
      const cell = colorMatrix[y][x];
      if (!cell) continue;
      if (!groups[cell.id]) {
        groups[cell.id] = { colorId: cell.id, colorName: cell.name || cell.id, hex: cell.hex, positions: [], status: 'pending' };
      }
      groups[cell.id].positions.push({ x, y });
    }
  }
  return Object.values(groups).sort((a, b) => b.positions.length - a.positions.length);
}

function setBatchStatus(batch, sm, status) {
  for (const { x, y } of batch.positions) sm[y][x] = status;
}

function getCompletedPositions(sm) {
  const out = [];
  for (let y = 0; y < sm.length; y++)
    for (let x = 0; x < sm[y].length; x++)
      if (sm[y][x] === STATUS.COMPLETED) out.push({ x, y });
  return out;
}

// --- 孤立点检测 ---

function detectIsolated(currentPositions, completedPositions, opts) {
  opts = opts || {};
  const threshold = opts.threshold || 5;
  const clusterRadius = opts.clusterRadius || 3;
  const clusterMin = opts.clusterMinNeighbors || 3;
  const maxP = opts.maxPaths || 8;

  if (!completedPositions.length || !currentPositions.length) return [];
  const currentSet = new Set(currentPositions.map(p => p.x + ',' + p.y));
  const candidates = [];

  for (const pos of currentPositions) {
    const minDist = minManhattan(pos, completedPositions);
    if (minDist < threshold) continue;

    let nbr = 0;
    for (let dy = -clusterRadius; dy <= clusterRadius; dy++)
      for (let dx = -clusterRadius; dx <= clusterRadius; dx++)
        if ((dx || dy) && currentSet.has((pos.x + dx) + ',' + (pos.y + dy))) nbr++;
    if (nbr >= clusterMin) continue;

    const nearest = findNearest(pos, completedPositions);
    candidates.push({ x: pos.x, y: pos.y, fromX: nearest.x, fromY: nearest.y, distance: minDist });
  }

  candidates.sort((a, b) => b.distance - a.distance);
  return candidates.slice(0, maxP);
}

function minManhattan(pos, targets) {
  let min = Infinity;
  for (const t of targets) {
    const d = Math.abs(pos.x - t.x) + Math.abs(pos.y - t.y);
    if (d < min) min = d;
    if (min === 1) break;
  }
  return min;
}

function findNearest(pos, targets) {
  let best = targets[0], bd = Infinity;
  for (const t of targets) {
    const d = Math.abs(pos.x - t.x) + Math.abs(pos.y - t.y);
    if (d < bd) { bd = d; best = t; }
    if (d === 0) break;
  }
  return best;
}
