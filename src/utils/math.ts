import { Decimal } from "decimal.js";

export function safeAdd(a: Decimal.Value, b: Decimal.Value): Decimal {
  return new Decimal(a).plus(b);
}

export function safeSubtract(a: Decimal.Value, b: Decimal.Value): Decimal {
  return new Decimal(a).minus(b);
}

export function safeMultiply(a: Decimal.Value, b: Decimal.Value): Decimal {
  return new Decimal(a).times(b);
}

export function safeDivide(a: Decimal.Value, b: Decimal.Value): Decimal {
  if (new Decimal(b).isZero()) {
    throw new Error("Division by zero is not allowed");
  }
  return new Decimal(a).dividedBy(b);
}

export function safeRound(
  value: Decimal.Value,
  precision: number = 2
): Decimal {
  return new Decimal(value).toDecimalPlaces(precision);
}
