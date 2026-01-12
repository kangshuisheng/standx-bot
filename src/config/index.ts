import { z } from "zod";
import Decimal from "decimal.js";

const configSchema = z.object({
  WALLET_PRIVATE_KEY: z.string().optional(),
  ACCESS_TOKEN: z.string().optional(),
  SESSION_PRIVATE_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  CHAIN: z.literal("bsc").default("bsc"),
  SYMBOL: z.string().default("BTC-USD"),
  SPREAD: z
    .string()
    .or(z.number())
    .transform((v) => new Decimal(v)),
  ORDER_SIZE_USD: z
    .string()
    .or(z.number())
    .transform((v) => new Decimal(v)),
  MAX_INVENTORY_USD: z
    .string()
    .or(z.number())
    .transform((v) => new Decimal(v)),
  // 多层挂单配置：按照 StandX 官方积分档位优化分布
  // 0-10bps (0-0.1%): 100% 积分
  // 10-30bps (0.1%-0.3%): 50% 积分
  // 30bps-1% (0.3%-1%): 10% 积分
  // 每个档位默认挂1对订单（买+卖），放在档位边缘避免成交
  ORDERS_TIER1: z.number().default(1), // 在 100% 积分区挂单数（每侧）- 最近，保守
  ORDERS_TIER2: z.number().default(3), // 在 50% 积分区挂单数（每侧）- 较安全，多挂
  ORDERS_TIER3: z.number().default(3), // 在 10% 积分区挂单数（每侧）- 最安全，多挂
  // 新增可配置项：Tier 行为与下单保护
  TIER1_SINGLE_ORDER: z.boolean().default(true), // 是否在 Tier1 只挂单对 (买1/卖1)
  TIER1_OFFSET_BPS: z.number().default(7), // Tier1 偏移（单位：bps），默认 7 bps (0.0007)
  TIER1_TTL_SEC: z.number().default(5), // Tier1 订单停留时间（秒）
  TIER2_TTL_SEC: z.number().default(25), // Tier2 TTL（秒）
  TIER3_TTL_SEC: z.number().default(60), // Tier3 TTL（秒）
  ORDER_RETRY_LIMIT: z.number().default(2), // 单笔下单重试次数
  ORDER_RATE_LIMIT: z.number().default(10), // 每周期最大下单数（防护）
  EXECUTION_INTERVAL: z.number().default(5000),
});

// 加载环境变量
const env = {
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
  ACCESS_TOKEN: process.env.ACCESS_TOKEN,
  SESSION_PRIVATE_KEY: process.env.SESSION_PRIVATE_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  CHAIN: process.env.CHAIN,
  SYMBOL: process.env.TRADING_PAIR || process.env.SYMBOL || "BTC-USD",
  SPREAD: process.env.SPREAD || "0.002",
  ORDER_SIZE_USD: process.env.ORDER_SIZE_USD || process.env.ORDER_SIZE || "600",
  MAX_INVENTORY_USD:
    process.env.MAX_INVENTORY_USD || process.env.MAX_POSITION || "1000",
  ORDERS_TIER1: process.env.ORDERS_TIER1
    ? parseInt(process.env.ORDERS_TIER1)
    : 1,
  ORDERS_TIER2: process.env.ORDERS_TIER2
    ? parseInt(process.env.ORDERS_TIER2)
    : 3,
  ORDERS_TIER3: process.env.ORDERS_TIER3
    ? parseInt(process.env.ORDERS_TIER3)
    : 3,
  TIER1_SINGLE_ORDER: process.env.TIER1_SINGLE_ORDER
    ? process.env.TIER1_SINGLE_ORDER.toLowerCase() === "true"
    : true,
  TIER1_OFFSET_BPS: process.env.TIER1_OFFSET_BPS
    ? parseInt(process.env.TIER1_OFFSET_BPS)
    : 7,
  TIER1_TTL_SEC: process.env.TIER1_TTL_SEC
    ? parseInt(process.env.TIER1_TTL_SEC)
    : 5,
  TIER2_TTL_SEC: process.env.TIER2_TTL_SEC
    ? parseInt(process.env.TIER2_TTL_SEC)
    : 25,
  TIER3_TTL_SEC: process.env.TIER3_TTL_SEC
    ? parseInt(process.env.TIER3_TTL_SEC)
    : 60,
  ORDER_RETRY_LIMIT: process.env.ORDER_RETRY_LIMIT
    ? parseInt(process.env.ORDER_RETRY_LIMIT)
    : 2,
  ORDER_RATE_LIMIT: process.env.ORDER_RATE_LIMIT
    ? parseInt(process.env.ORDER_RATE_LIMIT)
    : 10,
  EXECUTION_INTERVAL: process.env.EXECUTION_INTERVAL
    ? parseInt(process.env.EXECUTION_INTERVAL)
    : 5000,
};

const parsed = configSchema.safeParse(env);

if (!parsed.success) {
  console.error("Invalid configuration:", parsed.error.format());
  process.exit(1);
}

// 确保至少有一种认证方式
if (!parsed.data.WALLET_PRIVATE_KEY && !parsed.data.ACCESS_TOKEN) {
  console.error(
    "==============================================================="
  );
  console.error(" [CONFIGURATION ERROR]");
  console.error("");
  console.error(" You are using a BSC Web3 Wallet (No Private Key), but");
  console.error(" no ACCESS_TOKEN was found in your .env file.");
  console.error("");
  console.error(" PLEASE FOLLOW THESE STEPS:");
  console.error(" 1. Run the login helper: `bun run scripts/manual-login.ts`");
  console.error(" 2. Connect your wallet in the browser and sign the message.");
  console.error(
    " 3. Copy the ACCESS_TOKEN and SESSION_PRIVATE_KEY to your .env file."
  );
  console.error(
    "==============================================================="
  );
  process.exit(1);
}

export const config = {
  ...parsed.data,
  apiKey: "ignored",
};
