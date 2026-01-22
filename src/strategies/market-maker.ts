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
      // 1. Fetch existing open orders and reconcile (avoid full cancellations)
      let openOrders = await this.client.getOpenOrders(this.tradingPair);

      // 2. Fetch Orderbook & Market Prices
      const [ob, marketPriceData] = await Promise.all([
        this.client.getOrderbook(this.tradingPair),
        this.client.getSymbolPrice(this.tradingPair),
      ]);

      const bids = ob.bids || [];
      const asks = ob.asks || [];

      if (bids.length === 0 || asks.length === 0) {
        this.logger.warn("Orderbook empty or invalid, skipping cycle.");
        return;
      }

      const bestBid = new Decimal(bids[0][0]);
      const bestAsk = new Decimal(asks[0][0]);
      const orderbookMid = bestBid.plus(bestAsk).dividedBy(2);

      // Use Mark Price as the primary reference for order placement (Standard for Points & Safety)
      let referencePrice: Decimal;
      if (marketPriceData && marketPriceData.mark_price) {
        referencePrice = new Decimal(marketPriceData.mark_price);
      } else if (marketPriceData && marketPriceData.index_price) {
        referencePrice = new Decimal(marketPriceData.index_price);
        this.logger.warn("Mark price unavailable, using Index Price.");
      } else {
        referencePrice = orderbookMid;
        this.logger.warn("Mark/Index price unavailable, falling back to Orderbook Mid.");
      }

      const indexPrice = marketPriceData?.index_price
        ? new Decimal(marketPriceData.index_price)
        : new Decimal(0);

      this.logger.info(
        `Prices -> Ref(Mark): ${referencePrice.toFixed(2)} | Index: ${indexPrice.toFixed(2)} | OB Mid: ${orderbookMid.toFixed(2)}`
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
      // compute how many pairs we will place (1 pair per enabled tier)
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
        .dividedBy(referencePrice)
        .dividedBy(pairsCount)
        .toDecimalPlaces(3, Decimal.ROUND_DOWN);

      const actualQty = qtyPerSide.lessThan(MIN_QTY) ? MIN_QTY : qtyPerSide;

      this.logger.info(
        `Using ${pairsCount} pairs. ${actualQty} BTC per side (~${actualQty
          .times(referencePrice)
          .toFixed(2)} USD)`
      );

      // Build desired pairs (single buy+sell per enabled tier, using edge offsets)
      type PairSpec = { tier: number; buyPrice: Decimal; sellPrice: Decimal };
      const desiredPairs: PairSpec[] = [];

      if (this.ordersTier1 > 0) {
        const offset = new Decimal(config.TIER1_OFFSET);
        desiredPairs.push({
          tier: 1,
          buyPrice: referencePrice.times(new Decimal(1).minus(offset)),
          sellPrice: referencePrice.times(new Decimal(1).plus(offset)),
        });
      }

      if (this.ordersTier2 > 0) {
        const offset = new Decimal(config.TIER2_OFFSET);
        desiredPairs.push({
          tier: 2,
          buyPrice: referencePrice.times(new Decimal(1).minus(offset)),
          sellPrice: referencePrice.times(new Decimal(1).plus(offset)),
        });
      }

      if (this.ordersTier3 > 0) {
        const offset = new Decimal(config.TIER3_OFFSET);
        desiredPairs.push({
          tier: 3,
          buyPrice: referencePrice.times(new Decimal(1).minus(offset)),
          sellPrice: referencePrice.times(new Decimal(1).plus(offset)),
        });
      }

      // Ensure price uniqueness (avoid placing two very close orders after rounding)
      const minTick = new Decimal(config.MIN_PRICE_TICK_USD?.toString() || "0.01"); // minimum price step (USD cents)
      const seenBuyPrices = new Set<string>();
      const seenSellPrices = new Set<string>();

      for (const dp of desiredPairs) {
        // Adjust buy price downwards until unique (prefer tighter / higher buys)
        let buy = dp.buyPrice;
        let buyRounded = buy.toFixed(2);
        while (seenBuyPrices.has(buyRounded)) {
          buy = buy.minus(minTick);
          buyRounded = buy.toFixed(2);
        }
        seenBuyPrices.add(buyRounded);
        dp.buyPrice = buy;

        // Adjust sell price upwards until unique (prefer tighter / lower sells)
        let sell = dp.sellPrice;
        let sellRounded = sell.toFixed(2);
        while (seenSellPrices.has(sellRounded)) {
          sell = sell.plus(minTick);
          sellRounded = sell.toFixed(2);
        }
        seenSellPrices.add(sellRounded);
        dp.sellPrice = sell;

        // Ensure buy < sell with at least one minTick gap
        if (dp.buyPrice.greaterThanOrEqualTo(dp.sellPrice)) {
          dp.sellPrice = dp.buyPrice.plus(minTick);
          this.logger.warn(
            `Adjusted pair for tier ${dp.tier} to avoid crossing: buy=${dp.buyPrice.toFixed(2)} sell=${dp.sellPrice.toFixed(2)}`
          );
        }
      }

      // Reconcile existing orders: keep matching ones (within threshold) and cancel the rest
      const threshold = new Decimal("0.0001"); // 1 bps
      const matched = new Set<number>(); // indexes into desiredPairs that are satisfied

      const blockedPrices = new Set<string>();

      for (const o of openOrders) {
        const openPrice = new Decimal(o.price);
        const side: "buy" | "sell" = o.side;
        let foundIndex = -1;
        for (let i = 0; i < desiredPairs.length; i++) {
          if (matched.has(i)) continue;
          const dp = desiredPairs[i];
          if (
            side === "buy" &&
            openPrice
              .minus(dp.buyPrice)
              .abs()
              .dividedBy(dp.buyPrice)
              .lessThanOrEqualTo(threshold)
          ) {
            foundIndex = i;
            break;
          }
          if (
            side === "sell" &&
            openPrice
              .minus(dp.sellPrice)
              .abs()
              .dividedBy(dp.sellPrice)
              .lessThanOrEqualTo(threshold)
          ) {
            foundIndex = i;
            break;
          }
        }

        if (foundIndex >= 0) {
          matched.add(foundIndex);
          continue;
        }

        // not matched -> cancel it
        try {
          this.logger.info(`Cancelling non-matching order ${o.id} @ ${o.price}`);
          await this.client.cancelOrder(o.id, this.tradingPair);
          // Cancellation succeeded; nothing to block for this price
        } catch (e: any) {
          // Cancellation failed - mark rounded price as blocked to avoid placing too-close orders
          const rounded = new Decimal(o.price).toFixed(2);
          blockedPrices.add(rounded);
          this.logger.warn(`Failed to cancel order ${o.id}: ${e.message || e}. Price ${rounded} will be blocked.`);
        }
      }

      // Before placing missing pairs, ensure planned prices don't sit next to blocked prices (±minTick)
      const isBlockedNearby = (price: Decimal) => {
        const p = new Decimal(price);
        for (const b of Array.from(blockedPrices)) {
          const bp = new Decimal(b);
          if (
            p.minus(bp).abs().lessThanOrEqualTo(minTick)
          ) {
            return true;
          }
        }
        return false;
      };

      // Define official tier bands (relative to referencePrice) per docs
      const tierBands: { [k: number]: { min: Decimal; max: Decimal } } = {
        1: { min: new Decimal(0), max: new Decimal("0.001") }, // 0-10 bps
        2: { min: new Decimal("0.001"), max: new Decimal("0.003") }, // 10-30 bps
        3: { min: new Decimal("0.003"), max: new Decimal("0.01") }, // 30 bps - 1%
      };

      // Helper: check if an existing open order is within the tier band
      const isOrderInTierBand = (o: any, side: "buy" | "sell", tier: number) => {
        const band = tierBands[tier];
        const priceDec = new Decimal(o.price);
        let rel = new Decimal(0);
        if (side === "buy") {
          rel = referencePrice.minus(priceDec).dividedBy(referencePrice);
        } else {
          rel = priceDec.minus(referencePrice).dividedBy(referencePrice);
        }
        return rel.greaterThanOrEqualTo(band.min) && rel.lessThanOrEqualTo(band.max);
      };

      // Compute occupancy per tier per side based on existing openOrders
      const tierOccupied = new Map<number, { buy: boolean; sell: boolean }>();
      for (const dp of desiredPairs) {
        tierOccupied.set(dp.tier, { buy: false, sell: false });
      }

      for (const o of openOrders) {
        for (const dp of desiredPairs) {
          if (isOrderInTierBand(o, o.side, dp.tier)) {
            const v = tierOccupied.get(dp.tier)!;
            if (o.side === "buy") v.buy = true;
            else v.sell = true;
            tierOccupied.set(dp.tier, v);
          }
        }
      }

      const placePromises: Promise<any>[] = [];
      for (let i = 0; i < desiredPairs.length; i++) {
        if (matched.has(i)) continue; // already satisfied
        const dp = desiredPairs[i];

        // If this tier already has a buy (or sell) in the band, skip that side
        const occ = tierOccupied.get(dp.tier) || { buy: false, sell: false };
        if (occ.buy) this.logger.info(`Skipping buy for tier ${dp.tier} because band already occupied`);
        if (occ.sell) this.logger.info(`Skipping sell for tier ${dp.tier} because band already occupied`);

        // Adjust if buy is blocked or too close to a blocked price
        let buy = dp.buyPrice;
        if (!occ.buy) {
          while (isBlockedNearby(buy) || seenBuyPrices.has(buy.toFixed(2))) {
            buy = buy.minus(minTick);
          }
        }

        dp.buyPrice = buy;

        // Adjust if sell is blocked or too close to a blocked price
        let sell = dp.sellPrice;
        if (!occ.sell) {
          while (isBlockedNearby(sell) || seenSellPrices.has(sell.toFixed(2))) {
            sell = sell.plus(minTick);
          }
        }

        dp.sellPrice = sell;

        // After shifting, ensure buy < sell with at least one tick
        if (!occ.buy && !occ.sell && dp.buyPrice.greaterThanOrEqualTo(dp.sellPrice)) {
          this.logger.warn(
            `After avoiding blocked price for tier ${dp.tier}, buy >= sell. Skipping placing this pair: buy=${dp.buyPrice.toFixed(2)} sell=${dp.sellPrice.toFixed(2)}`
          );
          continue; // skip this pair to avoid risk
        }

        // Reserve the rounded prices to avoid collisions with later pairs in this cycle
        if (!occ.buy) seenBuyPrices.add(dp.buyPrice.toFixed(2));
        if (!occ.sell) seenSellPrices.add(dp.sellPrice.toFixed(2));

        // Place only sides that are not occupied
        if (!occ.buy) {
          this.logger.info(`Placing BUY for tier ${dp.tier} -> ${dp.buyPrice.toFixed(2)}`);
          placePromises.push(
            this.client.placeOrder(this.tradingPair, "buy", dp.buyPrice, actualQty)
          );
        }
        if (!occ.sell) {
          this.logger.info(`Placing SELL for tier ${dp.tier} -> ${dp.sellPrice.toFixed(2)}`);
          placePromises.push(
            this.client.placeOrder(this.tradingPair, "sell", dp.sellPrice, actualQty)
          );
        }
      }

      await Promise.all(placePromises);

      // Ensure at least one pair exists in 10 bps band (fallback)
      openOrders = await this.client.getOpenOrders(this.tradingPair);
      const within10bps = new Decimal("0.001");
      const hasBidWithin10bps = openOrders.some((o: any) =>
        o.side === "buy" &&
        new Decimal(o.price).minus(referencePrice).abs().dividedBy(referencePrice).lessThanOrEqualTo(within10bps)
      );
      const hasAskWithin10bps = openOrders.some((o: any) =>
        o.side === "sell" &&
        new Decimal(o.price).minus(referencePrice).abs().dividedBy(referencePrice).lessThanOrEqualTo(within10bps)
      );

      if (!hasBidWithin10bps || !hasAskWithin10bps) {
        this.logger.warn("No both-sides pair within 10 bps detected; placing a fallback tight pair.");
        const fbOffset = new Decimal(config.TIER1_OFFSET);
        const fbBuy = referencePrice.times(new Decimal(1).minus(fbOffset));
        const fbSell = referencePrice.times(new Decimal(1).plus(fbOffset));
        try {
          await this.client.placeOrder(this.tradingPair, "buy", fbBuy, actualQty);
          await this.client.placeOrder(this.tradingPair, "sell", fbSell, actualQty);
        } catch (e: any) {
          this.logger.error("Failed to place fallback pair:", e);
        }
      }

      this.logger.info("✅ Strategy cycle completed.");

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
