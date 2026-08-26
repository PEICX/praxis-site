import { Bar } from '../../../../charting_library/datafeed-api';
import { ReplayController } from './replay-controller';

export type PositionSide = 'long' | 'short';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus = 'pending' | 'filled' | 'cancelled';

export interface Position {
	id: string;
	side: PositionSide;
	entryPrice: number;
	entryTime: number;
	quantity: number;
	stopLoss?: number;
	takeProfit?: number;
}

export interface PendingOrder {
	id: string;
	side: PositionSide;
	type: OrderType;
	price: number;
	quantity: number;
	stopLoss?: number;
	takeProfit?: number;
	createdAt: number;
	status: OrderStatus;
}

export interface Trade {
	id: string;
	side: PositionSide;
	entryPrice: number;
	exitPrice: number;
	quantity: number;
	pnl: number;
	pnlPercent: number;
	entryTime: number;
	exitTime: number;
}

export interface TradingStats {
	totalTrades: number;
	winningTrades: number;
	losingTrades: number;
	winRate: number;
	totalPnl: number;
	averagePnl: number;
	largestWin: number;
	largestLoss: number;
}

export interface PositionChangeCallback {
	(position: Position | null): void;
}

export interface TradeCallback {
	(trade: Trade): void;
}

export interface PnlCallback {
	(unrealizedPnl: number, currentPrice: number): void;
}

/**
 * PaperTradingEngine simulates trading during replay.
 * It supports opening/closing positions and tracking P&L.
 */
export class PaperTradingEngine {
	private readonly _replayController: ReplayController;
	
	private _position: Position | null = null;
	private _pendingOrders: PendingOrder[] = [];
	private _trades: Trade[] = [];
	private _currentPrice: number = 0;
	private _idCounter: number = 0;

	private _positionCallbacks: PositionChangeCallback[] = [];
	private _tradeCallbacks: TradeCallback[] = [];
	private _pnlCallbacks: PnlCallback[] = [];

	private _unsubscribeTick: (() => void) | null = null;

	constructor(replayController: ReplayController) {
		this._replayController = replayController;
	}

	/**
	 * Initialize the trading engine and subscribe to price updates.
	 */
	public initialize(): void {
		this._unsubscribeTick = this._replayController.onTick((bar, isNewBar) => {
			this._onPriceUpdate(bar);
		});

		// Set initial price from current bar
		const currentBar = this._replayController.getCurrentBar();
		if (currentBar) {
			this._currentPrice = currentBar.close;
		}
	}

	/**
	 * Cleanup the trading engine.
	 */
	public destroy(): void {
		if (this._unsubscribeTick) {
			this._unsubscribeTick();
			this._unsubscribeTick = null;
		}
	}

	/**
	 * Reset all trading state.
	 */
	public reset(): void {
		if (this._position) {
			this._closePositionInternal(this._currentPrice, this._replayController.getCurrentTime());
		}
		this._pendingOrders = [];
		this._trades = [];
		this._position = null;
		this._notifyPositionChange();
	}

	/**
	 * Get the current position.
	 */
	public getPosition(): Position | null {
		return this._position;
	}

	/**
	 * Get all completed trades.
	 */
	public getTrades(): Trade[] {
		return [...this._trades];
	}

	/**
	 * Get pending orders.
	 */
	public getPendingOrders(): PendingOrder[] {
		return [...this._pendingOrders];
	}

	/**
	 * Get the current price.
	 */
	public getCurrentPrice(): number {
		return this._currentPrice;
	}

	/**
	 * Calculate unrealized P&L for the current position.
	 */
	public getUnrealizedPnl(): number {
		if (!this._position) {
			return 0;
		}

		const priceDiff = this._currentPrice - this._position.entryPrice;
		const direction = this._position.side === 'long' ? 1 : -1;
		return priceDiff * direction * this._position.quantity;
	}

	/**
	 * Calculate unrealized P&L percentage.
	 */
	public getUnrealizedPnlPercent(): number {
		if (!this._position) {
			return 0;
		}

		const priceDiff = this._currentPrice - this._position.entryPrice;
		const direction = this._position.side === 'long' ? 1 : -1;
		return (priceDiff * direction / this._position.entryPrice) * 100;
	}

	/**
	 * Get total realized P&L from all closed trades.
	 */
	public getRealizedPnl(): number {
		return this._trades.reduce((sum, trade) => sum + trade.pnl, 0);
	}

