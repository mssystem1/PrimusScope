export function numericChartValue(value: unknown): number | null {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

/** Preserve nulls and time gaps; singleton segments still need a visible marker. */
export function chartLineSegments(rows: {label: string; [key: string]: unknown}[], key: string, maxGapHours?: number) {
  const segments: {index: number; value: number}[][] = [];
  let segment: {index: number; value: number}[] = [];
  rows.forEach((row, index) => {
    const value = numericChartValue(row[key]);
    const gap = index > 0 && maxGapHours !== undefined
      && Date.parse(row.label) - Date.parse(rows[index - 1]!.label) > maxGapHours * 3600_000;
    if (value === null || gap) { if (segment.length) segments.push(segment); segment = []; }
    if (value !== null) segment.push({index, value});
  });
  if (segment.length) segments.push(segment);
  return segments;
}

/** Rounded, padded ticks avoid clipping a yield peak or presenting arbitrary decimals. */
export function yieldChartAxis(values: number[]) {
  const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1;
  const padding = Math.max(max - min, Math.abs(min) * .02, .1) * .12;
  const rawStep = (max - min + padding * 2) / 4;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].find(factor => factor * power >= rawStep)! * power;
  const low = Math.floor((min - padding) / step) * step, high = Math.ceil((max + padding) / step) * step;
  const ticks = Array.from({length: Math.round((high - low) / step) + 1}, (_, i) => high - i * step);
  return {low, high, ticks, precision: Math.max(0, -Math.floor(Math.log10(step)) + (step / power === 2.5 ? 1 : 0))};
}
