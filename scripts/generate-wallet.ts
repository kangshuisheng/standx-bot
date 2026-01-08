import { ethers } from "ethers";

console.log("Generating new trading wallet...");
console.log("---------------------------------------------------");

const wallet = ethers.Wallet.createRandom();

console.log(`Address:     ${wallet.address}`);
console.log(`Private Key: ${wallet.privateKey}`);
console.log("---------------------------------------------------");
console.log("⚠️  IMPORTANT: ");
console.log(
  "1. Copy the 'Private Key' into your .env file as WALLET_PRIVATE_KEY."
);
console.log(
  "2. Transfer some trading funds (USDC/USDT) and Gas token (BNB) to the 'Address' above."
);
console.log("3. NEVER share this private key with anyone.");
