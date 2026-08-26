import { Bar, ResolutionString } from '../../../../charting_library/datafeed-api';
import {
	aggregateStepBarsToChartBars,
	getNextChartBucketStart,
	mergeFrozenChartBarsWithTail,
	normalizeResolution,
	resolutionToSeconds,
} from './replay-bar-aggregate';

export type ReplayState = 'idle' | 'playing' | 'paused';

export interface ReplayTickCallback {
	(bar: Bar, isNewBar: boolean): void;
}

export interface ReplayStateCallback {
	(state: ReplayState): void;
}

export interface ReplayTimeCallback {
	(time: number): void;
}

export interface ReplayEndCallback {
	(): void;
}

export type ReplayEndAdvanceHandler = () => Promise<boolean>;

type ReplayEndAdvanceContext = 'play' | 'step' | 'advance';

/**
 * ReplayController manages the replay state and time progression logic.
 * Step bars advance at `stepResolution`; chart-visible bars are aggregated to `chartResolution`.
 */
export class ReplayController {
	private _state: ReplayState = 'idle';
	private _stepIndex: number = 0;
	private _stepBars: Bar[] = [];
	private _chartResolution: ResolutionString = '15' as ResolutionString;
	private _stepResolution: ResolutionString = '15' as ResolutionString;
	private _chartResolutionSeconds: number = resolutionToSeconds('15');
	private _lastNotifiedChartBarTime: number | null = null;
	private _frozenChartBars: Bar[] | null = null;
	/** Chart-resolution bars finalized before the active step window (survives step-resolution switches). */
	private _committedChartBars: Bar[] = [];
	private _stepResolutionLoading: boolean = false;
	private _stepResolutionChangeAnchorMs: number | null = null;
	private _speed: number = 1;
	private _intervalId: ReturnType<typeof setInterval> | null = null;
	private _baseIntervalMs: number = 1000;

	private _tickCallbacks: ReplayTickCallback[] = [];
	private _stateCallbacks: ReplayStateCallback[] = [];
	private _timeCallbacks: ReplayTimeCallback[] = [];
	private _replayEndCallbacks: ReplayEndCallback[] = [];
	private _endAdvanceHandler: ReplayEndAdvanceHandler | null = null;
	private _endAdvanceInFlight: boolean = false;

