// This file defines TypeScript types, including API response types and strategy parameter types.

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

export interface TradingPair {
  symbol: string;
  price: number;
  volume: number;
}

export interface StrategyParams {
  tradingPair: TradingPair;
  spread: number;
  orderSize: number;
  maxPosition: number;
}

export interface MarketMakerParams extends StrategyParams {
  depth: number;
  adjustmentFactor: number;
}
