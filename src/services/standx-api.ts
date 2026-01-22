import { Decimal } from "decimal.js";
import axios, { AxiosInstance } from "axios";
import { ethers } from "ethers";
import { base58 } from "@scure/base";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "../utils/logger";
import { ed25519 } from "@noble/curves/ed25519.js";
import { config } from "../config";

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
} 

// 只支持 BSC
export type Chain = "bsc";

interface SignedData {
  domain: string;
  uri: string;
  statement: string;
  version: string;
  chainId: number;
  nonce: string;
  address: string;
  requestId: string;
  issuedAt: string;
  message: string;
  exp: number;
  iat: number;
}

interface LoginResponse {
  token: string;
  address: string;
  alias: string;
  chain: string;
  perpsAlpha: boolean;
}

interface RequestSignatureHeaders {
  "x-request-sign-version": string;
  "x-request-id": string;
  "x-request-timestamp": string;
  "x-request-signature": string;
}

// API Base URL (Auth uses api.standx.com, Trading uses perps.standx.com)
const AUTH_BASE_URL = "https://api.standx.com";
const PERPS_BASE_URL = "https://perps.standx.com";

/**
 * 负责处理 API 认证逻辑
 */
class StandXAuth {
  private ed25519PrivateKey: Uint8Array;
  public ed25519PublicKey: Uint8Array;
  public requestId: string;
  private baseUrl: string;
  private logger: Logger;

  constructor(baseUrl: string, privateKeyInput?: string) {
    this.baseUrl = baseUrl;
    // 如果传入了私钥，则使用传入的；否则生成新的
    if (privateKeyInput) {
      // 尝试解析传入的私钥 (支持 Hex 或 Base64)
      try {
        if (privateKeyInput.length === 64) {
          this.ed25519PrivateKey = Buffer.from(privateKeyInput, "hex");
        } else {
          this.ed25519PrivateKey = Buffer.from(privateKeyInput, "base64");
        }
      } catch (e) {
        throw new Error("Invalid Session Private Key format");
      }
    } else {
      this.ed25519PrivateKey = ed25519.utils.randomSecretKey();
    }

    this.ed25519PublicKey = ed25519.getPublicKey(this.ed25519PrivateKey);
    // requestId 是 base58 编码的公钥
    this.requestId = base58.encode(this.ed25519PublicKey);
    this.logger = new Logger();
  }

  /**
   * 步骤 1 & 2: 准备登录，获取需要签名的 message
   */
  async prepareSignIn(chain: Chain, address: string): Promise<string> {
    try {
      const endpoint = `${this.baseUrl}/v1/offchain/prepare-signin?chain=${chain}`;
      const response = await axios.post(endpoint, {
        address,
        requestId: this.requestId,
      });

      if (!response.data.success) {
        throw new Error(response.data.message || "Failed to prepare sign-in");
      }
      return response.data.signedData; // 这里返回的是 JWT string
    } catch (error: any) {
      this.logger.error(
        "Auth prepareSignIn failed",
        error.response?.data || error
      );
      throw error;
    }
  }

  /**
   * 步骤 5: 如果上一步成功签名，用签名结果换取 Access Token
   */
  async login(
    chain: Chain,
    signature: string,
    signedData: string,
    expiresSeconds: number = 604800
  ): Promise<LoginResponse> {
    try {
      const endpoint = `${this.baseUrl}/v1/offchain/login?chain=${chain}`;
      const response = await axios.post(endpoint, {
        signature,
        signedData,
        expiresSeconds,
      });
      return response.data;
    } catch (error: any) {
      this.logger.error("Auth login failed", error.response?.data || error);
      throw error;
    }
  }

  /**
   * 解析 JWT Token 中的 Payload
   */
  parseJwt<T>(token: string): T {
    const base64Url = token.split(".")[1];
    if (!base64Url) throw new Error("Invalid JWT format");
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = Buffer.from(base64, "base64").toString("utf-8");
    return JSON.parse(jsonPayload);
  }

  /**
   * Body Signature Flow: 对 API 请求体进行签名
   */
  signRequest(
    payload: string,
    requestId: string,
    timestamp: number
  ): RequestSignatureHeaders {
    const version = "v1";
    // Build message to sign: "{version},{id},{timestamp},{payload}"
    const message = `${version},${requestId},${timestamp},${payload}`;

    const messageBytes = Buffer.from(message, "utf-8");
    const signature = ed25519.sign(messageBytes, this.ed25519PrivateKey);

    return {
      "x-request-sign-version": version,
      "x-request-id": requestId,
      "x-request-timestamp": timestamp.toString(),
      "x-request-signature": Buffer.from(signature).toString("base64"),
    };
  }
}

/**
 * 主要的 API 客户端
 */
export class StandXClient {
  private auth: StandXAuth;
  private wallet?: ethers.Wallet; // 修改为可选
  private chain: Chain;
  private baseUrl: string;
  private axiosInstance: AxiosInstance;
  private accessToken: string | null = null;
  private logger: Logger;