	public start(
		bars: Bar[],
		startIndex: number,
		chartResolution: ResolutionString,
		stepResolution?: ResolutionString,
	): void {
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

	public setStepResolution(resolution: ResolutionString): void {
		if (this._state !== 'idle') {
			return;
		}
		this._stepResolution = resolution;
	}

	public isStepResolutionLoading(): boolean {
		return this._stepResolutionLoading;
	}

	/** Snapshot visible chart bars; resume at `resumeMs` once the switch completes. */
	public beginStepResolutionChange(resumeMs: number): number {
		this._frozenChartBars = [...this._getAggregatedChartBars()];
		this._stepResolutionLoading = true;
		this._stepResolutionChangeAnchorMs = resumeMs;
		return resumeMs;
	}

	public clearStepResolutionLoading(): void {
		this._stepResolutionLoading = false;
		this._stepResolutionChangeAnchorMs = null;
	}

	public completeFinerStepResolutionChange(newStepBars: Bar[], newStepResolution: ResolutionString): void {
		const anchorMs = this._stepResolutionChangeAnchorMs ?? this.getCurrentTime();
		this._applyLoadedStepBars(newStepBars, newStepResolution, anchorMs);
	}

	/** Replace step bars from a full historical load (used when coarsening step resolution). */
	public applyStepResolutionFromBars(
		newStepBars: Bar[],
		newStepResolution: ResolutionString,
		anchorMs: number,
	): void {
		this._applyLoadedStepBars(newStepBars, newStepResolution, anchorMs);
	}

	public applyCoarserStepResolution(newStepResolution: ResolutionString): void {
		const newSeconds = resolutionToSeconds(normalizeResolution(newStepResolution));
		const resumeMs = getNextChartBucketStart(this.getCurrentTime(), this._chartResolutionSeconds);
		let endIndex = 0;
		for (let i = 0; i < this._stepBars.length; i += 1) {
			if (this._stepBars[i].time < resumeMs) {
				endIndex = i;
			}
		}
		const aggregated = aggregateStepBarsToChartBars(
			this._stepBars,
			endIndex,
			newSeconds,
		) as Bar[];
		const forwardBars = aggregated.filter((bar) => bar.time >= resumeMs);
		this._applyLoadedStepBars(
			forwardBars.length ? forwardBars : aggregated,
			newStepResolution,
			resumeMs,
		);
	}

	public failStepResolutionChange(): void {
		this._stepResolutionLoading = false;
		this._frozenChartBars = null;
		this._stepResolutionChangeAnchorMs = null;
	}

	public getStepResolution(): ResolutionString {
		return this._stepResolution;
	}

	public getChartResolution(): ResolutionString {
		return this._chartResolution;
	}

	public getVisibleBars(): Bar[] {
		return this._getAggregatedChartBars();
	}

	/**
	 * Build visible OHLC bars for an individual chart in a multi-chart layout.
	 * The replay controller stores a shared low-level step stream, while each chart can
	 * request a different resolution such as 15m, 1h, or 1D.
	 */
	public getVisibleBarsForResolution(resolution: ResolutionString): Bar[] {
		return aggregateStepBarsToChartBars(
			this._stepBars,
			this._stepIndex,
			resolutionToSeconds(normalizeResolution(resolution)),
		) as Bar[];
	}

	public prependBars(bars: Bar[]): void {
		this._mergeStepBars(bars, 'prepend');
	}

	public appendBars(bars: Bar[]): void {
		this._mergeStepBars(bars, 'append');
	}

	private _mergeStepBars(bars: Bar[], direction: 'prepend' | 'append'): void {
		if (!bars.length) {
			return;
		}

		const currentTime = this.getCurrentTime();
		const existingTimes = new Set(this._stepBars.map((bar) => bar.time));
		const uniqueBars = bars.filter((bar) => !existingTimes.has(bar.time));
		if (!uniqueBars.length) {
			return;
		}

		const merged =
			direction === 'prepend'
				? [...uniqueBars, ...this._stepBars]
				: [...this._stepBars, ...uniqueBars];
		this._stepBars = merged.sort((a, b) => a.time - b.time);
		this._syncStepIndexToCurrentTime(currentTime);
	}

	private _syncStepIndexToCurrentTime(currentTime: number): void {
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
			} else {
				right = mid - 1;
			}
		}
		this._stepIndex = Math.max(0, Math.min(this._stepIndex, this._stepBars.length - 1));
	}

	public getCurrentBar(): Bar | null {
		const chartBars = this._getAggregatedChartBars();
		if (!chartBars.length) {
			return null;
		}
		return chartBars[chartBars.length - 1];
	}

	public getCurrentTime(): number {
		const stepBar = this._getCurrentStepBar();
		return stepBar ? stepBar.time : 0;
	}

	public getCurrentBarIndex(): number {
		return this._stepIndex;
	}

	public getTotalBars(): number {
		return this._stepBars.length;
	}

	public getState(): ReplayState {
		return this._state;
	}

	public isActive(): boolean {
		return this._state !== 'idle';
	}

	public isPlaying(): boolean {
		return this._state === 'playing';
	}

	public isAtEnd(): boolean {
		return this._stepBars.length > 0 && this._stepIndex >= this._stepBars.length - 1;
	}

	public setEndAdvanceHandler(handler: ReplayEndAdvanceHandler | null): void {
		this._endAdvanceHandler = handler;
	}

	public play(): void {
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

	public pause(): void {
		if (this._state !== 'playing') {
			return;
		}

		this._state = 'paused';
		this._stopInterval();
		this._notifyStateChange();
	}

	public togglePlayPause(): void {
		if (this._state === 'playing') {
			this.pause();
		} else if (this._state === 'paused') {
			this.play();
		}
	}

	public stepForward(): void {
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

	public stepBackward(): void {
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

	public jumpToIndex(index: number): void {
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

	public jumpToTime(timestamp: number): void {
		if (this._state === 'idle') {
			return;
		}

		let targetIndex = 0;
		for (let i = 0; i < this._stepBars.length; i++) {
			if (this._stepBars[i].time <= timestamp) {
				targetIndex = i;
			} else {
				break;
			}
		}

		this.jumpToIndex(targetIndex);
	}

	public setSpeed(speed: number): void {
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

	public getSpeed(): number {
		return this._speed;
	}

	public exit(): void {
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

	public onTick(callback: ReplayTickCallback): () => void {
		this._tickCallbacks.push(callback);
		return () => {
			const index = this._tickCallbacks.indexOf(callback);
			if (index !== -1) {
				this._tickCallbacks.splice(index, 1);
			}
		};
	}

	public onStateChange(callback: ReplayStateCallback): () => void {
		this._stateCallbacks.push(callback);
		return () => {
			const index = this._stateCallbacks.indexOf(callback);
			if (index !== -1) {
				this._stateCallbacks.splice(index, 1);
			}
		};
	}

	public onTimeChange(callback: ReplayTimeCallback): () => void {
		this._timeCallbacks.push(callback);
		return () => {
			const index = this._timeCallbacks.indexOf(callback);
			if (index !== -1) {
				this._timeCallbacks.splice(index, 1);
			}
		};
	}

	public onReplayEnd(callback: ReplayEndCallback): () => void {
		this._replayEndCallbacks.push(callback);
		return () => {
			const index = this._replayEndCallbacks.indexOf(callback);
			if (index !== -1) {
				this._replayEndCallbacks.splice(index, 1);
			}
		};
	}

	public getAllBars(): Bar[] {
		return this._stepBars;
	}

	private _getCurrentStepBar(): Bar | null {
		if (this._stepIndex >= 0 && this._stepIndex < this._stepBars.length) {
			return this._stepBars[this._stepIndex];
		}
		return null;
	}

	private _getTailAggregatedChartBars(): Bar[] {
		return aggregateStepBarsToChartBars(
			this._stepBars,
			this._stepIndex,
			this._chartResolutionSeconds,
		) as Bar[];
	}

	private _getAggregatedChartBars(): Bar[] {
		const tail = this._getTailAggregatedChartBars();
		if (this._frozenChartBars?.length) {
			return mergeFrozenChartBarsWithTail(this._frozenChartBars, tail) as Bar[];
		}
		if (this._committedChartBars.length) {
			return mergeFrozenChartBarsWithTail(this._committedChartBars, tail) as Bar[];
		}
		return tail;
	}

	private _commitFrozenChartPrefix(tailStartMs: number): void {
		if (!this._frozenChartBars?.length) {
			return;
		}
		this._committedChartBars = this._frozenChartBars.filter((bar) => bar.time < tailStartMs);
	}

	private _applyLoadedStepBars(
		newStepBars: Bar[],
		newStepResolution: ResolutionString,
		resumeMs: number,
	): void {
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

	private _findStepIndexAtOrAfter(timestamp: number): number {
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

	private _startInterval(): void {
		this._stopInterval();

		const intervalMs = this._baseIntervalMs / this._speed;

		this._intervalId = setInterval(() => {
			this._advanceOneStep();
		}, intervalMs);
	}

	private _stopInterval(): void {
		if (this._intervalId !== null) {
			clearInterval(this._intervalId);
			this._intervalId = null;
		}
	}

	private _advanceOneStep(): void {
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

	private _notifyTick(bar: Bar, isNewBar: boolean): void {
		for (const callback of this._tickCallbacks) {
			try {
				callback(bar, isNewBar);
			} catch (e) {
				console.error('ReplayController: Error in tick callback', e);
			}
		}
	}

	private _notifyStateChange(): void {
		for (const callback of this._stateCallbacks) {
			try {
				callback(this._state);
			} catch (e) {
				console.error('ReplayController: Error in state callback', e);
			}
		}
	}

	private _notifyTimeChange(): void {
		const time = this.getCurrentTime();
		for (const callback of this._timeCallbacks) {
			try {
				callback(time);
			} catch (e) {
				console.error('ReplayController: Error in time callback', e);
			}
		}
	}

	private _handleAtBufferEnd(context: ReplayEndAdvanceContext): void {
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

	private _notifyReplayEnd(): void {
		for (const callback of this._replayEndCallbacks) {
			try {
				callback();
			} catch (e) {
				console.error('ReplayController: Error in replay end callback', e);
			}
		}
	}
}
