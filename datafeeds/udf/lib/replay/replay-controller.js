import { aggregateStepBarsToChartBars, getNextChartBucketStart, mergeFrozenChartBarsWithTail, normalizeResolution, resolutionToSeconds, } from './replay-bar-aggregate';
/**
 * ReplayController manages the replay state and time progression logic.
 * Step bars advance at `stepResolution`; chart-visible bars are aggregated to `chartResolution`.
 */
export class ReplayController {
    constructor() {
        this._state = 'idle';
        this._stepIndex = 0;
        this._stepBars = [];
        this._chartResolution = '15';
        this._stepResolution = '15';
        this._chartResolutionSeconds = resolutionToSeconds('15');
        this._lastNotifiedChartBarTime = null;
        this._frozenChartBars = null;
        /** Chart-resolution bars finalized before the active step window (survives step-resolution switches). */
        this._committedChartBars = [];
        this._stepResolutionLoading = false;
        this._stepResolutionChangeAnchorMs = null;
        this._speed = 1;
        this._intervalId = null;
        this._baseIntervalMs = 1000;
        this._tickCallbacks = [];
        this._stateCallbacks = [];
        this._timeCallbacks = [];
        this._replayEndCallbacks = [];
        this._endAdvanceHandler = null;
        this._endAdvanceInFlight = false;
    }
    start(bars, startIndex, chartResolution, stepResolution) {
        if (bars.length === 0) {
            console.warn('ReplayController: Cannot start replay with empty bars');
            return;
        }
        this._chartResolution = chartResolution;
        this._stepResolution = stepResolution ?? chartResolution;
        this._chartResolutionSeconds = resolutionToSeconds(normalizeResolution(this._chartResolution));
        this._stepBars = [...bars];
        this._stepIndex = Math.max(0, Math.min(startIndex, bars.length - 1));
        this._lastNotifiedChartBarTime = null;
        this._frozenChartBars = null;
        this._committedChartBars = [];
        this._stepResolutionLoading = false;
        this._stepResolutionChangeAnchorMs = null;
        this._state = 'paused';
        this._notifyStateChange();
        this._notifyTimeChange();
    }
    setStepResolution(resolution) {
        if (this._state !== 'idle') {
            return;
        }
        this._stepResolution = resolution;
    }
    isStepResolutionLoading() {
        return this._stepResolutionLoading;
    }
    /** Snapshot visible chart bars; resume at `resumeMs` once the switch completes. */
    beginStepResolutionChange(resumeMs) {
        this._frozenChartBars = [...this._getAggregatedChartBars()];
        this._stepResolutionLoading = true;
        this._stepResolutionChangeAnchorMs = resumeMs;
        return resumeMs;
    }
    clearStepResolutionLoading() {
        this._stepResolutionLoading = false;
        this._stepResolutionChangeAnchorMs = null;
    }
    completeFinerStepResolutionChange(newStepBars, newStepResolution) {
        const anchorMs = this._stepResolutionChangeAnchorMs ?? this.getCurrentTime();
        this._applyLoadedStepBars(newStepBars, newStepResolution, anchorMs);
    }
    /** Replace step bars from a full historical load (used when coarsening step resolution). */
    applyStepResolutionFromBars(newStepBars, newStepResolution, anchorMs) {
        this._applyLoadedStepBars(newStepBars, newStepResolution, anchorMs);
    }
    applyCoarserStepResolution(newStepResolution) {
        const newSeconds = resolutionToSeconds(normalizeResolution(newStepResolution));
        const resumeMs = getNextChartBucketStart(this.getCurrentTime(), this._chartResolutionSeconds);
        let endIndex = 0;
        for (let i = 0; i < this._stepBars.length; i += 1) {
            if (this._stepBars[i].time < resumeMs) {
                endIndex = i;
            }
        }
        const aggregated = aggregateStepBarsToChartBars(this._stepBars, endIndex, newSeconds);
        const forwardBars = aggregated.filter((bar) => bar.time >= resumeMs);
        this._applyLoadedStepBars(forwardBars.length ? forwardBars : aggregated, newStepResolution, resumeMs);
    }
    failStepResolutionChange() {
        this._stepResolutionLoading = false;
        this._frozenChartBars = null;
        this._stepResolutionChangeAnchorMs = null;
    }
    getStepResolution() {
        return this._stepResolution;
    }
    getChartResolution() {
        return this._chartResolution;
    }
    getVisibleBars() {
        return this._getAggregatedChartBars();
    }
    /**
     * Build visible OHLC bars for an individual chart in a multi-chart layout.
     * The replay controller stores a shared low-level step stream, while each chart can
     * request a different resolution such as 15m, 1h, or 1D.
     */
    getVisibleBarsForResolution(resolution) {
        return aggregateStepBarsToChartBars(this._stepBars, this._stepIndex, resolutionToSeconds(normalizeResolution(resolution)));
    }
    prependBars(bars) {
        this._mergeStepBars(bars, 'prepend');
    }
    appendBars(bars) {
        this._mergeStepBars(bars, 'append');
    }
    _mergeStepBars(bars, direction) {
        if (!bars.length) {
            return;
        }
        const currentTime = this.getCurrentTime();
        const existingTimes = new Set(this._stepBars.map((bar) => bar.time));
        const uniqueBars = bars.filter((bar) => !existingTimes.has(bar.time));
        if (!uniqueBars.length) {
            return;
        }
        const merged = direction === 'prepend'
            ? [...uniqueBars, ...this._stepBars]
            : [...this._stepBars, ...uniqueBars];
        this._stepBars = merged.sort((a, b) => a.time - b.time);
        this._syncStepIndexToCurrentTime(currentTime);
    }
    _syncStepIndexToCurrentTime(currentTime) {
        if (!currentTime) {
            this._stepIndex = Math.max(0, Math.min(this._stepIndex, this._stepBars.length - 1));
            return;
        }
        let left = 0;
        let right = this._stepBars.length - 1;
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const time = this._stepBars[mid].time;
            if (time === currentTime) {
                this._stepIndex = mid;
                return;
            }
            if (time < currentTime) {
                left = mid + 1;
            }
            else {
                right = mid - 1;
            }
        }
        this._stepIndex = Math.max(0, Math.min(this._stepIndex, this._stepBars.length - 1));
    }
    getCurrentBar() {
        const chartBars = this._getAggregatedChartBars();
        if (!chartBars.length) {
            return null;
        }
        return chartBars[chartBars.length - 1];
    }
    getCurrentTime() {
        const stepBar = this._getCurrentStepBar();
        return stepBar ? stepBar.time : 0;
    }
    getCurrentBarIndex() {
        return this._stepIndex;
    }
    getTotalBars() {
        return this._stepBars.length;
    }
    getState() {
        return this._state;
    }
    isActive() {
        return this._state !== 'idle';
    }
    isPlaying() {
        return this._state === 'playing';
    }
    isAtEnd() {
        return this._stepBars.length > 0 && this._stepIndex >= this._stepBars.length - 1;
    }
    setEndAdvanceHandler(handler) {
        this._endAdvanceHandler = handler;
    }
    play() {
        if (this._state === 'idle') {
            console.warn('ReplayController: Cannot play before starting replay');
            return;
        }
        if (this._stepResolutionLoading) {
            return;
        }
        if (this._state === 'playing') {
            return;
        }
        if (this.isAtEnd()) {
            this._handleAtBufferEnd('play');
            return;
        }
        this._state = 'playing';
        this._notifyStateChange();
        this._startInterval();
    }
    pause() {
        if (this._state !== 'playing') {
            return;
        }
        this._state = 'paused';
        this._stopInterval();
        this._notifyStateChange();
    }
    togglePlayPause() {
        if (this._state === 'playing') {
            this.pause();
        }
        else if (this._state === 'paused') {
            this.play();
        }
    }
    stepForward() {
        if (this._state === 'idle' || this._stepResolutionLoading) {
            return;
        }
        if (this._state === 'playing') {
            this.pause();
        }
        if (this.isAtEnd()) {
            this._handleAtBufferEnd('step');
            return;
        }
        this._advanceOneStep();
    }
    stepBackward() {
        if (this._state === 'idle') {
            return;
        }
        if (this._state === 'playing') {
            this.pause();
        }
        if (this._stepIndex > 0) {
            this._stepIndex -= 1;
            this._notifyTimeChange();
            const bar = this.getCurrentBar();
            if (bar) {
                this._lastNotifiedChartBarTime = bar.time;
                this._notifyTick(bar, false);
            }
        }
    }
    jumpToIndex(index) {
        if (this._state === 'idle') {
            return;
        }
        const wasPlaying = this._state === 'playing';
        if (wasPlaying) {
            this.pause();
        }
        this._stepIndex = Math.max(0, Math.min(index, this._stepBars.length - 1));
        this._notifyTimeChange();
        const bar = this.getCurrentBar();
        if (bar) {
            this._lastNotifiedChartBarTime = bar.time;
            this._notifyTick(bar, false);
        }
        if (wasPlaying) {
            this.play();
        }
    }
    jumpToTime(timestamp) {
        if (this._state === 'idle') {
            return;
        }
        let targetIndex = 0;
        for (let i = 0; i < this._stepBars.length; i++) {
            if (this._stepBars[i].time <= timestamp) {
                targetIndex = i;
            }
            else {
                break;
            }
        }
        this.jumpToIndex(targetIndex);
    }
    setSpeed(speed) {
        const validSpeeds = [0.5, 1, 2, 5, 10];
        if (!validSpeeds.includes(speed)) {
            console.warn(`ReplayController: Invalid speed ${speed}, using 1x`);
            speed = 1;
        }
        this._speed = speed;
        if (this._state === 'playing') {
            this._stopInterval();
            this._startInterval();
        }
    }
    getSpeed() {
        return this._speed;
    }
    exit() {
        this._stopInterval();
        this._state = 'idle';
        this._stepBars = [];
        this._stepIndex = 0;
        this._lastNotifiedChartBarTime = null;
        this._frozenChartBars = null;
        this._committedChartBars = [];
        this._stepResolutionLoading = false;
        this._stepResolutionChangeAnchorMs = null;
        this._notifyStateChange();
    }
    onTick(callback) {
        this._tickCallbacks.push(callback);
        return () => {
            const index = this._tickCallbacks.indexOf(callback);
            if (index !== -1) {
                this._tickCallbacks.splice(index, 1);
            }
        };
    }
    onStateChange(callback) {
        this._stateCallbacks.push(callback);
        return () => {
            const index = this._stateCallbacks.indexOf(callback);
            if (index !== -1) {
                this._stateCallbacks.splice(index, 1);
            }
        };
    }
    onTimeChange(callback) {
        this._timeCallbacks.push(callback);
        return () => {
            const index = this._timeCallbacks.indexOf(callback);
            if (index !== -1) {
                this._timeCallbacks.splice(index, 1);
            }
        };
    }
    onReplayEnd(callback) {
        this._replayEndCallbacks.push(callback);
        return () => {
            const index = this._replayEndCallbacks.indexOf(callback);
            if (index !== -1) {
                this._replayEndCallbacks.splice(index, 1);
            }
        };
    }
    getAllBars() {
        return this._stepBars;
    }
    _getCurrentStepBar() {
        if (this._stepIndex >= 0 && this._stepIndex < this._stepBars.length) {
            return this._stepBars[this._stepIndex];
        }
        return null;
    }
    _getTailAggregatedChartBars() {
        return aggregateStepBarsToChartBars(this._stepBars, this._stepIndex, this._chartResolutionSeconds);
    }
    _getAggregatedChartBars() {
        const tail = this._getTailAggregatedChartBars();
        if (this._frozenChartBars?.length) {
            return mergeFrozenChartBarsWithTail(this._frozenChartBars, tail);
        }
        if (this._committedChartBars.length) {
            return mergeFrozenChartBarsWithTail(this._committedChartBars, tail);
        }
        return tail;
    }
    _commitFrozenChartPrefix(tailStartMs) {
        if (!this._frozenChartBars?.length) {
            return;
        }
        this._committedChartBars = this._frozenChartBars.filter((bar) => bar.time < tailStartMs);
    }
    _applyLoadedStepBars(newStepBars, newStepResolution, resumeMs) {
        const sorted = [...newStepBars].sort((a, b) => a.time - b.time);
        this._stepBars = sorted.filter((bar) => bar.time >= resumeMs);
        this._stepResolution = newStepResolution;
        this._stepIndex = this._findStepIndexAtOrAfter(resumeMs);
        if (this._stepBars.length) {
            this._stepIndex = Math.min(this._stepIndex, this._stepBars.length - 1);
        }
        const tailStartMs = this._stepBars.length ? this._stepBars[0].time : resumeMs;
        this._commitFrozenChartPrefix(tailStartMs);
        this._frozenChartBars = null;
        this._stepResolutionLoading = false;
        this._stepResolutionChangeAnchorMs = null;
        const bar = this.getCurrentBar();
        if (bar) {
            this._lastNotifiedChartBarTime = bar.time;
            this._notifyTick(bar, false);
            this._notifyTimeChange();
        }
    }
    _findStepIndexAtOrAfter(timestamp) {
        if (!this._stepBars.length) {
            return 0;
        }
        for (let i = 0; i < this._stepBars.length; i += 1) {
            if (this._stepBars[i].time >= timestamp) {
                return i;
            }
        }
        return this._stepBars.length - 1;
    }
    _startInterval() {
        this._stopInterval();
        const intervalMs = this._baseIntervalMs / this._speed;
        this._intervalId = setInterval(() => {
            this._advanceOneStep();
        }, intervalMs);
    }
    _stopInterval() {
        if (this._intervalId !== null) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }
    }
    _advanceOneStep() {
        if (this._stepResolutionLoading) {
            return;
        }
        if (this._stepIndex >= this._stepBars.length - 1) {
            this._handleAtBufferEnd('advance');
            return;
        }
        this._stepIndex += 1;
        const bar = this.getCurrentBar();
        if (bar) {
            const isNewBar = bar.time !== this._lastNotifiedChartBarTime;
            this._lastNotifiedChartBarTime = bar.time;
            this._notifyTick(bar, isNewBar);
            this._notifyTimeChange();
        }
    }
    _notifyTick(bar, isNewBar) {
        for (const callback of this._tickCallbacks) {
            try {
                callback(bar, isNewBar);
            }
            catch (e) {
                console.error('ReplayController: Error in tick callback', e);
            }
        }
    }
    _notifyStateChange() {
        for (const callback of this._stateCallbacks) {
            try {
                callback(this._state);
            }
            catch (e) {
                console.error('ReplayController: Error in state callback', e);
            }
        }
    }
    _notifyTimeChange() {
        const time = this.getCurrentTime();
        for (const callback of this._timeCallbacks) {
            try {
                callback(time);
            }
            catch (e) {
                console.error('ReplayController: Error in time callback', e);
            }
        }
    }
    _handleAtBufferEnd(context) {
        if (this._endAdvanceHandler && !this._endAdvanceInFlight) {
            const resumePlaying = context === 'advance' && this._state === 'playing';
            if (resumePlaying) {
                this.pause();
            }
            this._endAdvanceInFlight = true;
            void this._endAdvanceHandler()
                .then((extended) => {
                this._endAdvanceInFlight = false;
                if (extended) {
                    if (context === 'play' || resumePlaying) {
                        this.play();
                        return;
                    }
                    if (context === 'step') {
                        this._advanceOneStep();
                    }
                    return;
                }
                this._notifyReplayEnd();
            })
                .catch((error) => {
                this._endAdvanceInFlight = false;
                console.error('ReplayController: end advance handler failed', error);
                this._notifyReplayEnd();
            });
            return;
        }
        if (context === 'advance' && this._state === 'playing') {
            this.pause();
        }
        this._notifyReplayEnd();
    }
    _notifyReplayEnd() {
        for (const callback of this._replayEndCallbacks) {
            try {
                callback();
            }
            catch (e) {
                console.error('ReplayController: Error in replay end callback', e);
            }
        }
    }
}