  constructor(config: {
    privateKey?: string;
    accessToken?: string;
    sessionPrivateKey?: string; // New: For restoring session key
    baseUrl?: string;
  }) {
    // Auth uses api.standx.com, Trading uses perps.standx.com
    this.baseUrl = config.baseUrl || PERPS_BASE_URL;
    this.chain = "bsc";
    // Pass sessionPrivateKey to Auth (Auth uses AUTH_BASE_URL)
    this.auth = new StandXAuth(AUTH_BASE_URL, config.sessionPrivateKey);
    this.logger = new Logger();

    if (config.privateKey) {
      this.wallet = new ethers.Wallet(config.privateKey);
    } else if (config.accessToken) {
      this.accessToken = config.accessToken;
      this.logger.info(
        "Initialized in Token-Only mode (MPC/No Private Key). Auto-relogin disabled."
      );
    } else {
      throw new Error(
        "StandXClient Init Error: Must provide either privateKey or accessToken."
      );
    }

    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "Content-Type": "application/json",
      },
      // 防止请求无限挂起导致策略循环卡死
      timeout: 15000,
    });

    // 添加请求拦截器，自动添加认证头
    this.axiosInstance.interceptors.request.use(async (config) => {
      if (this.accessToken) {
        const headers = (config.headers ??= {});
        headers.Authorization = `Bearer ${this.accessToken}`;

        // Sign ALL authenticated requests
        const payloadStr =
          typeof config.data === "string"
            ? config.data
            : JSON.stringify(config.data || ""); // Empty string for no body

        const requestId = uuidv4();
        const timestamp = Date.now();
        const signHeaders = this.auth.signRequest(
          payloadStr,
          requestId,
          timestamp
        );

        Object.entries(signHeaders).forEach(([key, value]) => {
          headers[key] = value;
        });
      }
      return config;
    });
  }

  /**
   * 执行完整的登录流程
   */
  public async authenticate() {
    if (!this.wallet) {
      this.logger.warn(
        "Skipping authentication: No private key provided (Token mode)."
      );
      return;
    }

    this.logger.info(
      `Starting authentication for address ${this.wallet.address}...`
    );

    // 1. 获取需签名的 JWT 数据
    const signedDataJwt = await this.auth.prepareSignIn(
      this.chain,
      this.wallet.address
    );

    // 2. 解析 JWT 拿到 message 字段
    const payload = this.auth.parseJwt<SignedData>(signedDataJwt);

    // 3. 使用钱包私钥签名消息
    const signature = await this.wallet.signMessage(payload.message);

    // 4. 发送签名，获取 Access Token
    const loginResponse = await this.auth.login(
      this.chain,
      signature,
      signedDataJwt
    );

    this.accessToken = loginResponse.token;
    this.logger.info("Authentication successful!");
  }

  /**
   * 通用请求方法
   */
  public async sendRequest(
    endpoint: string,
    method: "GET" | "POST" | "DELETE",
    data?: any
  ): Promise<any> {
    if (!this.accessToken) {
      if (this.wallet) {
        await this.authenticate();
      } else {
        throw new Error(
          "No Access Token provided and no private key available."
        );
      }
    }

    const maxAttempts = config.CANCEL_RETRY_COUNT ?? 3;
    const baseBackoff = config.CANCEL_RETRY_BACKOFF_MS ?? 500;
    const maxBackoff = config.CANCEL_RETRY_MAX_BACKOFF_MS ?? 5000;

    let attempt = 0;
    while (true) {
      try {
        const response = await this.axiosInstance.request({
          url: endpoint,
          method,
          data,
        });
        return response.data;
      } catch (error: any) {
        // 401 自动重试（仅在持有私钥时可重登）
        if (error.response?.status === 401) {
          if (this.wallet) {
            this.logger.info("Token expired or invalid, re-authenticating...");
            await this.authenticate();
            attempt++;
            if (attempt >= maxAttempts) {
              throw new Error("Re-auth failed after retries.");
            }
            continue; // retry the request after refresh
          } else {
            this.logger.error(
              "Access Token expired and no private key available."
            );
            throw new Error(
              "Access Token expired. Please run manual-login script again."
            );
          }
        }

        // 网络或超时等可重试错误
        attempt++;
        if (attempt >= maxAttempts) {
          throw new Error(`API request failed after ${attempt} attempts: ${error.message}`);
        }

        const backoff = Math.min(baseBackoff * 2 ** (attempt - 1), maxBackoff);
        this.logger.warn(
          `Request failed, retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts}) - ${error.message}`
        );
        await sleep(backoff);
      }
    }
  }

  /**
   * 获取市场价格信息 (Mark Price, Mid Price etc.)
   * GET /api/query_symbol_price
   */
  public async getSymbolPrice(symbol: string): Promise<any> {
    return this.sendRequest(`/api/query_symbol_price?symbol=${symbol}`, "GET");
  }

  /**
   * 获取深度/盘口
   * GET /api/query_depth_book
   */
  public async getOrderbook(symbol: string): Promise<any> {
    return this.sendRequest(`/api/query_depth_book?symbol=${symbol}`, "GET");
  }

  /**
   * 获取用户持仓
   * GET /api/query_positions
   */
  public async getPosition(symbol: string): Promise<Decimal> {
    try {
      const data = await this.sendRequest(
        `/api/query_positions?symbol=${symbol}`,
        "GET"
      );
      // Response is an array of positions
      const positions = Array.isArray(data) ? data : [];
      const pos = positions.find(
        (p: any) => p.symbol === symbol && p.status === "open"
      );
      return pos ? new Decimal(pos.qty) : new Decimal(0);
    } catch (e) {
      return new Decimal(0);
    }
  }

  /**
   * 获取所有挂单
   * GET /api/query_open_orders
   */
  public async getOpenOrders(symbol: string): Promise<any[]> {
    try {
      const data = await this.sendRequest(
        `/api/query_open_orders?symbol=${symbol}`,
        "GET"
      );
      return data.result || [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 下单
   * POST /api/new_order
   */
  public async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    price: Decimal,
    qty: Decimal
  ): Promise<void> {
    const payload = {
      symbol,
      side,
      order_type: "limit",
      qty: qty.toString(),
      price: price.toFixed(2), // Price should have 2 decimal places for BTC-USD
      time_in_force: "gtc",
      reduce_only: false,
    };
    this.logger.info(`Sending order: ${JSON.stringify(payload)}`);
    try {
      await this.sendRequest("/api/new_order", "POST", payload);
    } catch (e: any) {
      this.logger.error(`Order failed. Response: ${JSON.stringify(e.response?.data)}`);
      throw e;
    }
  }

  /**
   * 撤销单个订单
   * POST /api/cancel_order
   */
  public async cancelOrder(orderId: number, symbol?: string): Promise<void> {
    const maxAttempts = config.CANCEL_RETRY_COUNT ?? 3;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.sendRequest("/api/cancel_order", "POST", { order_id: orderId });
      } catch (e: any) {
        if (i === maxAttempts - 1) throw e;
        const backoff = Math.min(
          config.CANCEL_RETRY_BACKOFF_MS ?? 500 * 2 ** i,
          config.CANCEL_RETRY_MAX_BACKOFF_MS ?? 5000
        );
        this.logger.warn(`Cancel order ${orderId} failed, retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      // 如果提供了 symbol，则确认订单是否真的被撤销
      if (symbol) {
        const remaining = await this.getOpenOrders(symbol);
        const stillThere = remaining.find((o: any) => o.id === orderId);
        if (stillThere) {
          // 如果最后一次尝试仍然存在则抛出错误
          if (i === maxAttempts - 1) {
            throw new Error(`Order ${orderId} still exists after cancel attempts.`);
          }
          const backoff = Math.min(
            config.CANCEL_RETRY_BACKOFF_MS ?? 500 * 2 ** i,
            config.CANCEL_RETRY_MAX_BACKOFF_MS ?? 5000
          );
          this.logger.warn(`Order ${orderId} still present, retrying cancel in ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
      }

      return;
    }
  }

  /**
   * 撤销所有订单 (通过查询后逐个撤销)
   */
  public async cancelAllOrders(symbol: string): Promise<void> {
    let openOrders = await this.getOpenOrders(symbol);
    if (openOrders.length === 0) {
      this.logger.info("No open orders to cancel.");
      return;
    }

    const orderIds = openOrders.map((o: any) => o.id);

    const maxAttempts = config.CANCEL_RETRY_COUNT ?? 3;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.sendRequest("/api/cancel_orders", "POST", {
          order_id_list: orderIds,
        });
      } catch (e: any) {
        if (i === maxAttempts - 1) throw e;
        const backoff = Math.min(
          config.CANCEL_RETRY_BACKOFF_MS ?? 500 * 2 ** i,
          config.CANCEL_RETRY_MAX_BACKOFF_MS ?? 5000
        );
        this.logger.warn(`Batch cancel failed, retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      // verify
      openOrders = await this.getOpenOrders(symbol);
      if (openOrders.length === 0) {
        this.logger.info("Cancelled all open orders.");
        return;
      }

      // If still present and last attempt, throw
      if (i === maxAttempts - 1) {
        throw new Error(`Failed to cancel all orders: ${openOrders.length} remaining.`);
      }

      const backoff = Math.min(
        config.CANCEL_RETRY_BACKOFF_MS ?? 500 * 2 ** i,
        config.CANCEL_RETRY_MAX_BACKOFF_MS ?? 5000
      );
      this.logger.warn(`Some orders still present, retrying batch cancel in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}
