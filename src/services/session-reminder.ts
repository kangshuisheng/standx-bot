import fs from "fs";
import path from "path";
import { config } from "../config";
import { Logger } from "../utils/logger";

const logger = new Logger();
const STATE_FILE = path.resolve(process.cwd(), ".bot_state.json");

interface BotState {
  startAt: number;
  lastReminderAt?: number | null;
  lastAuthErrorAt?: number | null;
}

function loadState(): BotState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    const now = Date.now();
    const initial: BotState = { startAt: now, lastReminderAt: null };
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
    } catch (err) {}
    return initial;
  }
}

function saveState(state: BotState) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    logger.error("Failed to persist bot state:", e);
  }
}

export function startSessionReminder(sendMessage: (text: string) => Promise<void>) {
  const state = loadState();
  // ensure startAt exists
  if (!state.startAt) {
    state.startAt = Date.now();
    saveState(state);
  }

  const interval = config.SESSION_REMINDER_CHECK_INTERVAL_MS || 60 * 60 * 1000;
  const days = config.SESSION_REMINDER_DAYS ?? 5;
  const repeat = config.SESSION_REMINDER_REPEAT ?? false;

  const timer = setInterval(async () => {
    try {
      const now = Date.now();
      const elapsedDays = (now - state.startAt) / (24 * 60 * 60 * 1000);
      if ((state.lastReminderAt && !repeat) || elapsedDays < days) return;

      // Send reminder
      await sendMessage(
        `⚠️ Reminder: Bot uptime reached ${Math.floor(elapsedDays)} days. Please refresh your session / ACCESS_TOKEN and restart the bot.`
      );
      state.lastReminderAt = now;
      saveState(state);
    } catch (e: any) {
      logger.error("Session reminder failed:", e.message || e);
    }
  }, interval);

  // return stop handle
  return () => clearInterval(timer);
}
