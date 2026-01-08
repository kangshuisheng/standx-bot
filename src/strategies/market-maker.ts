import { BaseStrategy } from "./base-strategy";
import Decimal from "decimal.js";
import { StandXClient } from "../services/standx-api";
import { Logger } from "../utils/logger";

export class MarketMakerStrategy extends BaseStrategy {
  private client: StandXClient;
  private logger: Logger;

  constructor(
    client: StandXClient,
    tradingPair: string,
    spread: Decimal,
    orderSize: Decimal,
    maxPosition: Decimal
  ) {
    super(tradingPair, spread, orderSize, maxPosition);
    this.client = client;
    this.logger = new Logger();
  }

  public async initialize(): Promise<void> {
    this.logger.info(
      `Initializing Market Maker Strategy for ${this.tradingPair}...`
    );
  }

  public async execute(): Promise<void> {
    this.logger.info("Executing Market Maker Strategy cycle...");
    try {
      // 1. Cancel existing orders to clear the book for new quotes
      try {
        await this.client.cancelAllOrders(this.tradingPair);
      } catch (e: any) {
        this.logger.warn(`Failed to cancel orders: ${e.message || e}`);
      }

      // 2. Fetch Orderbook
      const ob = await this.client.getOrderbook(this.tradingPair);

      const bids = ob.bids || [];
      const asks = ob.asks || [];

      if (bids.length === 0 || asks.length === 0) {
        this.logger.warn("Orderbook empty or invalid, skipping cycle.");
        return;
      }

      const bestBid = new Decimal(bids[0][0]);
      const bestAsk = new Decimal(asks[0][0]);
      const midPrice = bestBid.plus(bestAsk).dividedBy(2);

      this.logger.info(
        `Market: ${midPrice.toFixed(2)} (Bid: ${bestBid}, Ask: ${bestAsk})`
      );

      // 3. Get Current Position - 检查是否有持仓
      const currentPos = await this.client.getPosition(this.tradingPair);

      // ⚠️ 关键安全逻辑：如果有持仓，先平掉！
      if (!currentPos.isZero()) {
        this.logger.warn(
          `⚠️ DETECTED POSITION: ${currentPos} BTC - Attempting to close!`
        );

        const absPos = currentPos.abs();
        if (currentPos.greaterThan(0)) {
          // 有多仓，挂卖单平仓（以 bestBid 价格快速成交）
          this.logger.info(
            `Closing LONG position: Selling ${absPos} BTC at ${bestBid}`
          );
          await this.client.placeOrder(
            this.tradingPair,
            "sell",
            bestBid,
            absPos
          );
        } else {
          // 有空仓，挂买单平仓（以 bestAsk 价格快速成交）
          this.logger.info(
            `Closing SHORT position: Buying ${absPos} BTC at ${bestAsk}`
          );
          await this.client.placeOrder(
            this.tradingPair,
            "buy",
            bestAsk,
            absPos
          );
        }

        this.logger.info("Close order placed. Skipping new orders this cycle.");
        return; // 这个周期不挂新单，等下个周期确认仓位已平
      }

      // 4. Calculate Target Prices
      const { buyPrice, sellPrice } = await this.calculatePrices(midPrice);

      // 5. Convert USD order size to BTC quantity
      const MIN_QTY = new Decimal("0.001");

      let buyQty = this.orderSize
        .dividedBy(buyPrice)
        .toDecimalPlaces(3, Decimal.ROUND_DOWN);
      let sellQty = this.orderSize
        .dividedBy(sellPrice)
        .toDecimalPlaces(3, Decimal.ROUND_DOWN);

      if (buyQty.lessThan(MIN_QTY)) buyQty = MIN_QTY;
      if (sellQty.lessThan(MIN_QTY)) sellQty = MIN_QTY;

      this.logger.info(
        `Order Size: ${buyQty} BTC (~${buyQty.times(midPrice).toFixed(2)} USD)`
      );

      // 6. Place new maker orders
      this.logger.info(
        `Placing BUY at ${buyPrice.toFixed(2)}, SELL at ${sellPrice.toFixed(2)}`
      );

      await this.client.placeOrder(this.tradingPair, "buy", buyPrice, buyQty);
      await this.client.placeOrder(
        this.tradingPair,
        "sell",
        sellPrice,
        sellQty
      );

      this.logger.info("✅ Strategy cycle completed.");
    } catch (e: any) {
      this.logger.error(
        `Strategy cycle failed: ${e.message}`,
        e.response?.data
      );
    }
  }

  public async calculatePrices(
    midPrice: Decimal
  ): Promise<{ buyPrice: Decimal; sellPrice: Decimal }> {
    const halfSpread = this.spread.dividedBy(2);
    // Target Bid = Mid * (1 - halfSpread)
    const buyPrice = midPrice.times(new Decimal(1).minus(halfSpread));
    // Target Ask = Mid * (1 + halfSpread)
    const sellPrice = midPrice.times(new Decimal(1).plus(halfSpread));

    return { buyPrice, sellPrice };
  }
}
