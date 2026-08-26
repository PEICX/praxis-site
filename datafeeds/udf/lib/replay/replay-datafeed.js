import { aggregateStepBarsToChartBars, getStepResolutionResumeMs, normalizeResolution, resolutionToSeconds, stepBarsMatchResolution, } from './replay-bar-aggregate';
/**
 * ReplayDatafeedWrapper wraps an existing datafeed and provides replay functionality.
 * In replay mode, it filters historical data based on the replay controller's current time.
 */
export class ReplayDatafeedWrapper {
    constructor(originalDatafeed, replayController) {
        this._isReplayMode = false;
        this._barSubscriptions = new Map();
        this._unsubscribeTick = null;
        this._resetCacheCallbacks = new Map();
        this._liveSubscriptions = new Set();
        this._liveSubscriptionsPaused = false;
        this._msThreshold = 1_000_000_000_000;
        this._maxHistoryMs = 2 * 365 * 24 * 60 * 60 * 1000;
        this._replayStartTimeMs = null;
        this._historyLoadPromise = null;
        this._forwardLoadPromise = null;
        this._replayHistoryExhausted = false;
        this._replayForwardExhausted = false;
        this._chartResolution = null;
        this._stepResolution = null;
        this._symbolInfo = null;
        this._stepResolutionChangePromise = null;
        this._originalDatafeed = originalDatafeed;
        this._replayController = replayController;
        this._replayController.setEndAdvanceHandler(() => this._tryExtendForwardBars());
    }
    /**
     * Get the replay controller instance.
     */
    getReplayController() {
        return this._replayController;
    }
    /**
     * Check if currently in replay mode.
     */
    isReplayMode() {
        return this._isReplayMode;
    }
    /**
     * Start replay mode at a specific time.
     * This will preload bars and initialize the replay controller.
     * @param symbolNameOrInfo Either a symbol name string or LibrarySymbolInfo object
     * @param resolution The chart resolution
     * @param startTime The timestamp to start replay from
     */
    async startReplay(symbolNameOrInfo, resolution, startTime, stepResolution) {
        // Resolve symbol if needed
        let symbolInfo;
        if (typeof symbolNameOrInfo === 'string') {
            symbolInfo = await this._resolveSymbol(symbolNameOrInfo);
        }
        else {
            symbolInfo = symbolNameOrInfo;
        }
        console.log('[ReplayDatafeed] startReplay', typeof symbolNameOrInfo === 'string' ? symbolNameOrInfo : symbolNameOrInfo.name, resolution, startTime);
        if (!Number.isFinite(startTime)) {
            console.warn('[ReplayDatafeed] startReplay received invalid startTime', startTime);
        }
        if (this._isReplayMode) {
            this.exitReplay();
        }
        this._replayStartTimeMs = Number.isFinite(startTime) ? startTime : null;
        this._replayHistoryExhausted = false;
        this._replayForwardExhausted = false;
        this._historyLoadPromise = null;
        this._forwardLoadPromise = null;
        this._chartResolution = resolution;
        this._stepResolution = stepResolution ?? resolution;
        this._symbolInfo = symbolInfo;
        // Load history at step resolution; chart bars are aggregated in the controller.
        let bars = await this._loadHistoricalBars(symbolInfo, this._stepResolution, startTime);
        bars = this._normalizeBarsToMs(bars);
        if (bars.length === 0) {
            throw new Error('No historical data available for replay');
        }
        // Ensure bars are sorted by time ascending (oldest first)
        bars = [...bars].sort((a, b) => a.time - b.time);
        // Find the start index based on the start time
        let startIndex = 0;
        for (let i = 0; i < bars.length; i++) {
            if (bars[i].time >= startTime) {
                startIndex = Math.max(0, i - 1);
                break;
            }
        }
        // If startTime is after all bars, start from near the end
        if (startIndex === 0 && bars.length > 1 && bars[0].time < startTime) {
            startIndex = bars.length - 10; // Start 10 bars from the end
            if (startIndex < 0)
                startIndex = 0;
        }
        this._replayController.start(bars, startIndex, resolution, this._stepResolution);
        this._isReplayMode = true;
        this._pauseLiveSubscriptions();
        console.log(`[ReplayDatafeed] Started replay with ${bars.length} bars, starting at index ${startIndex}`);
        // Subscribe to tick events to push new bars
        this._unsubscribeTick = this._replayController.onTick((_bar, isNewBar) => {
            if (isNewBar || this._shouldPushFormingBarUpdate()) {
                this._pushBarToSubscribers();
            }
        });
        // Notify chart to reset cache and refetch data
        this._triggerResetCache();
    }
    /**
     * Switch step resolution without resetting the chart. Loads real bars around the resume
     * anchor; does not fall back to in-memory synthesis or aggregation.
     */
    async changeStepResolution(stepResolution) {
        if (!this._isReplayMode || !this._symbolInfo || !this._chartResolution) {
            return;
        }
        const normalizedStep = normalizeResolution(stepResolution);
        if (this._stepResolutionChangePromise) {
            await this._stepResolutionChangePromise.catch(() => { });
        }
        const currentStep = normalizeResolution(this._replayController.getStepResolution());
        if (normalizedStep === currentStep) {
            this._replayController.clearStepResolutionLoading();
            return;
        }
        const run = async () => {
            const currentSeconds = resolutionToSeconds(currentStep);
            const newSeconds = resolutionToSeconds(normalizedStep);
            const chartSeconds = resolutionToSeconds(this._chartResolution);
            const currentMs = this._replayController.getCurrentTime();
            const resumeMs = getStepResolutionResumeMs(currentMs, chartSeconds, newSeconds);
            this._replayController.beginStepResolutionChange(resumeMs);
            try {
                let bars = await this._loadStepBarsForResolutionChange(this._symbolInfo, normalizedStep, resumeMs);
                bars = bars.filter((bar) => bar.time >= resumeMs);
                const finerBars = this._replayController.getAllBars();
                const finerIndex = this._replayController.getCurrentBarIndex();
                if (newSeconds > currentSeconds) {
                    bars = this._mergeCoarserStepBarsFromFinerMemory(finerBars, finerIndex, newSeconds, resumeMs, bars);
                }
                bars = this._fillStepBarGapsFromFinerMemory(finerBars, newSeconds, resumeMs, bars);
                if (!bars.length || !stepBarsMatchResolution(bars, newSeconds)) {
                    console.warn('[ReplayDatafeed] step resolution change: missing or mismatched bars', normalizedStep, 'count=', bars.length);
                    throw new Error('No historical data for selected step resolution');
                }
                this._replayController.applyStepResolutionFromBars(bars, normalizedStep, resumeMs);
                this._stepResolution = normalizedStep;
            }
            catch (error) {
                this._replayController.failStepResolutionChange();
                throw error;
            }
        };
        this._stepResolutionChangePromise = run().finally(() => {
            this._stepResolutionChangePromise = null;
        });
        await this._stepResolutionChangePromise;
    }
    /**
     * Trigger reset cache callbacks to force chart to refetch data.
     */
    _triggerResetCache() {
        for (const callback of this._resetCacheCallbacks.values()) {
            try {
                callback();
            }
            catch (e) {
                console.error('ReplayDatafeedWrapper: Error calling reset cache callback', e);
            }
        }
    }
    /**
     * Exit replay mode and return to live data.
     */
    exitReplay() {
        if (this._unsubscribeTick) {
            this._unsubscribeTick();
            this._unsubscribeTick = null;
        }
        this._replayController.exit();
        this._isReplayMode = false;
        this._resumeLiveSubscriptions();
        this._replayStartTimeMs = null;
        this._historyLoadPromise = null;
        this._forwardLoadPromise = null;
        this._replayHistoryExhausted = false;
        this._replayForwardExhausted = false;
        this._chartResolution = null;
        this._stepResolution = null;
        this._symbolInfo = null;
        this._stepResolutionChangePromise = null;
        console.log('[ReplayDatafeed] Exited replay mode');
        // Notify chart to reset cache and refetch live data
        this._triggerResetCache();
    }
    // ==================== IExternalDatafeed Implementation ====================
    onReady(callback) {
        this._originalDatafeed.onReady(callback);
    }
    // ==================== IDatafeedChartApi Implementation ====================
    searchSymbols(userInput, exchange, symbolType, onResult) {
        if ('searchSymbols' in this._originalDatafeed && this._originalDatafeed.searchSymbols) {
            this._originalDatafeed.searchSymbols(userInput, exchange, symbolType, onResult);
        }
    }
    resolveSymbol(symbolName, onResolve, onError, extension) {
        if ('resolveSymbol' in this._originalDatafeed && this._originalDatafeed.resolveSymbol) {
            this._originalDatafeed.resolveSymbol(symbolName, onResolve, onError, extension);
        }
    }
    getBars(symbolInfo, resolution, periodParams, onResult, onError) {
        if (!this._isReplayMode) {
            // Normal mode - pass through to original datafeed
            if ('getBars' in this._originalDatafeed && this._originalDatafeed.getBars) {
                this._originalDatafeed.getBars(symbolInfo, resolution, periodParams, onResult, onError);
            }
            return;
        }
        void this._handleReplayGetBars(symbolInfo, resolution, periodParams, onResult, onError);
    }
    async _handleReplayGetBars(symbolInfo, resolution, periodParams, onResult, onError) {
        try {
            const fromMs = periodParams.from * 1000;
            const toMs = periodParams.to * 1000;
            let visibleBars = this._replayController.getVisibleBarsForResolution(resolution);
            if (!visibleBars.length || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
                onResult([], { noData: true });
                return;
            }
            const earliestVisibleMs = visibleBars[0].time;
            if (fromMs < earliestVisibleMs) {
                await this._maybeLoadEarlierBars(symbolInfo, resolution, fromMs, earliestVisibleMs, periodParams);
                visibleBars = this._replayController.getVisibleBarsForResolution(resolution);
            }
            let filteredBars = visibleBars.filter((bar) => bar.time >= fromMs && bar.time < toMs);
            const countBack = periodParams.countBack ?? 0;
            if (countBack > 0 && filteredBars.length < countBack) {
                const needed = countBack - filteredBars.length;
                const extra = [];
                for (let i = visibleBars.length - 1; i >= 0; i--) {
                    const bar = visibleBars[i];
                    if (bar.time < fromMs) {
                        extra.push(bar);
                        if (extra.length >= needed) {
                            break;
                        }
                    }
                }
                if (extra.length) {
                    filteredBars = [...extra.reverse(), ...filteredBars];
                }
            }
            console.log(`[ReplayDatafeed] getBars: visible=${visibleBars.length}, filtered=${filteredBars.length}, range=${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()}`);
            const meta = {
                noData: filteredBars.length === 0,
            };
            if (meta.noData && visibleBars.length > 0) {
                let nextTimeMs;
                for (let i = visibleBars.length - 1; i >= 0; i--) {
                    if (visibleBars[i].time < fromMs) {
                        nextTimeMs = visibleBars[i].time;
                        break;
                    }
                }
                if (nextTimeMs !== undefined) {
                    meta.nextTime = Math.floor(nextTimeMs / 1000);
                }
            }
            onResult(filteredBars, meta);
        }
        catch (error) {
            onError(error instanceof Error ? error.message : String(error));
        }
    }
    async _maybeLoadEarlierBars(symbolInfo, resolution, fromMs, earliestVisibleMs, periodParams) {
        if (this._replayHistoryExhausted) {
            return;
        }
        const anchorMs = this._replayStartTimeMs ?? this._replayController.getCurrentTime() ?? Date.now();
        const minAllowedMs = Math.max(0, anchorMs - this._maxHistoryMs);
        const clampedFromMs = Math.max(minAllowedMs, fromMs);
        if (clampedFromMs >= earliestVisibleMs) {
            return;
        }
        if (this._historyLoadPromise) {
            await this._historyLoadPromise;
            return;
        }
        const loadResolution = this._stepResolution ?? resolution;
        const beforeCount = this._replayController.getTotalBars();
        this._historyLoadPromise = this._requestHistoricalBars(symbolInfo, loadResolution, clampedFromMs, earliestVisibleMs, periodParams, beforeCount, minAllowedMs);
        try {
            await this._historyLoadPromise;
        }
        finally {
            this._historyLoadPromise = null;
        }
    }
    async _tryExtendForwardBars() {
        if (!this._isReplayMode || !this._symbolInfo || !this._stepResolution) {
            return false;
        }
        if (this._replayForwardExhausted) {
            return false;
        }
        if (this._forwardLoadPromise) {
            return this._forwardLoadPromise;
        }
        const allBars = this._replayController.getAllBars();
        if (!allBars.length) {
            return false;
        }
        const lastBarTime = allBars[allBars.length - 1].time;
        const nowMs = Date.now();
        const secondsPerBar = this._estimateSecondsPerBar(this._stepResolution);
        const nearNowThresholdMs = secondsPerBar * 1000;
        if (lastBarTime >= nowMs - nearNowThresholdMs) {
            this._replayForwardExhausted = true;
            return false;
        }
        const beforeCount = this._replayController.getTotalBars();
        this._forwardLoadPromise = this._requestForwardBars(this._symbolInfo, this._stepResolution, lastBarTime, beforeCount)
            .then(() => this._replayController.getTotalBars() > beforeCount)
            .finally(() => {
            this._forwardLoadPromise = null;
        });
        return this._forwardLoadPromise;
    }
    async _requestForwardBars(symbolInfo, resolution, lastBarTimeMs, beforeCount) {
        const secondsPerBar = this._estimateSecondsPerBar(resolution);
        const resumeMs = lastBarTimeMs;
        const resumeSec = Math.floor(resumeMs / 1000);
        const nowSec = Math.floor(Date.now() / 1000);
        // Query the next available bars across the entire known time range. A fixed
        // wall-clock window can end inside a weekend or holiday and incorrectly make
        // an empty response look like the end of the complete data set.
        const fromSec = resumeSec + 1;
        const toSec = nowSec;
        if (fromSec >= toSec) {
            this._replayForwardExhausted = true;
            return false;
        }
        const periodParams = {
            from: fromSec,
            to: toSec,
            countBack: 0,
            firstDataRequest: false,
            order: 'asc',
        };
        console.log('[ReplayDatafeed] requestForwardBars', symbolInfo.ticker || symbolInfo.name, resolution, periodParams);
        const bars = await new Promise((resolve, reject) => {
            if ('getBars' in this._originalDatafeed && this._originalDatafeed.getBars) {
                this._originalDatafeed.getBars(symbolInfo, resolution, periodParams, (loaded) => {
                    resolve(loaded);
                }, (error) => {
                    reject(new Error(error));
                });
            }
            else {
                reject(new Error('Original datafeed does not support getBars'));
            }
        });
        const normalized = this._normalizeBarsToMs(bars)
            .filter((bar) => bar.time > resumeMs)
            .sort((a, b) => a.time - b.time);
        if (!normalized.length) {
            this._replayForwardExhausted = true;
            return false;
        }
        this._replayController.appendBars(normalized);
        const afterCount = this._replayController.getTotalBars();
        if (afterCount <= beforeCount) {
            this._replayForwardExhausted = true;
            return false;
        }
        const latestBarTime = this._replayController.getAllBars()[afterCount - 1]?.time ?? resumeMs;
        if (latestBarTime >= Date.now() - secondsPerBar * 1000) {
            this._replayForwardExhausted = true;
        }
        return true;
    }
    async _requestHistoricalBars(symbolInfo, resolution, fromMs, toMs, periodParams, beforeCount, minAllowedMs) {
        const secondsPerBar = this._estimateSecondsPerBar(resolution);
        const rangeSeconds = Math.max(0, Math.floor((toMs - fromMs) / 1000));
        const rangeBars = Math.ceil(rangeSeconds / secondsPerBar);
        const countBack = Math.min(450000, Math.max(periodParams.countBack ?? 0, rangeBars));
        const requestParams = {
            from: Math.floor(fromMs / 1000),
            to: Math.floor(toMs / 1000),
            countBack,
            firstDataRequest: false,
        };
        const bars = await new Promise((resolve, reject) => {
            if ('getBars' in this._originalDatafeed && this._originalDatafeed.getBars) {
                this._originalDatafeed.getBars(symbolInfo, resolution, requestParams, (loadedBars) => {
                    resolve(loadedBars);
                }, (error) => {
                    reject(new Error(error));
                });
            }
            else {
                reject(new Error('Original datafeed does not support getBars'));
            }
        });
        const normalized = this._normalizeBarsToMs(bars).filter((bar) => bar.time < toMs);
        if (!normalized.length) {
            if (fromMs <= minAllowedMs) {
                this._replayHistoryExhausted = true;
            }
            return;
        }
        this._replayController.prependBars(normalized);
        const afterCount = this._replayController.getTotalBars();
        if (afterCount === beforeCount && fromMs <= minAllowedMs) {
            this._replayHistoryExhausted = true;
        }
    }
    subscribeBars(symbolInfo, resolution, onTick, listenerGuid, onResetCacheNeededCallback) {
        // Store the subscription and reset callback
        this._barSubscriptions.set(listenerGuid, {
            symbolInfo,
            resolution,
            callback: onTick,
            listenerGuid,
        });
        this._resetCacheCallbacks.set(listenerGuid, onResetCacheNeededCallback);
        this._liveSubscriptions.add(listenerGuid);
        if (!this._isReplayMode && !this._liveSubscriptionsPaused) {
            // Normal mode - pass through to original datafeed
            if ('subscribeBars' in this._originalDatafeed && this._originalDatafeed.subscribeBars) {
                this._originalDatafeed.subscribeBars(symbolInfo, resolution, onTick, listenerGuid, onResetCacheNeededCallback);
            }
        }
        // In replay mode, we handle bar updates via the replay controller
    }
    unsubscribeBars(listenerGuid) {
        this._barSubscriptions.delete(listenerGuid);
        this._resetCacheCallbacks.delete(listenerGuid);
        this._liveSubscriptions.delete(listenerGuid);
        if ('unsubscribeBars' in this._originalDatafeed && this._originalDatafeed.unsubscribeBars) {
            this._originalDatafeed.unsubscribeBars(listenerGuid);
        }
    }
    _pauseLiveSubscriptions() {
        if (this._liveSubscriptionsPaused) {
            return;
        }
        if ('unsubscribeBars' in this._originalDatafeed && this._originalDatafeed.unsubscribeBars) {
            for (const listenerGuid of this._liveSubscriptions) {
                try {
                    this._originalDatafeed.unsubscribeBars(listenerGuid);
                }
                catch (e) {
                    console.error('ReplayDatafeedWrapper: Error pausing live subscription', e);
                }
            }
        }
        this._liveSubscriptionsPaused = true;
    }
    _resumeLiveSubscriptions() {
        if (!this._liveSubscriptionsPaused) {
            return;
        }
        if ('subscribeBars' in this._originalDatafeed && this._originalDatafeed.subscribeBars) {
            for (const listenerGuid of this._liveSubscriptions) {
                const subscription = this._barSubscriptions.get(listenerGuid);
                if (!subscription) {
                    continue;
                }
                try {
                    this._originalDatafeed.subscribeBars(subscription.symbolInfo, subscription.resolution, subscription.callback, subscription.listenerGuid, this._resetCacheCallbacks.get(listenerGuid) || (() => undefined));
                }
                catch (e) {
                    console.error('ReplayDatafeedWrapper: Error resuming live subscription', e);
                }
            }
        }
        this._liveSubscriptionsPaused = false;
    }
    // Optional methods - pass through if available
    getMarks(symbolInfo, from, to, onDataCallback, resolution) {
        if ('getMarks' in this._originalDatafeed && this._originalDatafeed.getMarks) {
            if (this._isReplayMode) {
                // In replay mode, only show marks up to current time
                const currentTime = this._replayController.getCurrentTime() / 1000;
                this._originalDatafeed.getMarks(symbolInfo, from, Math.min(to, currentTime), onDataCallback, resolution);
            }
            else {
                this._originalDatafeed.getMarks(symbolInfo, from, to, onDataCallback, resolution);
            }
        }
    }
    getTimescaleMarks(symbolInfo, from, to, onDataCallback, resolution) {
        if ('getTimescaleMarks' in this._originalDatafeed && this._originalDatafeed.getTimescaleMarks) {
            if (this._isReplayMode) {
                const currentTime = this._replayController.getCurrentTime() / 1000;
                this._originalDatafeed.getTimescaleMarks(symbolInfo, from, Math.min(to, currentTime), onDataCallback, resolution);
            }
            else {
                this._originalDatafeed.getTimescaleMarks(symbolInfo, from, to, onDataCallback, resolution);
            }
        }
    }
    getServerTime(callback) {
        if ('getServerTime' in this._originalDatafeed && this._originalDatafeed.getServerTime) {
            if (this._isReplayMode) {
                // In replay mode, return the current replay time
                callback(Math.floor(this._replayController.getCurrentTime() / 1000));
            }
            else {
                this._originalDatafeed.getServerTime(callback);
            }
        }
    }
    // ==================== IDatafeedQuotesApi Implementation ====================
    getQuotes(symbols, onDataCallback, onErrorCallback) {
        if ('getQuotes' in this._originalDatafeed && this._originalDatafeed.getQuotes) {
            this._originalDatafeed.getQuotes(symbols, onDataCallback, onErrorCallback);
        }
    }
    subscribeQuotes(symbols, fastSymbols, onRealtimeCallback, listenerGUID) {
        if ('subscribeQuotes' in this._originalDatafeed && this._originalDatafeed.subscribeQuotes) {
            this._originalDatafeed.subscribeQuotes(symbols, fastSymbols, onRealtimeCallback, listenerGUID);
        }
    }
    unsubscribeQuotes(listenerGUID) {
        if ('unsubscribeQuotes' in this._originalDatafeed && this._originalDatafeed.unsubscribeQuotes) {
            this._originalDatafeed.unsubscribeQuotes(listenerGUID);
        }
    }
    // ==================== Private Methods ====================
    async _resolveSymbol(symbolName) {
        return new Promise((resolve, reject) => {
            if ('resolveSymbol' in this._originalDatafeed && this._originalDatafeed.resolveSymbol) {
                this._originalDatafeed.resolveSymbol(symbolName, (symbolInfo) => {
                    resolve(symbolInfo);
                }, (error) => {
                    reject(new Error(error));
                });
            }
            else {
                reject(new Error('Original datafeed does not support resolveSymbol'));
            }
        });
    }
    /**
     * When coarsening step resolution, merge API bars with buckets aggregated from finer
     * in-memory step bars (covers gaps when the resume anchor is ahead of loaded API data).
     */
    _mergeCoarserStepBarsFromFinerMemory(finerBars, currentIndex, coarserSeconds, resumeMs, apiBars) {
        if (!finerBars.length) {
            return apiBars;
        }
        let endIndex = currentIndex;
        for (let i = 0; i < finerBars.length; i += 1) {
            if (finerBars[i].time < resumeMs) {
                endIndex = i;
            }
        }
        const fromMemory = aggregateStepBarsToChartBars(finerBars, endIndex, coarserSeconds).filter((bar) => bar.time >= resumeMs);
        const byTime = new Map();
        for (const bar of [...fromMemory, ...apiBars]) {
            byTime.set(bar.time, bar);
        }
        return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    }
    /** Fill missing coarser step buckets between `resumeMs` and the first API bar from finer step bars. */
    _fillStepBarGapsFromFinerMemory(finerBars, targetStepSeconds, resumeMs, bars) {
        if (!bars.length || bars[0].time <= resumeMs || !finerBars.length) {
            return bars;
        }
        const gapEnd = bars[0].time;
        const inGap = finerBars.filter((bar) => bar.time >= resumeMs && bar.time < gapEnd);
        if (!inGap.length) {
            return bars;
        }
        const gapBuckets = aggregateStepBarsToChartBars(inGap, inGap.length - 1, targetStepSeconds).filter((bar) => bar.time >= resumeMs && bar.time < gapEnd);
        const byTime = new Map();
        for (const bar of [...gapBuckets, ...bars]) {
            byTime.set(bar.time, bar);
        }
        return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    }
    /**
     * Load forward step bars for an in-progress resolution change (ascending from resumeMs).
     */
    async _loadStepBarsForResolutionChange(symbolInfo, stepResolution, resumeMs) {
        const resumeSec = Math.floor(resumeMs / 1000);
        const fromSec = resumeSec;
        const toSec = Math.floor(Date.now() / 1000);
        const periodParams = {
            from: fromSec,
            to: toSec,
            countBack: 0,
            firstDataRequest: true,
            order: 'asc',
        };
        console.log('[ReplayDatafeed] loadStepBarsForResolutionChange', symbolInfo.ticker || symbolInfo.name, stepResolution, periodParams);
        const bars = await new Promise((resolve, reject) => {
            if ('getBars' in this._originalDatafeed && this._originalDatafeed.getBars) {
                this._originalDatafeed.getBars(symbolInfo, stepResolution, periodParams, (loaded) => {
                    resolve(loaded);
                }, (error) => {
                    reject(new Error(error));
                });
            }
            else {
                reject(new Error('Original datafeed does not support getBars'));
            }
        });
        const normalized = this._normalizeBarsToMs(bars);
        return [...normalized].sort((a, b) => a.time - b.time);
    }
    /**
     * Load real step-resolution bars centered on anchorMs.
     * Uses a bounded window (fits API limit) and desc order so the newest bars include the anchor.
     */
    async _loadStepBarsAroundAnchor(symbolInfo, stepResolution, anchorMs) {
        const secondsPerBar = this._estimateSecondsPerBar(stepResolution);
        const maxApiBars = 5000;
        const windowBars = maxApiBars - 20;
        const preRollBars = Math.floor(windowBars * 0.65);
        const forwardBars = windowBars - preRollBars;
        const maxForwardBars = 500;
        const anchorSec = Math.floor(anchorMs / 1000);
        const nowSec = Math.floor(Date.now() / 1000);
        const replaySec = Math.floor(this._replayController.getCurrentTime() / 1000);
        const forwardWindowSec = Math.min(forwardBars * secondsPerBar, maxForwardBars * secondsPerBar);
        const fromSec = Math.max(0, anchorSec - preRollBars * secondsPerBar);
        const toSec = Math.min(nowSec, anchorSec + forwardWindowSec, Math.max(anchorSec, replaySec) + forwardWindowSec);
        const countBack = Math.min(maxApiBars, Math.ceil((toSec - fromSec) / secondsPerBar) + 1);
        const periodParams = {
            from: fromSec,
            to: toSec,
            countBack,
            firstDataRequest: true,
            order: 'desc',
        };
        console.log('[ReplayDatafeed] loadStepBarsAroundAnchor', symbolInfo.ticker || symbolInfo.name, stepResolution, periodParams);
        const bars = await new Promise((resolve, reject) => {
            if ('getBars' in this._originalDatafeed && this._originalDatafeed.getBars) {
                this._originalDatafeed.getBars(symbolInfo, stepResolution, periodParams, (loaded) => {
                    resolve(loaded);
                }, (error) => {
                    reject(new Error(error));
                });
            }
            else {
                reject(new Error('Original datafeed does not support getBars'));
            }
        });
        const normalized = this._normalizeBarsToMs(bars);
        return [...normalized].sort((a, b) => a.time - b.time);
    }
    async _loadHistoricalBars(symbolInfo, resolution, startTime) {
        if (startTime !== undefined) {
            return this._loadStepBarsAroundAnchor(symbolInfo, resolution, startTime);
        }
        return new Promise((resolve, reject) => {
            const now = Math.floor(Date.now() / 1000);
            const defaultHistoryDays = 120;
            const defaultHistorySeconds = defaultHistoryDays * 24 * 60 * 60;
            const secondsPerBar = this._estimateSecondsPerBar(resolution);
            const from = now - defaultHistorySeconds;
            const to = now;
            const rangeBars = Math.max(1, Math.ceil((to - from) / secondsPerBar));
            const countBack = Math.min(5000, rangeBars);
            const periodParams = {
                from,
                to,
                countBack,
                firstDataRequest: true,
                order: 'desc',
            };
            console.log('[ReplayDatafeed] loadHistoricalBars', symbolInfo.ticker || symbolInfo.name, resolution, periodParams);
            if ('getBars' in this._originalDatafeed && this._originalDatafeed.getBars) {
                this._originalDatafeed.getBars(symbolInfo, resolution, periodParams, (bars) => {
                    const normalized = this._normalizeBarsToMs(bars);
                    resolve([...normalized].sort((a, b) => a.time - b.time));
                }, (error) => {
                    reject(new Error(error));
                });
            }
            else {
                reject(new Error('Original datafeed does not support getBars'));
            }
        });
    }
    _estimateSecondsPerBar(resolution) {
        if (resolution === 'D' || resolution === '1D') {
            return 24 * 60 * 60;
        }
        if (resolution === 'W' || resolution === '1W') {
            return 7 * 24 * 60 * 60;
        }
        if (resolution === 'M' || resolution === '1M') {
            return 30 * 24 * 60 * 60;
        }
        const minutes = Number.parseInt(resolution, 10);
        if (Number.isFinite(minutes) && minutes > 0) {
            return minutes * 60;
        }
        return 60;
    }
    _normalizeBarsToMs(bars) {
        if (!bars.length) {
            return bars;
        }
        let maxTime = 0;
        for (const bar of bars) {
            if (bar.time > maxTime) {
                maxTime = bar.time;
            }
        }
        if (maxTime >= this._msThreshold) {
            return bars;
        }
        return bars.map((bar) => ({
            ...bar,
            time: bar.time * 1000,
        }));
    }
    _shouldPushFormingBarUpdate() {
        const chartResolution = this._chartResolution;
        const stepResolution = this._stepResolution ?? this._replayController.getStepResolution();
        if (!chartResolution || !stepResolution) {
            return false;
        }
        return (resolutionToSeconds(normalizeResolution(stepResolution)) <
            resolutionToSeconds(normalizeResolution(chartResolution)));
    }
    _pushBarToSubscribers() {
        for (const subscription of this._barSubscriptions.values()) {
            try {
                const bars = this._replayController.getVisibleBarsForResolution(subscription.resolution);
                const bar = bars[bars.length - 1];
                if (bar) {
                    subscription.callback(bar);
                }
            }
            catch (e) {
                console.error('ReplayDatafeedWrapper: Error pushing bar to subscriber', e);
            }
        }
    }
}