	/**
	 * Get trading statistics.
	 */
	public getStats(): TradingStats {
		const winningTrades = this._trades.filter(t => t.pnl > 0);
		const losingTrades = this._trades.filter(t => t.pnl < 0);

		return {
			totalTrades: this._trades.length,
			winningTrades: winningTrades.length,
			losingTrades: losingTrades.length,
			winRate: this._trades.length > 0 ? (winningTrades.length / this._trades.length) * 100 : 0,
			totalPnl: this.getRealizedPnl(),
			averagePnl: this._trades.length > 0 ? this.getRealizedPnl() / this._trades.length : 0,
			largestWin: winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl)) : 0,
			largestLoss: losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl)) : 0,
		};
	}

	/**
	 * Open a long position at market price.
	 */
	public openLong(quantity: number = 1, stopLoss?: number, takeProfit?: number): Position | null {
		return this._openPosition('long', quantity, stopLoss, takeProfit);
	}

	/**
	 * Open a short position at market price.
	 */
	public openShort(quantity: number = 1, stopLoss?: number, takeProfit?: number): Position | null {
		return this._openPosition('short', quantity, stopLoss, takeProfit);
	}

	/**
	 * Close the current position at market price.
	 */
	public closePosition(): Trade | null {
		if (!this._position) {
			return null;
		}

		return this._closePositionInternal(this._currentPrice, this._replayController.getCurrentTime());
	}

	/**
	 * Set stop loss for the current position.
	 */
	public setStopLoss(price: number): void {
		if (this._position) {
			this._position.stopLoss = price;
			this._notifyPositionChange();
		}
	}

	/**
	 * Set take profit for the current position.
	 */
	public setTakeProfit(price: number): void {
		if (this._position) {
			this._position.takeProfit = price;
			this._notifyPositionChange();
		}
	}

	/**
	 * Remove stop loss from the current position.
	 */
	public removeStopLoss(): void {
		if (this._position) {
			this._position.stopLoss = undefined;
			this._notifyPositionChange();
		}
	}

	/**
	 * Remove take profit from the current position.
	 */
	public removeTakeProfit(): void {
		if (this._position) {
			this._position.takeProfit = undefined;
			this._notifyPositionChange();
		}
	}

	/**
	 * Subscribe to position changes.
	 */
	public onPositionChange(callback: PositionChangeCallback): () => void {
		this._positionCallbacks.push(callback);
		return () => {
			const index = this._positionCallbacks.indexOf(callback);
			if (index !== -1) {
				this._positionCallbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to trade completions.
	 */
	public onTrade(callback: TradeCallback): () => void {
		this._tradeCallbacks.push(callback);
		return () => {
			const index = this._tradeCallbacks.indexOf(callback);
			if (index !== -1) {
				this._tradeCallbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to P&L updates.
	 */
	public onPnlUpdate(callback: PnlCallback): () => void {
		this._pnlCallbacks.push(callback);
		return () => {
			const index = this._pnlCallbacks.indexOf(callback);
			if (index !== -1) {
				this._pnlCallbacks.splice(index, 1);
			}
		};
	}

	// ==================== Private Methods ====================

	private _generateId(): string {
		return `trade_${++this._idCounter}_${Date.now()}`;
	}

	private _openPosition(
		side: PositionSide,
		quantity: number,
		stopLoss?: number,
		takeProfit?: number
	): Position | null {
		// Close existing position first if any
		if (this._position) {
			this.closePosition();
		}

		if (this._currentPrice <= 0) {
			console.warn('PaperTradingEngine: Cannot open position, no valid price');
			return null;
		}

		this._position = {
			id: this._generateId(),
			side,
			entryPrice: this._currentPrice,
			entryTime: this._replayController.getCurrentTime(),
			quantity,
			stopLoss,
			takeProfit,
		};

		this._notifyPositionChange();
		return this._position;
	}

	private _closePositionInternal(exitPrice: number, exitTime: number): Trade | null {
		if (!this._position) {
			return null;
		}

		const priceDiff = exitPrice - this._position.entryPrice;
		const direction = this._position.side === 'long' ? 1 : -1;
		const pnl = priceDiff * direction * this._position.quantity;
		const pnlPercent = (priceDiff * direction / this._position.entryPrice) * 100;

		const trade: Trade = {
			id: this._position.id,
			side: this._position.side,
			entryPrice: this._position.entryPrice,
			exitPrice,
			quantity: this._position.quantity,
			pnl,
			pnlPercent,
			entryTime: this._position.entryTime,
			exitTime,
		};

		this._trades.push(trade);
		this._position = null;

		this._notifyTrade(trade);
		this._notifyPositionChange();

		return trade;
	}

	private _onPriceUpdate(bar: Bar): void {
		this._currentPrice = bar.close;

		// Check stop loss and take profit
		if (this._position) {
			const high = bar.high;
			const low = bar.low;

			// Check stop loss
			if (this._position.stopLoss !== undefined) {
				if (this._position.side === 'long' && low <= this._position.stopLoss) {
					this._closePositionInternal(this._position.stopLoss, bar.time);
					return;
				}
				if (this._position.side === 'short' && high >= this._position.stopLoss) {
					this._closePositionInternal(this._position.stopLoss, bar.time);
					return;
				}
			}

			// Check take profit
			if (this._position.takeProfit !== undefined) {
				if (this._position.side === 'long' && high >= this._position.takeProfit) {
					this._closePositionInternal(this._position.takeProfit, bar.time);
					return;
				}
				if (this._position.side === 'short' && low <= this._position.takeProfit) {
					this._closePositionInternal(this._position.takeProfit, bar.time);
					return;
				}
			}

			// Notify P&L update
			this._notifyPnlUpdate();
		}
	}

	private _notifyPositionChange(): void {
		for (const callback of this._positionCallbacks) {
			try {
				callback(this._position);
			} catch (e) {
				console.error('PaperTradingEngine: Error in position callback', e);
			}
		}
	}

	private _notifyTrade(trade: Trade): void {
		for (const callback of this._tradeCallbacks) {
			try {
				callback(trade);
			} catch (e) {
				console.error('PaperTradingEngine: Error in trade callback', e);
			}
		}
	}

	private _notifyPnlUpdate(): void {
		const unrealizedPnl = this.getUnrealizedPnl();
		for (const callback of this._pnlCallbacks) {
			try {
				callback(unrealizedPnl, this._currentPrice);
			} catch (e) {
				console.error('PaperTradingEngine: Error in P&L callback', e);
			}
		}
	}
}


