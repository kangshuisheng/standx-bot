import { Decimal } from 'decimal.js';

export class Wallet {
    private balances: Record<string, Decimal>;

    constructor() {
        this.balances = {};
    }

    public getBalance(asset: string): Decimal {
        return this.balances[asset] || new Decimal(0);
    }

    public addFunds(asset: string, amount: Decimal): void {
        if (!this.balances[asset]) {
            this.balances[asset] = new Decimal(0);
        }
        this.balances[asset] = this.balances[asset].plus(amount);
    }

    public removeFunds(asset: string, amount: Decimal): boolean {
        if (!this.balances[asset] || this.balances[asset].lessThan(amount)) {
            return false;
        }
        this.balances[asset] = this.balances[asset].minus(amount);
        return true;
    }

    public transferFunds(asset: string, amount: Decimal, recipient: Wallet): boolean {
        if (this.removeFunds(asset, amount)) {
            recipient.addFunds(asset, amount);
            return true;
        }
        return false;
    }
}