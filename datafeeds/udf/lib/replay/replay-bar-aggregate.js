export function resolutionToSeconds(resolution) {
    const normalized = normalizeResolution(resolution);
    if (normalized === '1D' || normalized === 'D') {
        return 24 * 60 * 60;
    }
    if (normalized === '1W' || normalized === 'W') {
        return 7 * 24 * 60 * 60;
    }
    if (normalized === '1M' || normalized === 'M') {
        return 30 * 24 * 60 * 60;
    }
    const minutes = Number.parseInt(normalized, 10);
    if (Number.isFinite(minutes) && minutes > 0) {
        return minutes * 60;
    }
    return 60;
}
export function normalizeResolution(resolution) {
    const trimmed = resolution.trim();
    if (trimmed === 'D') {
        return '1D';
    }
    if (trimmed === 'W') {
        return '1W';
    }
    if (trimmed === 'M') {
        return '1M';
    }
    return trimmed;
}
export function getChartBucketStart(timeMs, chartResolutionSeconds) {
    const periodMs = chartResolutionSeconds * 1000;
    return Math.floor(timeMs / periodMs) * periodMs;
}
/** After finishing the chart bar containing `timeMs`, resume at the next chart bucket open. */
export function getNextChartBucketStart(timeMs, chartResolutionSeconds) {
    return getChartBucketStart(timeMs, chartResolutionSeconds) + chartResolutionSeconds * 1000;
}
/**
 * Resume time when switching step resolution.
 * Coarser-or-equal step (vs chart) stays on the current chart bucket; finer step advances to the next bucket.
 */
export function getStepResolutionResumeMs(currentTimeMs, chartResolutionSeconds, newStepResolutionSeconds) {
    if (newStepResolutionSeconds >= chartResolutionSeconds) {
        return getChartBucketStart(currentTimeMs, chartResolutionSeconds);
    }
    return getNextChartBucketStart(currentTimeMs, chartResolutionSeconds);
}
/**
 * Aggregate step-resolution bars through `endIndex` (inclusive) into chart-resolution OHLC buckets.
 */
export function aggregateStepBarsToChartBars(stepBars, endIndex, chartResolutionSeconds) {
    if (!stepBars.length || endIndex < 0) {
        return [];
    }
    const end = Math.min(endIndex, stepBars.length - 1);
    const buckets = new Map();
    for (let i = 0; i <= end; i += 1) {
        const bar = stepBars[i];
        const bucketStart = getChartBucketStart(bar.time, chartResolutionSeconds);
        const existing = buckets.get(bucketStart);
        if (!existing) {
            buckets.set(bucketStart, {
                time: bucketStart,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
            });
            continue;
        }
        existing.high = Math.max(existing.high, bar.high);
        existing.low = Math.min(existing.low, bar.low);
        existing.close = bar.close;
        if (bar.volume !== undefined) {
            existing.volume = (existing.volume ?? 0) + bar.volume;
        }
    }
    return Array.from(buckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, bar]) => bar);
}
/** True when consecutive bar spacing matches the target step resolution (within tolerance). */
export function stepBarsMatchResolution(bars, resolutionSeconds) {
    if (!bars.length) {
        return false;
    }
    if (bars.length === 1) {
        return true;
    }
    const expectedMs = resolutionSeconds * 1000;
    const start = Math.max(1, bars.length - 32);
    let matches = 0;
    let checked = 0;
    for (let i = start; i < bars.length; i += 1) {
        const delta = bars[i].time - bars[i - 1].time;
        if (delta <= 0) {
            continue;
        }
        checked += 1;
        if (delta >= expectedMs * 0.5 && delta <= expectedMs * 1.5) {
            matches += 1;
        }
    }
    if (!checked) {
        return true;
    }
    return matches / checked >= 0.6;
}
/**
 * When API cannot return finer bars, derive them from existing coarser step bars in memory.
 * Each coarse bar is split into equal-duration finer bars (flat OHLC within the coarse period).
 */
export function synthesizeFinerStepBarsFromCoarser(coarseBars, coarserResolutionSeconds, finerResolutionSeconds, bucketStartMs) {
    if (!coarseBars.length || finerResolutionSeconds <= 0 || coarserResolutionSeconds <= finerResolutionSeconds) {
        return [];
    }
    const ratio = coarserResolutionSeconds / finerResolutionSeconds;
    const steps = Math.round(ratio);
    if (steps < 2) {
        return [];
    }
    const finerStepMs = finerResolutionSeconds * 1000;
    const result = [];
    for (const bar of coarseBars) {
        for (let j = 0; j < steps; j += 1) {
            const time = bar.time + j * finerStepMs;
            result.push({
                time,
                open: j === 0 ? bar.open : bar.close,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume !== undefined ? bar.volume / steps : undefined,
            });
        }
    }
    return result.filter((bar) => bar.time >= bucketStartMs);
}
/** Keep frozen chart history; replace overlapping buckets with the live tail aggregate. */
export function mergeFrozenChartBarsWithTail(frozen, tail) {
    if (!frozen.length) {
        return tail;
    }
    if (!tail.length) {
        return frozen;
    }
    const tailStart = tail[0].time;
    const prefix = frozen.filter((bar) => bar.time < tailStart);
    return [...prefix, ...tail];
}
