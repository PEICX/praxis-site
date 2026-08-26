(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.Datafeeds = {}));
})(this, (function (exports) { 'use strict';

    /**
     * If you want to enable logs from datafeed set it to `true`
     */
    function logMessage(message) {
    }
    function getErrorMessage(error) {
        if (error === undefined) {
            return '';
        }
        else if (typeof error === 'string') {
            return error;
        }
        return error.message;
    }

    class HistoryProvider {
        constructor(datafeedUrl, requester, limitedServerResponse) {
            this._datafeedUrl = datafeedUrl;
            this._requester = requester;
            this._limitedServerResponse = limitedServerResponse;
        }
        getBars(symbolInfo, resolution, periodParams) {
            const requestParams = {
                symbol: symbolInfo.ticker || '',
                resolution: resolution,
                from: periodParams.from,
                to: periodParams.to,
            };
            if (periodParams.countBack !== undefined) {
                requestParams.countback = periodParams.countBack;
            }
            if (symbolInfo.currency_code !== undefined) {
                requestParams.currencyCode = symbolInfo.currency_code;
            }
            if (symbolInfo.unit_id !== undefined) {
                requestParams.unitId = symbolInfo.unit_id;
            }
            return new Promise(async (resolve, reject) => {
                try {
                    const initialResponse = await this._requester.sendRequest(this._datafeedUrl, 'history', requestParams);
                    const result = this._processHistoryResponse(initialResponse);
                    if (this._limitedServerResponse) {
                        await this._processTruncatedResponse(result, requestParams);
                    }
                    resolve(result);
                }
                catch (e) {
                    if (e instanceof Error || typeof e === 'string') {
                        const reasonString = getErrorMessage(e);
                        // tslint:disable-next-line:no-console
                        console.warn(`HistoryProvider: getBars() failed, error=${reasonString}`);
                        reject(reasonString);
                    }
                }
            });
        }
        async _processTruncatedResponse(result, requestParams) {
            let lastResultLength = result.bars.length;
            try {
                while (this._limitedServerResponse &&
                    this._limitedServerResponse.maxResponseLength > 0 &&
                    this._limitedServerResponse.maxResponseLength === lastResultLength &&
                    requestParams.from < requestParams.to) {
                    // adjust request parameters for follow-up request
                    if (requestParams.countback) {
                        requestParams.countback = requestParams.countback - lastResultLength;
                    }
                    if (this._limitedServerResponse.expectedOrder === 'earliestFirst') {
                        requestParams.from = Math.round(result.bars[result.bars.length - 1].time / 1000);
                    }
                    else {
                        requestParams.to = Math.round(result.bars[0].time / 1000);
                    }
                    const followupResponse = await this._requester.sendRequest(this._datafeedUrl, 'history', requestParams);
                    const followupResult = this._processHistoryResponse(followupResponse);
                    lastResultLength = followupResult.bars.length;
                    // merge result with results collected so far
                    if (this._limitedServerResponse.expectedOrder === 'earliestFirst') {
                        if (followupResult.bars[0].time === result.bars[result.bars.length - 1].time) {
                            // Datafeed shouldn't include a value exactly matching the `to` timestamp but in case it does
                            // we will remove the duplicate.
                            followupResult.bars.shift();
                        }
                        result.bars.push(...followupResult.bars);
                    }
                    else {
                        if (followupResult.bars[followupResult.bars.length - 1].time === result.bars[0].time) {
                            // Datafeed shouldn't include a value exactly matching the `to` timestamp but in case it does
                            // we will remove the duplicate.
                            followupResult.bars.pop();
                        }
                        result.bars.unshift(...followupResult.bars);
                    }
                }
            }
            catch (e) {
                /**
                 * Error occurred during followup request. We won't reject the original promise
                 * because the initial response was valid so we will return what we've got so far.
                 */
                if (e instanceof Error || typeof e === 'string') {
                    const reasonString = getErrorMessage(e);
                    // tslint:disable-next-line:no-console
                    console.warn(`HistoryProvider: getBars() warning during followup request, error=${reasonString}`);
                }
            }
        }
        _processHistoryResponse(response) {
            if (response.s !== 'ok' && response.s !== 'no_data') {
                throw new Error(response.errmsg);
            }
            const bars = [];
            const meta = {
                noData: false,
            };
            if (response.s === 'no_data') {
                meta.noData = true;
                meta.nextTime = response.nextTime;
            }
            else {
                const volumePresent = response.v !== undefined;
                const ohlPresent = response.o !== undefined;
                for (let i = 0; i < response.t.length; ++i) {
                    const barValue = {
                        time: response.t[i] * 1000,
                        close: parseFloat(response.c[i]),
                        open: parseFloat(response.c[i]),
                        high: parseFloat(response.c[i]),
                        low: parseFloat(response.c[i]),
                    };
                    if (ohlPresent) {
                        barValue.open = parseFloat(response.o[i]);
                        barValue.high = parseFloat(response.h[i]);
                        barValue.low = parseFloat(response.l[i]);
                    }
                    if (volumePresent) {
                        barValue.volume = parseFloat(response.v[i]);
                    }
                    bars.push(barValue);
                }
            }
            return {
                bars: bars,
                meta: meta,
            };
        }
    }

    class DataPulseProvider {
        constructor(historyProvider, updateFrequency) {
            this._subscribers = {};
            this._requestsPending = 0;
            this._historyProvider = historyProvider;
            setInterval(this._updateData.bind(this), updateFrequency);
        }
        subscribeBars(symbolInfo, resolution, newDataCallback, listenerGuid) {
            if (this._subscribers.hasOwnProperty(listenerGuid)) {
                return;
            }
            this._subscribers[listenerGuid] = {
                lastBarTime: null,
                listener: newDataCallback,
                resolution: resolution,
                symbolInfo: symbolInfo,
            };
            logMessage(`DataPulseProvider: subscribed for #${listenerGuid} - {${symbolInfo.name}, ${resolution}}`);
        }
        unsubscribeBars(listenerGuid) {
            delete this._subscribers[listenerGuid];
        }
        _updateData() {
            if (this._requestsPending > 0) {
                return;
            }
            this._requestsPending = 0;
            // eslint-disable-next-line guard-for-in
            for (const listenerGuid in this._subscribers) {
                this._requestsPending += 1;
                this._updateDataForSubscriber(listenerGuid)
                    .then(() => {
                    this._requestsPending -= 1;
                    logMessage(`DataPulseProvider: data for #${listenerGuid} updated successfully, pending=${this._requestsPending}`);
                })
                    .catch((reason) => {
                    this._requestsPending -= 1;
                    logMessage(`DataPulseProvider: data for #${listenerGuid} updated with error=${getErrorMessage(reason)}, pending=${this._requestsPending}`);
                });
            }
        }
        _updateDataForSubscriber(listenerGuid) {
            const subscriptionRecord = this._subscribers[listenerGuid];
            const rangeEndTime = parseInt((Date.now() / 1000).toString());
            // BEWARE: please note we really need 2 bars, not the only last one
            // see the explanation below. `10` is the `large enough` value to work around holidays
            const rangeStartTime = rangeEndTime - periodLengthSeconds(subscriptionRecord.resolution, 10);
            return this._historyProvider.getBars(subscriptionRecord.symbolInfo, subscriptionRecord.resolution, {
                from: rangeStartTime,
                to: rangeEndTime,
                countBack: 2,
                firstDataRequest: false,
            })
                .then((result) => {
                this._onSubscriberDataReceived(listenerGuid, result);
            });
        }
        _onSubscriberDataReceived(listenerGuid, result) {
            // means the subscription was cancelled while waiting for data
            if (!this._subscribers.hasOwnProperty(listenerGuid)) {
                return;
            }
            const bars = result.bars;
            if (bars.length === 0) {
                return;
            }
            const lastBar = bars[bars.length - 1];
            const subscriptionRecord = this._subscribers[listenerGuid];
            if (subscriptionRecord.lastBarTime !== null && lastBar.time < subscriptionRecord.lastBarTime) {
                return;
            }
            const isNewBar = subscriptionRecord.lastBarTime !== null && lastBar.time > subscriptionRecord.lastBarTime;
            // Pulse updating may miss some trades data (ie, if pulse period = 10 secods and new bar is started 5 seconds later after the last update, the
            // old bar's last 5 seconds trades will be lost). Thus, at fist we should broadcast old bar updates when it's ready.
            if (isNewBar) {
                if (bars.length < 2) {
                    throw new Error('Not enough bars in history for proper pulse update. Need at least 2.');
                }
                const previousBar = bars[bars.length - 2];
                subscriptionRecord.listener(previousBar);
            }
            subscriptionRecord.lastBarTime = lastBar.time;
            subscriptionRecord.listener(lastBar);
        }
    }
    function periodLengthSeconds(resolution, requiredPeriodsCount) {
        let daysCount = 0;
        if (resolution === 'D' || resolution === '1D') {
            daysCount = requiredPeriodsCount;
        }
        else if (resolution === 'M' || resolution === '1M') {
            daysCount = 31 * requiredPeriodsCount;
        }
        else if (resolution === 'W' || resolution === '1W') {
            daysCount = 7 * requiredPeriodsCount;
        }
        else {
            daysCount = requiredPeriodsCount * parseInt(resolution) / (24 * 60);
        }
        return daysCount * 24 * 60 * 60;
    }

    class QuotesPulseProvider {
        constructor(quotesProvider) {
            this._subscribers = {};
            this._requestsPending = 0;
            this._timers = null;
            this._quotesProvider = quotesProvider;
        }
        subscribeQuotes(symbols, fastSymbols, onRealtimeCallback, listenerGuid) {
            this._subscribers[listenerGuid] = {
                symbols: symbols,
                fastSymbols: fastSymbols,
                listener: onRealtimeCallback,
            };
            this._createTimersIfRequired();
        }
        unsubscribeQuotes(listenerGuid) {
            delete this._subscribers[listenerGuid];
            if (Object.keys(this._subscribers).length === 0) {
                this._destroyTimers();
            }
        }
        _createTimersIfRequired() {
            if (this._timers === null) {
                const fastTimer = window.setInterval(this._updateQuotes.bind(this, 1 /* SymbolsType.Fast */), 10000 /* UpdateTimeouts.Fast */);
                const generalTimer = window.setInterval(this._updateQuotes.bind(this, 0 /* SymbolsType.General */), 60000 /* UpdateTimeouts.General */);
                this._timers = { fastTimer, generalTimer };
            }
        }
        _destroyTimers() {
            if (this._timers !== null) {
                clearInterval(this._timers.fastTimer);
                clearInterval(this._timers.generalTimer);
                this._timers = null;
            }
        }
        _updateQuotes(updateType) {
            if (this._requestsPending > 0) {
                return;
            }
            // eslint-disable-next-line guard-for-in
            for (const listenerGuid in this._subscribers) {
                this._requestsPending++;
                const subscriptionRecord = this._subscribers[listenerGuid];
                this._quotesProvider.getQuotes(updateType === 1 /* SymbolsType.Fast */ ? subscriptionRecord.fastSymbols : subscriptionRecord.symbols)
                    .then((data) => {
                    this._requestsPending--;
                    if (!this._subscribers.hasOwnProperty(listenerGuid)) {
                        return;
                    }
                    subscriptionRecord.listener(data);
                    logMessage(`QuotesPulseProvider: data for #${listenerGuid} (${updateType}) updated successfully, pending=${this._requestsPending}`);
                })
                    .catch((reason) => {
                    this._requestsPending--;
                    logMessage(`QuotesPulseProvider: data for #${listenerGuid} (${updateType}) updated with error=${getErrorMessage(reason)}, pending=${this._requestsPending}`);
                });
            }
        }
    }

    function extractField$1(data, field, arrayIndex, valueIsArray) {
        const value = data[field];
        if (Array.isArray(value) && (!valueIsArray || Array.isArray(value[0]))) {
            return value[arrayIndex];
        }
        return value;
    }
    function symbolKey(symbol, currency, unit) {
        // here we're using a separator that quite possible shouldn't be in a real symbol name
        return symbol + (currency !== undefined ? '_%|#|%_' + currency : '') + (unit !== undefined ? '_%|#|%_' + unit : '');
    }
    class SymbolsStorage {
        constructor(datafeedUrl, datafeedSupportedResolutions, requester) {
            this._exchangesList = ['NYSE', 'FOREX', 'AMEX'];
            this._symbolsInfo = {};
            this._symbolsList = [];
            this._datafeedUrl = datafeedUrl;
            this._datafeedSupportedResolutions = datafeedSupportedResolutions;
            this._requester = requester;
            this._readyPromise = this._init();
            this._readyPromise.catch((error) => {
                // seems it is impossible
                // tslint:disable-next-line:no-console
                console.error(`SymbolsStorage: Cannot init, error=${error.toString()}`);
            });
        }
        // BEWARE: this function does not consider symbol's exchange
        resolveSymbol(symbolName, currencyCode, unitId) {
            return this._readyPromise.then(() => {
                const symbolInfo = this._symbolsInfo[symbolKey(symbolName, currencyCode, unitId)];
                if (symbolInfo === undefined) {
                    return Promise.reject('invalid symbol');
                }
                return Promise.resolve(symbolInfo);
            });
        }
        searchSymbols(searchString, exchange, symbolType, maxSearchResults) {
            return this._readyPromise.then(() => {
                const weightedResult = [];
                const queryIsEmpty = searchString.length === 0;
                searchString = searchString.toUpperCase();
                for (const symbolName of this._symbolsList) {
                    const symbolInfo = this._symbolsInfo[symbolName];
                    if (symbolInfo === undefined) {
                        continue;
                    }
                    if (symbolType.length > 0 && symbolInfo.type !== symbolType) {
                        continue;
                    }
                    if (exchange && exchange.length > 0 && symbolInfo.exchange !== exchange) {
                        continue;
                    }
                    const positionInName = symbolInfo.name.toUpperCase().indexOf(searchString);
                    const positionInDescription = symbolInfo.description.toUpperCase().indexOf(searchString);
                    if (queryIsEmpty || positionInName >= 0 || positionInDescription >= 0) {
                        const alreadyExists = weightedResult.some((item) => item.symbolInfo === symbolInfo);
                        if (!alreadyExists) {
                            const weight = positionInName >= 0 ? positionInName : 8000 + positionInDescription;
                            weightedResult.push({ symbolInfo: symbolInfo, weight: weight });
                        }
                    }
                }
                const result = weightedResult
                    .sort((item1, item2) => item1.weight - item2.weight)
                    .slice(0, maxSearchResults)
                    .map((item) => {
                    const symbolInfo = item.symbolInfo;
                    return {
                        symbol: symbolInfo.name,
                        full_name: `${symbolInfo.exchange}:${symbolInfo.name}`,
                        description: symbolInfo.description,
                        exchange: symbolInfo.exchange,
                        params: [],
                        type: symbolInfo.type,
                        ticker: symbolInfo.name,
                    };
                });
                return Promise.resolve(result);
            });
        }
        _init() {
            const promises = [];
            const alreadyRequestedExchanges = {};
            for (const exchange of this._exchangesList) {
                if (alreadyRequestedExchanges[exchange]) {
                    continue;
                }
                alreadyRequestedExchanges[exchange] = true;
                promises.push(this._requestExchangeData(exchange));
            }
            return Promise.all(promises)
                .then(() => {
                this._symbolsList.sort();
            });
        }
        _requestExchangeData(exchange) {
            return new Promise((resolve, reject) => {
                this._requester.sendRequest(this._datafeedUrl, 'symbol_info', { group: exchange })
                    .then((response) => {
                    try {
                        this._onExchangeDataReceived(exchange, response);
                    }
                    catch (error) {
                        reject(error instanceof Error ? error : new Error(`SymbolsStorage: Unexpected exception ${error}`));
                        return;
                    }
                    resolve();
                })
                    .catch((reason) => {
                    logMessage(`SymbolsStorage: Request data for exchange '${exchange}' failed, reason=${getErrorMessage(reason)}`);
                    resolve();
                });
            });
        }
        _onExchangeDataReceived(exchange, data) {
            let symbolIndex = 0;
            try {
                const symbolsCount = data.symbol.length;
                const tickerPresent = data.ticker !== undefined;
                for (; symbolIndex < symbolsCount; ++symbolIndex) {
                    const symbolName = data.symbol[symbolIndex];
                    const listedExchange = extractField$1(data, 'exchange-listed', symbolIndex);
                    const tradedExchange = extractField$1(data, 'exchange-traded', symbolIndex);
                    const fullName = tradedExchange + ':' + symbolName;
                    const currencyCode = extractField$1(data, 'currency-code', symbolIndex);
                    const unitId = extractField$1(data, 'unit-id', symbolIndex);
                    const ticker = tickerPresent ? extractField$1(data, 'ticker', symbolIndex) : symbolName;
                    const symbolInfo = {
                        ticker: ticker,
                        name: symbolName,
                        base_name: [listedExchange + ':' + symbolName],
                        listed_exchange: listedExchange,
                        exchange: tradedExchange,
                        currency_code: currencyCode,
                        original_currency_code: extractField$1(data, 'original-currency-code', symbolIndex),
                        unit_id: unitId,
                        original_unit_id: extractField$1(data, 'original-unit-id', symbolIndex),
                        unit_conversion_types: extractField$1(data, 'unit-conversion-types', symbolIndex, true),
                        description: extractField$1(data, 'description', symbolIndex),
                        has_intraday: definedValueOrDefault(extractField$1(data, 'has-intraday', symbolIndex), false),
                        visible_plots_set: definedValueOrDefault(extractField$1(data, 'visible-plots-set', symbolIndex), undefined),
                        minmov: extractField$1(data, 'minmovement', symbolIndex) || extractField$1(data, 'minmov', symbolIndex) || 0,
                        minmove2: extractField$1(data, 'minmove2', symbolIndex) || extractField$1(data, 'minmov2', symbolIndex),
                        fractional: extractField$1(data, 'fractional', symbolIndex),
                        pricescale: extractField$1(data, 'pricescale', symbolIndex),
                        type: extractField$1(data, 'type', symbolIndex),
                        session: extractField$1(data, 'session-regular', symbolIndex),
                        session_holidays: extractField$1(data, 'session-holidays', symbolIndex),
                        corrections: extractField$1(data, 'corrections', symbolIndex),
                        timezone: extractField$1(data, 'timezone', symbolIndex),
                        supported_resolutions: definedValueOrDefault(extractField$1(data, 'supported-resolutions', symbolIndex, true), this._datafeedSupportedResolutions),
                        has_daily: definedValueOrDefault(extractField$1(data, 'has-daily', symbolIndex), true),
                        intraday_multipliers: definedValueOrDefault(extractField$1(data, 'intraday-multipliers', symbolIndex, true), ['1', '5', '15', '30', '60']),
                        has_weekly_and_monthly: extractField$1(data, 'has-weekly-and-monthly', symbolIndex),
                        has_empty_bars: extractField$1(data, 'has-empty-bars', symbolIndex),
                        volume_precision: definedValueOrDefault(extractField$1(data, 'volume-precision', symbolIndex), 0),
                        format: 'price',
                    };
                    this._symbolsInfo[ticker] = symbolInfo;
                    this._symbolsInfo[symbolName] = symbolInfo;
                    this._symbolsInfo[fullName] = symbolInfo;
                    if (currencyCode !== undefined || unitId !== undefined) {
                        this._symbolsInfo[symbolKey(ticker, currencyCode, unitId)] = symbolInfo;
                        this._symbolsInfo[symbolKey(symbolName, currencyCode, unitId)] = symbolInfo;
                        this._symbolsInfo[symbolKey(fullName, currencyCode, unitId)] = symbolInfo;
                    }
                    this._symbolsList.push(symbolName);
                }
            }
            catch (error) {
                throw new Error(`SymbolsStorage: API error when processing exchange ${exchange} symbol #${symbolIndex} (${data.symbol[symbolIndex]}): ${Object(error).message}`);
            }
        }
    }
    function definedValueOrDefault(value, defaultValue) {
        return value !== undefined ? value : defaultValue;
    }

    function extractField(data, field, arrayIndex) {
        const value = data[field];
        return Array.isArray(value) ? value[arrayIndex] : value;
    }
    /**
     * This class implements interaction with UDF-compatible datafeed.
     * See [UDF protocol reference](@docs/connecting_data/UDF.md)
     */
    class UDFCompatibleDatafeedBase {
        constructor(datafeedURL, quotesProvider, requester, updateFrequency = 10 * 1000, limitedServerResponse) {
            this._configuration = defaultConfiguration();
            this._symbolsStorage = null;
            this._datafeedURL = datafeedURL;
            this._requester = requester;
            this._historyProvider = new HistoryProvider(datafeedURL, this._requester, limitedServerResponse);
            this._quotesProvider = quotesProvider;
            this._dataPulseProvider = new DataPulseProvider(this._historyProvider, updateFrequency);
            this._quotesPulseProvider = new QuotesPulseProvider(this._quotesProvider);
            this._configurationReadyPromise = this._requestConfiguration()
                .then((configuration) => {
                if (configuration === null) {
                    configuration = defaultConfiguration();
                }
                this._setupWithConfiguration(configuration);
            });
        }
        onReady(callback) {
            this._configurationReadyPromise.then(() => {
                callback(this._configuration);
            });
        }
        getQuotes(symbols, onDataCallback, onErrorCallback) {
            this._quotesProvider.getQuotes(symbols).then(onDataCallback).catch(onErrorCallback);
        }
        subscribeQuotes(symbols, fastSymbols, onRealtimeCallback, listenerGuid) {
            this._quotesPulseProvider.subscribeQuotes(symbols, fastSymbols, onRealtimeCallback, listenerGuid);
        }
        unsubscribeQuotes(listenerGuid) {
            this._quotesPulseProvider.unsubscribeQuotes(listenerGuid);
        }
        getMarks(symbolInfo, from, to, onDataCallback, resolution) {
            if (!this._configuration.supports_marks) {
                return;
            }
            const requestParams = {
                symbol: symbolInfo.ticker || '',
                from: from,
                to: to,
                resolution: resolution,
            };
            this._send('marks', requestParams)
                .then((response) => {
                if (!Array.isArray(response)) {
                    const result = [];
                    for (let i = 0; i < response.id.length; ++i) {
                        result.push({
                            id: extractField(response, 'id', i),
                            time: extractField(response, 'time', i),
                            color: extractField(response, 'color', i),
                            text: extractField(response, 'text', i),
                            label: extractField(response, 'label', i),
                            labelFontColor: extractField(response, 'labelFontColor', i),
                            minSize: extractField(response, 'minSize', i),
                            borderWidth: extractField(response, 'borderWidth', i),
                            hoveredBorderWidth: extractField(response, 'hoveredBorderWidth', i),
                            imageUrl: extractField(response, 'imageUrl', i),
                            showLabelWhenImageLoaded: extractField(response, 'showLabelWhenImageLoaded', i),
                        });
                    }
                    response = result;
                }
                onDataCallback(response);
            })
                .catch((error) => {
                logMessage(`UdfCompatibleDatafeed: Request marks failed: ${getErrorMessage(error)}`);
                onDataCallback([]);
            });
        }
        getTimescaleMarks(symbolInfo, from, to, onDataCallback, resolution) {
            if (!this._configuration.supports_timescale_marks) {
                return;
            }
            const requestParams = {
                symbol: symbolInfo.ticker || '',
                from: from,
                to: to,
                resolution: resolution,
            };
            this._send('timescale_marks', requestParams)
                .then((response) => {
                if (!Array.isArray(response)) {
                    const result = [];
                    for (let i = 0; i < response.id.length; ++i) {
                        result.push({
                            id: extractField(response, 'id', i),
                            time: extractField(response, 'time', i),
                            color: extractField(response, 'color', i),
                            label: extractField(response, 'label', i),
                            tooltip: extractField(response, 'tooltip', i),
                            imageUrl: extractField(response, 'imageUrl', i),
                            showLabelWhenImageLoaded: extractField(response, 'showLabelWhenImageLoaded', i),
                        });
                    }
                    response = result;
                }
                onDataCallback(response);
            })
                .catch((error) => {
                logMessage(`UdfCompatibleDatafeed: Request timescale marks failed: ${getErrorMessage(error)}`);
                onDataCallback([]);
            });
        }
        getServerTime(callback) {
            if (!this._configuration.supports_time) {
                return;
            }
            this._send('time')
                .then((response) => {
                const time = parseInt(response);
                if (!isNaN(time)) {
                    callback(time);
                }
            })
                .catch((error) => {
                logMessage(`UdfCompatibleDatafeed: Fail to load server time, error=${getErrorMessage(error)}`);
            });
        }
        searchSymbols(userInput, exchange, symbolType, onResult) {
            if (this._configuration.supports_search) {
                const params = {
                    limit: 30 /* Constants.SearchItemsLimit */,
                    query: userInput.toUpperCase(),
                    type: symbolType,
                    exchange: exchange,
                };
                this._send('search', params)
                    .then((response) => {
                    if (response.s !== undefined) {
                        logMessage(`UdfCompatibleDatafeed: search symbols error=${response.errmsg}`);
                        onResult([]);
                        return;
                    }
                    onResult(response);
                })
                    .catch((reason) => {
                    logMessage(`UdfCompatibleDatafeed: Search symbols for '${userInput}' failed. Error=${getErrorMessage(reason)}`);
                    onResult([]);
                });
            }
            else {
                if (this._symbolsStorage === null) {
                    throw new Error('UdfCompatibleDatafeed: inconsistent configuration (symbols storage)');
                }
                this._symbolsStorage.searchSymbols(userInput, exchange, symbolType, 30 /* Constants.SearchItemsLimit */)
                    .then(onResult)
                    .catch(onResult.bind(null, []));
            }
        }
        resolveSymbol(symbolName, onResolve, onError, extension) {
            const currencyCode = extension && extension.currencyCode;
            const unitId = extension && extension.unitId;
            function onResultReady(symbolInfo) {
                onResolve(symbolInfo);
            }
            if (!this._configuration.supports_group_request) {
                const params = {
                    symbol: symbolName,
                };
                if (currencyCode !== undefined) {
                    params.currencyCode = currencyCode;
                }
                if (unitId !== undefined) {
                    params.unitId = unitId;
                }
                this._send('symbols', params)
                    .then((response) => {
                    if (response.s !== undefined) {
                        onError('unknown_symbol');
                    }
                    else {
                        const symbol = response.name;
                        const listedExchange = response.listed_exchange ?? response['exchange-listed'];
                        const tradedExchange = response.exchange ?? response['exchange-traded'];
                        const result = {
                            ...response,
                            name: symbol,
                            base_name: [listedExchange + ':' + symbol],
                            listed_exchange: listedExchange,
                            exchange: tradedExchange,
                            ticker: response.ticker,
                            currency_code: response.currency_code ?? response['currency-code'],
                            original_currency_code: response.original_currency_code ?? response['original-currency-code'],
                            unit_id: response.unit_id ?? response['unit-id'],
                            original_unit_id: response.original_unit_id ?? response['original-unit-id'],
                            unit_conversion_types: response.unit_conversion_types ?? response['unit-conversion-types'],
                            has_intraday: response.has_intraday ?? response['has-intraday'] ?? false,
                            visible_plots_set: response.visible_plots_set ?? response['visible-plots-set'],
                            minmov: response.minmovement ?? response.minmov ?? 0,
                            minmove2: response.minmovement2 ?? response.minmove2,
                            session: response.session ?? response['session-regular'],
                            session_holidays: response.session_holidays ?? response['session-holidays'],
                            supported_resolutions: response.supported_resolutions ?? response['supported-resolutions'] ?? this._configuration.supported_resolutions ?? [],
                            has_daily: response.has_daily ?? response['has-daily'] ?? true,
                            intraday_multipliers: response.intraday_multipliers ?? response['intraday-multipliers'] ?? ['1', '5', '15', '30', '60'],
                            has_weekly_and_monthly: response.has_weekly_and_monthly ?? response['has-weekly-and-monthly'],
                            has_empty_bars: response.has_empty_bars ?? response['has-empty-bars'],
                            volume_precision: response.volume_precision ?? response['volume-precision'],
                            format: response.format ?? 'price',
                        };
                        onResultReady(result);
                    }
                })
                    .catch((reason) => {
                    logMessage(`UdfCompatibleDatafeed: Error resolving symbol: ${getErrorMessage(reason)}`);
                    onError('unknown_symbol');
                });
            }
            else {
                if (this._symbolsStorage === null) {
                    throw new Error('UdfCompatibleDatafeed: inconsistent configuration (symbols storage)');
                }
                this._symbolsStorage.resolveSymbol(symbolName, currencyCode, unitId).then(onResultReady).catch(onError);
            }
        }
        getBars(symbolInfo, resolution, periodParams, onResult, onError) {
            this._historyProvider.getBars(symbolInfo, resolution, periodParams)
                .then((result) => {
                onResult(result.bars, result.meta);
            })
                .catch(onError);
        }
        subscribeBars(symbolInfo, resolution, onTick, listenerGuid, _onResetCacheNeededCallback) {
            this._dataPulseProvider.subscribeBars(symbolInfo, resolution, onTick, listenerGuid);
        }
        unsubscribeBars(listenerGuid) {
            this._dataPulseProvider.unsubscribeBars(listenerGuid);
        }
        _requestConfiguration() {
            return this._send('config')
                .catch((reason) => {
                logMessage(`UdfCompatibleDatafeed: Cannot get datafeed configuration - use default, error=${getErrorMessage(reason)}`);
                return null;
            });
        }
        _send(urlPath, params) {
            return this._requester.sendRequest(this._datafeedURL, urlPath, params);
        }
        _setupWithConfiguration(configurationData) {
            this._configuration = configurationData;
            if (configurationData.exchanges === undefined) {
                configurationData.exchanges = [];
            }
            if (!configurationData.supports_search && !configurationData.supports_group_request) {
                throw new Error('Unsupported datafeed configuration. Must either support search, or support group request');
            }
            if (configurationData.supports_group_request || !configurationData.supports_search) {
                this._symbolsStorage = new SymbolsStorage(this._datafeedURL, configurationData.supported_resolutions || [], this._requester);
            }
            logMessage(`UdfCompatibleDatafeed: Initialized with ${JSON.stringify(configurationData)}`);
        }
    }
    function defaultConfiguration() {
        return {
            supports_search: false,
            supports_group_request: true,
            supported_resolutions: [
                '1',
                '5',
                '15',
                '30',
                '60',
                '1D',
                '1W',
                '1M',
            ],
            supports_marks: false,
            supports_timescale_marks: false,
        };
    }

    class QuotesProvider {
        constructor(datafeedUrl, requester) {
            this._datafeedUrl = datafeedUrl;
            this._requester = requester;
        }
        getQuotes(symbols) {
            return new Promise((resolve, reject) => {
                this._requester.sendRequest(this._datafeedUrl, 'quotes', { symbols: symbols })
                    .then((response) => {
                    if (response.s === 'ok') {
                        resolve(response.d);
                    }
                    else {
                        reject(response.errmsg);
                    }
                })
                    .catch((error) => {
                    const errorMessage = getErrorMessage(error);
                    reject(`network error: ${errorMessage}`);
                });
            });
        }
    }

    class Requester {
        constructor(headers) {
            if (headers) {
                this._headers = headers;
            }
        }
        sendRequest(datafeedUrl, urlPath, params) {
            if (params !== undefined) {
                const paramKeys = Object.keys(params);
                if (paramKeys.length !== 0) {
                    urlPath += '?';
                }
                urlPath += paramKeys.map((key) => {
                    return `${encodeURIComponent(key)}=${encodeURIComponent(params[key].toString())}`;
                }).join('&');
            }
            // Send user cookies if the URL is on the same origin as the calling script.
            const options = { credentials: 'same-origin' };
            if (this._headers !== undefined) {
                options.headers = this._headers;
            }
            // eslint-disable-next-line no-restricted-globals
            return fetch(`${datafeedUrl}/${urlPath}`, options)
                .then((response) => response.text())
                .then((responseTest) => JSON.parse(responseTest));
        }
    }

    function resolutionToSeconds(resolution) {
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
    function normalizeResolution(resolution) {
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
    function getChartBucketStart(timeMs, chartResolutionSeconds) {
        const periodMs = chartResolutionSeconds * 1000;
        return Math.floor(timeMs / periodMs) * periodMs;
    }
    /** After finishing the chart bar containing `timeMs`, resume at the next chart bucket open. */
    function getNextChartBucketStart(timeMs, chartResolutionSeconds) {
        return getChartBucketStart(timeMs, chartResolutionSeconds) + chartResolutionSeconds * 1000;
    }
    /**
     * Resume time when switching step resolution.
     * Coarser-or-equal step (vs chart) stays on the current chart bucket; finer step advances to the next bucket.
     */
    function getStepResolutionResumeMs(currentTimeMs, chartResolutionSeconds, newStepResolutionSeconds) {
        if (newStepResolutionSeconds >= chartResolutionSeconds) {
            return getChartBucketStart(currentTimeMs, chartResolutionSeconds);
        }
        return getNextChartBucketStart(currentTimeMs, chartResolutionSeconds);
    }
    /**
     * Aggregate step-resolution bars through `endIndex` (inclusive) into chart-resolution OHLC buckets.
     */
    function aggregateStepBarsToChartBars(stepBars, endIndex, chartResolutionSeconds) {
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
    function stepBarsMatchResolution(bars, resolutionSeconds) {
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
    /** Keep frozen chart history; replace overlapping buckets with the live tail aggregate. */
    function mergeFrozenChartBarsWithTail(frozen, tail) {
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

    /**
     * ReplayController manages the replay state and time progression logic.
     * Step bars advance at `stepResolution`; chart-visible bars are aggregated to `chartResolution`.
     */
    class ReplayController {
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

    /**
     * ReplayDatafeedWrapper wraps an existing datafeed and provides replay functionality.
     * In replay mode, it filters historical data based on the replay controller's current time.
     */
    class ReplayDatafeedWrapper {
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

    /**
     * PaperTradingEngine simulates trading during replay.
     * It supports opening/closing positions and tracking P&L.
     */
    class PaperTradingEngine {
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

    class UDFCompatibleDatafeed extends UDFCompatibleDatafeedBase {
        constructor(datafeedURL, updateFrequency = 10 * 1000, limitedServerResponse) {
            const requester = new Requester();
            const quotesProvider = new QuotesProvider(datafeedURL, requester);
            super(datafeedURL, quotesProvider, requester, updateFrequency, limitedServerResponse);
        }
    }

    exports.PaperTradingEngine = PaperTradingEngine;
    exports.ReplayController = ReplayController;
    exports.ReplayDatafeedWrapper = ReplayDatafeedWrapper;
    exports.UDFCompatibleDatafeed = UDFCompatibleDatafeed;

}));
