import { BaseStrategy } from "./base-strategy";
import Decimal from "decimal.js";
import { StandXClient } from "../services/standx-api";
import { Logger } from "../utils/logger";

export class MarketMakerStrategy extends BaseStrategy {
  private client: StandXClient;
  private logger: Logger;
  private ordersTier1: number; // 0-10 bps (100% 积分)
  private ordersTier2: number; // 10-30 bps (50% 积分)
  private ordersTier3: number; // 30 bps-1% (10% 积分)

  constructor(
    client: StandXClient,
    tradingPair: string,
    spread: Decimal,
    orderSize: Decimal,
    maxPosition: Decimal,
    ordersTier1: number = 3,
    ordersTier2: number = 2,
    ordersTier3: number = 1
  ) {
    super(tradingPair, spread, orderSize, maxPosition);
    this.client = client;
    this.logger = new Logger();
    this.ordersTier1 = ordersTier1;
    this.ordersTier2 = ordersTier2;
    this.ordersTier3 = ordersTier3;
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

      // 4. 按照 StandX 官方积分档位分配订单（每个档位挂在边缘，最大化积分，最小化成交风险）
      // Tier 1: 0-10 bps → 100% 积分 → 挂在 ~9 bps（接近边缘但仍在100%区）
      // Tier 2: 10-30 bps → 50% 积分 → 挂在 ~28 bps（接近边缘但仍在50%区）
      // Tier 3: 30 bps-1% → 10% 积分 → 挂在 ~95 bps（接近边缘但仍在10%区）

      const MIN_QTY = new Decimal("0.001");
      const totalOrders =
        this.ordersTier1 + this.ordersTier2 + this.ordersTier3;

      // 每个订单的数量（总量平分）
      const qtyPerOrder = this.orderSize
        .dividedBy(midPrice)
        .dividedBy(totalOrders)
        .toDecimalPlaces(3, Decimal.ROUND_DOWN);

      const actualQty = qtyPerOrder.lessThan(MIN_QTY) ? MIN_QTY : qtyPerOrder;

      this.logger.info(
        `Tier-based orders: T1=${this.ordersTier1}, T2=${
          this.ordersTier2
        }, T3=${this.ordersTier3}, ${actualQty} BTC per order (~${actualQty
          .times(midPrice)
          .toFixed(2)} USD)`
      );

      const orders: Array<{
        side: "buy" | "sell";
        price: Decimal;
        qty: Decimal;
        tier: number;
      }> = [];

      // Tier 1: 100% 积分区，在 7-9 bps 之间分散（最远但仍在 0-10 bps 内）
      if (this.ordersTier1 > 0) {
        const tier1Start = new Decimal("0.0008"); // 8 bps
        const tier1End = new Decimal("0.0009"); // 9 bps
        const tier1Step =
          this.ordersTier1 > 1
            ? tier1End.minus(tier1Start).dividedBy(this.ordersTier1 - 1)
            : new Decimal(0);

        for (let i = 0; i < this.ordersTier1; i++) {
          const offset =
            this.ordersTier1 > 1
              ? tier1Start.plus(tier1Step.times(i))
              : tier1End;
          const buyPrice = midPrice.times(new Decimal(1).minus(offset));
          const sellPrice = midPrice.times(new Decimal(1).plus(offset));
          orders.push({
            side: "buy",
            price: buyPrice,
            qty: actualQty,
            tier: 1,
          });
          orders.push({
            side: "sell",
            price: sellPrice,
            qty: actualQty,
            tier: 1,
          });
        }
      }

      // Tier 2: 50% 积分区，在 15-28 bps 之间分散
      if (this.ordersTier2 > 0) {
        const tier2Start = new Decimal("0.0015"); // 15 bps
        const tier2End = new Decimal("0.0028"); // 28 bps
        const tier2Step =
          this.ordersTier2 > 1
            ? tier2End.minus(tier2Start).dividedBy(this.ordersTier2 - 1)
            : new Decimal(0);

        for (let i = 0; i < this.ordersTier2; i++) {
          const offset =
            this.ordersTier2 > 1
              ? tier2Start.plus(tier2Step.times(i))
              : tier2End;
          const buyPrice = midPrice.times(new Decimal(1).minus(offset));
          const sellPrice = midPrice.times(new Decimal(1).plus(offset));
          orders.push({
            side: "buy",
            price: buyPrice,
            qty: actualQty,
            tier: 2,
          });
          orders.push({
            side: "sell",
            price: sellPrice,
            qty: actualQty,
            tier: 2,
          });
        }
      }

      // Tier 3: 10% 积分区，在 40-95 bps 之间分散
      if (this.ordersTier3 > 0) {
        const tier3Start = new Decimal("0.0040"); // 40 bps
        const tier3End = new Decimal("0.0095"); // 95 bps
        const tier3Step =
          this.ordersTier3 > 1
            ? tier3End.minus(tier3Start).dividedBy(this.ordersTier3 - 1)
            : new Decimal(0);

        for (let i = 0; i < this.ordersTier3; i++) {
          const offset =
            this.ordersTier3 > 1
              ? tier3Start.plus(tier3Step.times(i))
              : tier3End;
          const buyPrice = midPrice.times(new Decimal(1).minus(offset));
          const sellPrice = midPrice.times(new Decimal(1).plus(offset));
          orders.push({
            side: "buy",
            price: buyPrice,
            qty: actualQty,
            tier: 3,
          });
          orders.push({
            side: "sell",
            price: sellPrice,
            qty: actualQty,
            tier: 3,
          });
        }
      }

      this.logger.info(
        `Placing ${orders.length} orders across 3 point tiers (100%/50%/10%)`
      );

      // 5. 并发下单
      const orderPromises = orders.map((o) =>
        this.client.placeOrder(this.tradingPair, o.side, o.price, o.qty)
      );

      await Promise.all(orderPromises);

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
