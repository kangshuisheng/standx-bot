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
    ordersTier3: number = 1,
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
      `Initializing Market Maker Strategy for ${this.tradingPair}...`,
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
        `Market: ${midPrice.toFixed(2)} (Bid: ${bestBid}, Ask: ${bestAsk})`,
      );

      // 3. Get Current Position - 检查是否有持仓
      const currentPos = await this.client.getPosition(this.tradingPair);

      // ⚠️ 关键安全逻辑：如果有持仓，先平掉！
      if (!currentPos.isZero()) {
        this.logger.warn(
          `⚠️ DETECTED POSITION: ${currentPos} BTC - Attempting to close!`,
        );

        const absPos = currentPos.abs();
        if (currentPos.greaterThan(0)) {
          // 有多仓，挂卖单平仓（以 bestBid 价格快速成交）
          this.logger.info(
            `Closing LONG position: Selling ${absPos} BTC at ${bestBid}`,
          );
          await this.client.placeOrder(
            this.tradingPair,
            "sell",
            bestBid,
            absPos,
          );
        } else {
          // 有空仓，挂买单平仓（以 bestAsk 价格快速成交）
          this.logger.info(
            `Closing SHORT position: Buying ${absPos} BTC at ${bestAsk}`,
          );
          await this.client.placeOrder(
            this.tradingPair,
            "buy",
            bestAsk,
            absPos,
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
      const pairsCount =
        (this.ordersTier1 > 0 ? 1 : 0) +
        (this.ordersTier2 > 0 ? 1 : 0) +
        (this.ordersTier3 > 0 ? 1 : 0);

      if (pairsCount === 0) {
        this.logger.warn("No tiers enabled, skipping cycle.");
        return;
      }

      // 每对的数量（总量在启用的 pairs 之间均分）
      const qtyPerSide = this.orderSize
        .dividedBy(midPrice)
        .dividedBy(pairsCount)
        .toDecimalPlaces(3, Decimal.ROUND_DOWN);

      const actualQty = qtyPerSide.lessThan(MIN_QTY) ? MIN_QTY : qtyPerSide;

      this.logger.info(
        `Pairs-enabled: ${pairsCount}. ${actualQty} BTC per side (~${actualQty
          .times(midPrice)
          .toFixed(2)} USD)`,
      );

      const orders: Array<{
        side: "buy" | "sell";
        price: Decimal;
        qty: Decimal;
        tier: number;
      }> = [];

      // Tier 1: single pair (edge)
      if (this.ordersTier1 > 0) {
        const offset = new Decimal("0.0009");
        const buyPrice = midPrice.times(new Decimal(1).minus(offset));
        const sellPrice = midPrice.times(new Decimal(1).plus(offset));
        orders.push({ side: "buy", price: buyPrice, qty: actualQty, tier: 1 });
        orders.push({
          side: "sell",
          price: sellPrice,
          qty: actualQty,
          tier: 1,
        });
      }

      // Tier 2: single pair (mid)
      if (this.ordersTier2 > 0) {
        const offset = new Decimal("0.0020");
        const buyPrice = midPrice.times(new Decimal(1).minus(offset));
        const sellPrice = midPrice.times(new Decimal(1).plus(offset));
        orders.push({ side: "buy", price: buyPrice, qty: actualQty, tier: 2 });
        orders.push({
          side: "sell",
          price: sellPrice,
          qty: actualQty,
          tier: 2,
        });
      }

      // Tier 3: single pair (mid)
      if (this.ordersTier3 > 0) {
        const offset = new Decimal("0.0060");
        const buyPrice = midPrice.times(new Decimal(1).minus(offset));
        const sellPrice = midPrice.times(new Decimal(1).plus(offset));
        orders.push({ side: "buy", price: buyPrice, qty: actualQty, tier: 3 });
        orders.push({
          side: "sell",
          price: sellPrice,
          qty: actualQty,
          tier: 3,
        });
      }

      this.logger.info(
        `Placing ${orders.length} orders across ${pairsCount} tiers (one pair each)`,
      );

      // 5. 并发下单
      const orderPromises = orders.map((o) =>
        this.client.placeOrder(this.tradingPair, o.side, o.price, o.qty),
      );

      await Promise.all(orderPromises);

      this.logger.info("✅ Strategy cycle completed.");
    } catch (e: any) {
      this.logger.error(
        `Strategy cycle failed: ${e.message}`,
        e.response?.data,
      );
    }
  }

  public async calculatePrices(
    midPrice: Decimal,
  ): Promise<{ buyPrice: Decimal; sellPrice: Decimal }> {
    const halfSpread = this.spread.dividedBy(2);
    // Target Bid = Mid * (1 - halfSpread)
    const buyPrice = midPrice.times(new Decimal(1).minus(halfSpread));
    // Target Ask = Mid * (1 + halfSpread)
    const sellPrice = midPrice.times(new Decimal(1).plus(halfSpread));

    return { buyPrice, sellPrice };
  }
}
