import { config } from "./config";
import { StandXClient } from "./services/standx-api";
import { MarketMakerStrategy } from "./strategies/market-maker";
import { Logger } from "./utils/logger";
import { Bot, InlineKeyboard } from "grammy";

const logger = new Logger();

// 初始化 Client
const standXClient = new StandXClient({
  privateKey: config.WALLET_PRIVATE_KEY,
  accessToken: config.ACCESS_TOKEN,
  sessionPrivateKey: config.SESSION_PRIVATE_KEY,
});

const marketMakerStrategy = new MarketMakerStrategy(
  standXClient,
  config.SYMBOL,
  config.SPREAD,
  config.ORDER_SIZE_USD,
  config.MAX_INVENTORY_USD,
  config.ORDERS_TIER1,
  config.ORDERS_TIER2,
  config.ORDERS_TIER3
);

// 全局状态
let isRunning = false;
let isExecuting = false; // 防止循环执行时被打断
let intervalId: ReturnType<typeof setInterval> | null = null;
let statusIntervalId: ReturnType<typeof setInterval> | null = null;
let cycleCount = 0;
let lastError: string | null = null;

// Telegram Bot（仅发送通知，不做 polling，避免 token 冲突）
const bot = config.TELEGRAM_BOT_TOKEN
  ? new Bot(config.TELEGRAM_BOT_TOKEN)
  : null;

// 发送 Telegram 消息
async function sendTelegramMessage(text: string, showButtons = false) {
  if (!bot || !config.TELEGRAM_CHAT_ID) return;

  try {
    const keyboard = new InlineKeyboard()
      .text(isRunning ? "🔴 停止" : "🟢 启动", isRunning ? "stop" : "start")
      .text("📊 状态", "status");

    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, text, {
      parse_mode: "HTML",
      reply_markup: showButtons ? keyboard : undefined,
    });
  } catch (e: any) {
    logger.error(`Telegram send failed: ${e.message}`);
  }
}

// 获取状态文本
function getStatusText(): string {
  return `
<b>🤖 StandX Liquidity Bot</b>

<b>状态:</b> ${isRunning ? "🟢 运行中" : "🔴 已停止"}
<b>交易对:</b> ${config.SYMBOL}
<b>Spread:</b> ${config.SPREAD.times(100).toFixed(2)}%
<b>单笔金额:</b> ${config.ORDER_SIZE_USD} USD
<b>最大持仓:</b> ${config.MAX_INVENTORY_USD} USD
<b>已执行周期:</b> ${cycleCount}
${lastError ? `\n<b>最近错误:</b> <code>${lastError}</code>` : ""}
`;
}

// 启动策略
async function startStrategy() {
  if (isRunning) {
    await sendTelegramMessage("⚠️ 机器人已在运行中！");
    return;
  }

  logger.info("🚀 Starting strategy...");
  isRunning = true;
  cycleCount = 0;
  lastError = null;

  const interval = config.EXECUTION_INTERVAL || 5000;

  intervalId = setInterval(async () => {
    if (isExecuting || !isRunning) return; // 防止重叠执行
    isExecuting = true;
    try {
      await marketMakerStrategy.execute();
      cycleCount++;
    } catch (e: any) {
      lastError = e.message;
      logger.error("Strategy execution error:", e);
    } finally {
      isExecuting = false;
    }
  }, interval);

  await sendTelegramMessage("🟢 <b>机器人已启动！</b>\n\n正在挂单赚取积分...");
}

// 停止策略
async function stopStrategy() {
  if (!isRunning) {
    await sendTelegramMessage("⚠️ 机器人未在运行！");
    return;
  }

  logger.warn("🛑 Stopping strategy...");

  // 先停止循环
  isRunning = false;

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  if (statusIntervalId) {
    clearInterval(statusIntervalId);
    statusIntervalId = null;
  }

  // 等待当前执行完成
  while (isExecuting) {
    logger.info("Waiting for current cycle to finish...");
    await new Promise((r) => setTimeout(r, 500));
  }

  // 撤销所有挂单
  try {
    logger.info("Cancelling all open orders...");
    await standXClient.cancelAllOrders(config.SYMBOL);
    logger.info("✅ All orders cancelled.");
    await sendTelegramMessage("🔴 <b>机器人已停止！</b>\n\n所有挂单已撤销。");
  } catch (e: any) {
    const errMsg = e.message || "Unknown error";
    logger.error(`Failed to cancel orders: ${errMsg}`);
    await sendTelegramMessage(
      `🔴 <b>机器人已停止！</b>\n\n⚠️ 撤单失败: <code>${errMsg}</code>\n\n请手动检查交易所！`
    );
  }
}

// 安全退出
let isCleaningUp = false;
async function cleanup() {
  if (isCleaningUp) return; // 防止重复调用
  isCleaningUp = true;

  logger.warn("🛑 Shutting down...");
  if (intervalId) clearInterval(intervalId);

  try {
    await standXClient.cancelAllOrders(config.SYMBOL);
    logger.info("✅ All orders cancelled on exit.");
  } catch (e) {
    logger.error("Failed to cancel orders on exit:", e);
  }

  if (bot) {
    try {
      await bot.api.sendMessage(
        config.TELEGRAM_CHAT_ID!,
        "⚠️ <b>机器人进程已退出</b>\n\n所有挂单已自动撤销。",
        { parse_mode: "HTML" }
      );
    } catch (e) {}
    bot.stop();
  }

  process.exit(0);
}

async function main() {
  logger.info("Starting StandX Liquidity Bot...");
  logger.info(`Trading Symbol: ${config.SYMBOL}`);
  logger.info(
    `Spread: ${config.SPREAD} (${config.SPREAD.times(100).toFixed(2)}%)`
  );
  const totalOrders = (config.ORDERS_TIER1 + config.ORDERS_TIER2 + config.ORDERS_TIER3) * 2;
  logger.info(`Order Distribution: Tier1=${config.ORDERS_TIER1}, Tier2=${config.ORDERS_TIER2}, Tier3=${config.ORDERS_TIER3} (Total: ${totalOrders} orders)`);

  // 监听退出信号
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("uncaughtException", async (err) => {
    logger.error("Uncaught exception:", err);
    lastError = err.message;
    await cleanup();
  });

  // 仅发送通知（无 polling），避免 token 冲突；启动时提示，并每小时播报一次状态
  if (bot) {
    await sendTelegramMessage("✅ <b>机器人已启动</b>\n\n策略已自动运行。", false);

    // 每小时发送一次状态播报
    statusIntervalId = setInterval(() => {
      sendTelegramMessage(getStatusText(), false).catch((e) =>
        logger.error("Failed to send hourly status:", e)
      );
    }, 60 * 60 * 1000);
  } else {
    logger.warn("⚠️ Telegram Bot not configured. Running in standalone mode.");
  }

  // 直接启动策略
  await startStrategy();
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
