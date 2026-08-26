/**
 * PaperTradingEngine simulates trading during replay.
 * It supports opening/closing positions and tracking P&L.
 */
export class PaperTradingEngine {
    constructor(replayController) {
        this._position = null;
        this._pendingOrders = [];
        this._trades = [];
        this._currentPrice = 0;
        this._idCounter = 0;
        this._positionCallbacks = [];
        this._tradeCallbacks = [];
        this._pnlCallbacks = [];
        this._unsubscribeTick = null;
        this._replayController = replayController;
    }
    /**
     * Initialize the trading engine and subscribe to price updates.
     */
    initialize() {
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
    destroy() {
        if (this._unsubscribeTick) {
            this._unsubscribeTick();
            this._unsubscribeTick = null;
        }
    }
    /**
     * Reset all trading state.
     */
    reset() {
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
    getPosition() {
        return this._position;
    }
    /**
     * Get all completed trades.
     */
    getTrades() {
        return [...this._trades];
    }
    /**
     * Get pending orders.
     */
    getPendingOrders() {
        return [...this._pendingOrders];
    }
    /**
     * Get the current price.
     */
    getCurrentPrice() {
        return this._currentPrice;
    }
    /**
     * Calculate unrealized P&L for the current position.
     */
    getUnrealizedPnl() {
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
    getUnrealizedPnlPercent() {
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
    getRealizedPnl() {
        return this._trades.reduce((sum, trade) => sum + trade.pnl, 0);
    }
    /**
     * Get trading statistics.
     */
    getStats() {
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
    openLong(quantity = 1, stopLoss, takeProfit) {
        return this._openPosition('long', quantity, stopLoss, takeProfit);
    }
    /**
     * Open a short position at market price.
     */
    openShort(quantity = 1, stopLoss, takeProfit) {
        return this._openPosition('short', quantity, stopLoss, takeProfit);
    }
    /**
     * Close the current position at market price.
     */
    closePosition() {
        if (!this._position) {
            return null;
        }
        return this._closePositionInternal(this._currentPrice, this._replayController.getCurrentTime());
    }
    /**
     * Set stop loss for the current position.
     */
    setStopLoss(price) {
        if (this._position) {
            this._position.stopLoss = price;
            this._notifyPositionChange();
        }
    }
    /**
     * Set take profit for the current position.
     */
    setTakeProfit(price) {
        if (this._position) {
            this._position.takeProfit = price;
            this._notifyPositionChange();
        }
    }
    /**
     * Remove stop loss from the current position.
     */
    removeStopLoss() {
        if (this._position) {
            this._position.stopLoss = undefined;
            this._notifyPositionChange();
        }
    }
    /**
     * Remove take profit from the current position.
     */
    removeTakeProfit() {
        if (this._position) {
            this._position.takeProfit = undefined;
            this._notifyPositionChange();
        }
    }
    /**
     * Subscribe to position changes.
     */
    onPositionChange(callback) {
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
    onTrade(callback) {
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
    onPnlUpdate(callback) {
        this._pnlCallbacks.push(callback);
        return () => {
            const index = this._pnlCallbacks.indexOf(callback);
            if (index !== -1) {
                this._pnlCallbacks.splice(index, 1);
            }
        };
    }
    // ==================== Private Methods ====================
    _generateId() {
        return `trade_${++this._idCounter}_${Date.now()}`;
    }
    _openPosition(side, quantity, stopLoss, takeProfit) {
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
    _closePositionInternal(exitPrice, exitTime) {
        if (!this._position) {
            return null;
        }
        const priceDiff = exitPrice - this._position.entryPrice;
        const direction = this._position.side === 'long' ? 1 : -1;
        const pnl = priceDiff * direction * this._position.quantity;
        const pnlPercent = (priceDiff * direction / this._position.entryPrice) * 100;
        const trade = {
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
    _onPriceUpdate(bar) {
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
    _notifyPositionChange() {
        for (const callback of this._positionCallbacks) {
            try {
                callback(this._position);
            }
            catch (e) {
                console.error('PaperTradingEngine: Error in position callback', e);
            }
        }
    }
    _notifyTrade(trade) {
        for (const callback of this._tradeCallbacks) {
            try {
                callback(trade);
            }
            catch (e) {
                console.error('PaperTradingEngine: Error in trade callback', e);
            }
        }
    }
    _notifyPnlUpdate() {
        const unrealizedPnl = this.getUnrealizedPnl();
        for (const callback of this._pnlCallbacks) {
            try {
                callback(unrealizedPnl, this._currentPrice);
            }
            catch (e) {
                console.error('PaperTradingEngine: Error in P&L callback', e);
            }
        }
    }
}
