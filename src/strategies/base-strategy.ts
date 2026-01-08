import Decimal from 'decimal.js';

export abstract class BaseStrategy {
    protected tradingPair: string;
    protected spread: Decimal;
    protected orderSize: Decimal;
    protected maxPosition: Decimal;

    constructor(
        tradingPair: string,
        spread: Decimal,
        orderSize: Decimal,
        maxPosition: Decimal
    ) {
        this.tradingPair = tradingPair;
        this.spread = spread;
        this.orderSize = orderSize;
        this.maxPosition = maxPosition;
    }

    abstract execute(): Promise<void>;

    protected async checkPositionLimits(currentPosition: Decimal): Promise<boolean> {
        return currentPosition.lessThan(this.maxPosition);
    }
}
