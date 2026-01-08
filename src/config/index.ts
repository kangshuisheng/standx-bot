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
  SPREAD: process.env.SPREAD || "0.001",
  ORDER_SIZE_USD: process.env.ORDER_SIZE_USD || process.env.ORDER_SIZE || "10",
  MAX_INVENTORY_USD:
    process.env.MAX_INVENTORY_USD || process.env.MAX_POSITION || "300",
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
