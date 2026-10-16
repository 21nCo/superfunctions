export interface SignificanceResult {
  baselineMean: number;
  currentMean: number;
  difference: number;
  pValue: number;
  significant: boolean;
  permutations: number;
}
/** Seeded two-sided permutation test; significance is independent of practical regression thresholds. */
export function testSignificance(
  baseline: number[],
  current: number[],
  options: { alpha?: number; iterations?: number; seed?: number } = {},
): SignificanceResult {
  if (
    baseline.length < 2 ||
    current.length < 2 ||
    [...baseline, ...current].some((value) => !Number.isFinite(value))
  )
    throw new Error(
      "Significance requires two finite samples with at least two observations each",
    );
  const alpha = options.alpha ?? 0.05,
    iterations = options.iterations ?? 10000;
  if (
    !(alpha > 0 && alpha < 1) ||
    !Number.isInteger(iterations) ||
    iterations < 100 ||
    iterations > 1000000
  )
    throw new Error("Invalid significance options");
  const mean = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / values.length;
  const baselineMean = mean(baseline),
    currentMean = mean(current),
    difference = currentMean - baselineMean;
  const combined = [...baseline, ...current];
  let seed = (options.seed ?? 123456789) >>> 0,
    extreme = 0;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < iterations; i++) {
    const shuffled = [...combined];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    const permuted =
      mean(shuffled.slice(baseline.length)) -
      mean(shuffled.slice(0, baseline.length));
    if (Math.abs(permuted) >= Math.abs(difference) - Number.EPSILON) extreme++;
  }
  const pValue = (extreme + 1) / (iterations + 1);
  return {
    baselineMean,
    currentMean,
    difference,
    pValue,
    significant: pValue < alpha,
    permutations: iterations,
  };
}
