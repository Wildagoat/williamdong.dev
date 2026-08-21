// dtw.js — Dynamic Time Warping. Aligns a detected technique's feature trajectory
// to a reference exemplar so two reps at different tempos still compare
// point-for-point (doc §6 "Comparison mechanics"). Pure, dependency-free.

/**
 * DTW distance + warping path between two 1-D series. Sakoe-Chiba band optional
 * (window as a fraction of the longer series) to keep the alignment sane and O(n*w).
 * @param {number[]} a @param {number[]} b
 * @param {{band?:number}} opts band in [0,1]; 0.2 = ±20% of length
 * @returns {{distance:number, normalized:number, path:[number,number][]}}
 */
export function dtw(a, b, { band = 0.2 } = {}) {
  const n = a.length, m = b.length;
  if (!n || !m) return { distance: Infinity, normalized: Infinity, path: [] };
  const w = Math.max(Math.abs(n - m), Math.floor(band * Math.max(n, m)));
  const INF = Infinity;
  const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  D[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    const jlo = Math.max(1, i - w), jhi = Math.min(m, i + w);
    for (let j = jlo; j <= jhi; j++) {
      const cost = Math.abs(a[i - 1] - b[j - 1]);
      D[i][j] = cost + Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
    }
  }
  // Backtrack the warping path
  const path = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const c = Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
    if (c === D[i - 1][j - 1]) { i--; j--; }
    else if (c === D[i - 1][j]) { i--; }
    else { j--; }
  }
  path.reverse();
  const distance = D[n][m];
  return { distance, normalized: distance / path.length, path };
}

/**
 * Resample a series to a fixed length by linear interpolation. Used to put every
 * detected technique on a common time base before DTW / band comparison.
 * @param {number[]} v @param {number} outLen
 */
export function resample(v, outLen) {
  if (v.length === 0) return new Array(outLen).fill(0);
  if (v.length === 1) return new Array(outLen).fill(v[0]);
  const out = new Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = (i / (outLen - 1)) * (v.length - 1);
    const lo = Math.floor(pos), hi = Math.min(v.length - 1, lo + 1);
    out[i] = v[lo] + (v[hi] - v[lo]) * (pos - lo);
  }
  return out;
}
