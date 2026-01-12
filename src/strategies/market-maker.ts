import { BaseStrategy } from "./base-strategy";
import Decimal from "decimal.js";
import { StandXClient } from "../services/standx-api";
import { Logger } from "../utils/logger";
import { config } from "../config";

export class MarketMakerStrategy extends BaseStrategy {
  private client: StandXClient;
  private logger: Logger;
  private ordersTier1: number; // 0-10 bps (100% 积分)
  private ordersTier2: number; // 10-30 bps (50% 积分)
  private ordersTier3: number; // 30 bps-1% (10% 积分)
  private orderMeta: Map<number, { tier: number; createdAt: number; price: Decimal }> = new Map();

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
      // 1. Fetch Orderbook
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

      // 2. Get Current Position - 检查是否有持仓
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
            absPos,
            { reduce_only: true }
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
            absPos,
            { reduce_only: true }
          );
        }

        this.logger.info("Close order placed. Skipping new orders this cycle.");
        return; // 这个周期不挂新单，等下个周期确认仓位已平
      }

      // 3. 选择性撤单：使用 openOrders 的 created_at（若 meta 缺失），并按 TTL/区间撤单
      try {
        const openOrders = await this.client.getOpenOrders(this.tradingPair);
        const now = Date.now();
        const toCancel: number[] = [];

        for (const o of openOrders) {
          const price = new Decimal(o.price);
          const offset = price.minus(midPrice).abs().dividedBy(midPrice);

          // 判断该挂单是否落在 0-10bps, 10-30bps 或 30bps-1% 区间
          const inTier1 = offset.greaterThanOrEqualTo(0) && offset.lessThanOrEqualTo(new Decimal(0.001));
          const inTier2 = offset.greaterThan(new Decimal(0.001)) && offset.lessThanOrEqualTo(new Decimal(0.003));
          const inTier3 = offset.greaterThan(new Decimal(0.003)) && offset.lessThanOrEqualTo(new Decimal(0.01));

          const id = o.id;

          // Determine tier from price if possible
          const orderTier = inTier1 ? 1 : inTier2 ? 2 : inTier3 ? 3 : 0;

          // Determine createdAt (prefer metadata, fallback to API created_at)
          const meta = this.orderMeta.get(id);
          let createdAtMs: number | undefined = undefined;
          if (meta) {
            createdAtMs = meta.createdAt;
          } else if (o.created_at) {
            createdAtMs = new Date(o.created_at).getTime();
          }

          // If we know tier and createdAt, check TTL
          if (orderTier > 0 && createdAtMs) {
            const tierTTL = orderTier === 1 ? config.TIER1_TTL_SEC : orderTier === 2 ? config.TIER2_TTL_SEC : config.TIER3_TTL_SEC;
            if (now - createdAtMs > tierTTL * 1000) {
              toCancel.push(id);
              continue;
            }
          }

          // If the order is outside known tiers, cancel it
          if (!inTier1 && !inTier2 && !inTier3) {
            toCancel.push(id);
            continue;
          }

          // Otherwise keep the order
        }

        if (toCancel.length > 0) {
          this.logger.info(`Cancelling ${toCancel.length} outdated/out-of-band orders`);
          await Promise.allSettled(toCancel.map((id) => this.client.cancelOrder(id)));
          // remove from local metadata store
          toCancel.forEach((id) => this.orderMeta.delete(id));
        }
      } catch (e: any) {
        this.logger.warn(`Failed during selective cancel step: ${e.message || e}`);
      }

      // 4. 按照 StandX 官方积分档位分配订单（每个档位挂在边缘，最大化积分，最小化成交风险）
      // Tier 1: 0-10 bps → 100% 积分
      // Tier 2: 10-30 bps → 50% 积分
      // Tier 3: 30 bps-1% → 10% 积分

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

      // Tier 1: single order per side if configured
      if (this.ordersTier1 > 0) {
        const useSingle = config.TIER1_SINGLE_ORDER;
        const offsetBps = new Decimal(config.TIER1_OFFSET_BPS);
        const offset = offsetBps.dividedBy(10000); // bps -> decimal

        if (useSingle) {
          const aggregatedQty = actualQty.times(this.ordersTier1);
          const buyPrice = midPrice.times(new Decimal(1).minus(offset));
          const sellPrice = midPrice.times(new Decimal(1).plus(offset));

          orders.push({ side: "buy", price: buyPrice, qty: aggregatedQty, tier: 1 });
          orders.push({ side: "sell", price: sellPrice, qty: aggregatedQty, tier: 1 });
        } else {
          const tier1Start = new Decimal("0.0008"); // 8 bps
          const tier1End = new Decimal("0.0009"); // 9 bps
          const tier1Step =
            this.ordersTier1 > 1
              ? tier1End.minus(tier1Start).dividedBy(this.ordersTier1 - 1)
              : new Decimal(0);

          for (let i = 0; i < this.ordersTier1; i++) {
            const off =
              this.ordersTier1 > 1
                ? tier1Start.plus(tier1Step.times(i))
                : tier1End;
            const buyPrice = midPrice.times(new Decimal(1).minus(off));
            const sellPrice = midPrice.times(new Decimal(1).plus(off));
            orders.push({ side: "buy", price: buyPrice, qty: actualQty, tier: 1 });
            orders.push({ side: "sell", price: sellPrice, qty: actualQty, tier: 1 });
          }
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

      // 5. 批次下单（使用 allSettled 避免单个失败导致全部中断）
      const batchLimit = config.ORDER_RATE_LIMIT || 10;
      const batches: Array<Array<{ side: "buy" | "sell"; price: Decimal; qty: Decimal; tier: number }>> = [];
      for (let i = 0; i < orders.length; i += batchLimit) {
        batches.push(orders.slice(i, i + batchLimit));
      }

      let placedCount = 0;
      let failedCount = 0;

      for (const batch of batches) {
        const results = await Promise.allSettled(
          batch.map((o) =>
            this.client.placeOrder(this.tradingPair, o.side, o.price, o.qty)
          )
        );

        // 保存成功下单的元信息
        for (let i = 0; i < results.length; i++) {
          const res = results[i];
          const o = batch[i];
          if (res.status === "fulfilled") {
            placedCount++;
            const data = (res as any).value;
            const id = data?.result?.id || data?.result?.order_id || data?.order_id || data?.id;
            if (id) {
              this.orderMeta.set(id, { tier: o.tier, createdAt: Date.now(), price: o.price });
            }
          } else {
            failedCount++;
            this.logger.warn(`Order failed in batch: ${JSON.stringify(batch[i])} - ${JSON.stringify((res as any).reason?.response?.data || (res as any).reason?.message || (res as any).reason)}`);
          }
        }

        // 小延迟以给 API 缓口
        await new Promise((r) => setTimeout(r, 50));
      }

      // 同步 open orders，以便为没有直接返回 id 的新单录入 metadata（通过 price/qty/side 匹配）
      try {
        const openOrdersAfter = await this.client.getOpenOrders(this.tradingPair);
        for (const o of openOrdersAfter) {
          const id = o.id;
          if (this.orderMeta.has(id)) continue; // 已有元信息

          const price = new Decimal(o.price);
          const qty = new Decimal(o.qty);
          const side = o.side;
          const createdAtMs = o.created_at ? new Date(o.created_at).getTime() : Date.now();

          const match = orders.find((intend) =>
            intend.side === side && new Decimal(intend.price).equals(price) && new Decimal(intend.qty).equals(qty)
          );

          if (match) {
            this.orderMeta.set(id, { tier: match.tier, createdAt: createdAtMs, price });
          }
        }
      } catch (e: any) {
        this.logger.warn(`Failed to synchronize open orders after placing: ${e.message || e}`);
      }

      if (failedCount > 0) {
        this.logger.warn(`⚠️ ${failedCount}/${orders.length} orders failed`);
      }

      this.logger.info(`✅ Strategy cycle completed. (${placedCount}/${orders.length} orders placed)`);
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
