/// <reference types="bun-types" />
// scripts/manual-login.ts
import { serve } from "bun";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import axios from "axios";

// api 路由
const SIGN_API_URL = "http://localhost:3000/api/sign";

// 1. 生成临时的 Ed25519 密钥对 (Bot Session Key)
// 我们需要将这个 Key 保存并输出给用户，因为 Bot 需要用它来签名请求
const privateKey = ed25519.utils.randomSecretKey();
const sessionPrivateKeyHex = Buffer.from(privateKey).toString('hex');
const publicKey = ed25519.getPublicKey(privateKey);
const requestId = base58.encode(publicKey); // Step 1: requestId (Public Key)

console.log("\n==================================================");
console.log("   STANDX BOT - MANUAL LOGIN WIZARD (NO PRIVATE KEY)");
console.log("==================================================");
console.log("1. Open http://localhost:3000 in your browser.");
console.log("2. Connect your Binance Web3 Wallet (via WalletConnect).");
console.log("3. Click 'Sign Login Message'.");
console.log("4. The bot will automatically capture the token.");
console.log("==================================================\n");

// State
let signDataState: {
  signedData: string;
  message: string;
  chain: string;
} | null = null;
const CHAIN = "bsc";

const server = serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // Endpoint: 前端获取要签名的消息
    if (url.pathname === "/api/prepare-login" && req.method === "POST") {
      const body = (await req.json()) as { address: string };
      const address = body.address;

      console.log(`[Server] Preparing login for wallet: ${address}`);

      try {
        // Call StandX API to get the message
        const response = await axios.post(
          `https://api.standx.com/v1/offchain/prepare-signin?chain=${CHAIN}`,
          {
            address: address,
            requestId: requestId,
          }
        );

        if (!response.data.success) throw new Error("API Error");

        // 解析 JWT 获取 message
        const signedData = response.data.signedData;
        const payload = JSON.parse(
          Buffer.from(signedData.split(".")[1], "base64").toString()
        );

        signDataState = {
          signedData: signedData,
          message: payload.message,
          chain: CHAIN,
        };

        return new Response(
          JSON.stringify({
            success: true,
            message: payload.message,
          })
        );
      } catch (e: any) {
        console.error("StandX API Error:", e.message);
        return new Response(
          JSON.stringify({ success: false, error: e.message }),
          { status: 500 }
        );
      }
    }

    // Endpoint: 前端提交签名
    if (url.pathname === "/api/submit-signature" && req.method === "POST") {
      const body = (await req.json()) as { signature: string };
      const signature = body.signature;

      if (!signDataState)
        return new Response("Session expired", { status: 400 });

      console.log(`[Server] Received signature! Logging in...`);

      try {
        // Call StandX API to Login
        const loginResp = await axios.post(
          `https://api.standx.com/v1/offchain/login?chain=${CHAIN}`,
          {
            signature: signature,
            signedData: signDataState.signedData,
            expiresSeconds: 604800, // 7 Days
          }
        );

        const token = loginResp.data.token;
        console.log("\n✅ LOGIN SUCCESS!");
        console.log("--------------------------------------------------");
        console.log("Add these lines to your .env file:\n");
        console.log(`ACCESS_TOKEN=${token}`);
        console.log(`SESSION_PRIVATE_KEY=${sessionPrivateKeyHex}`);
        console.log("\n--------------------------------------------------");
        console.log("You can now run 'bun run src/index.ts'");

        // 自动关闭
        setTimeout(() => process.exit(0), 2000);

        return new Response(JSON.stringify({ success: true }));
      } catch (e: any) {
        console.error("Login Failed:", e.message);
        return new Response(
          JSON.stringify({ success: false, error: e.message }),
          { status: 500 }
        );
      }
    }

    // Serve HTML
    return new Response(
      `
    <!DOCTYPE html>
    <html>
    <head>
        <title>StandX Bot Login</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script type="module">
            import { createWeb3Modal, defaultWagmiConfig } from 'https://esm.sh/@web3modal/wagmi@5.0.0?bundle';
            import { bsc } from 'https://esm.sh/viem@2.0.0/chains';
            import { reconnect, watchAccount, signMessage, disconnect } from 'https://esm.sh/@wagmi/core@2.0.0?bundle';

            // 这是一个公开的测试用 Project ID，生产环境建议换成你自己的
            const projectId = '3fcc6bba6f1de962d911bb5b5c3dba68'; 

            const metadata = {
                name: 'StandX Bot',
                description: 'Login StandX Bot',
                url: 'http://localhost:3000',
                icons: ['https://avatars.githubusercontent.com/u/37784886']
            }

            const chains = [bsc];
            const config = defaultWagmiConfig({ chains, projectId, metadata });

            const modal = createWeb3Modal({
                wagmiConfig: config,
                projectId,
                enableAnalytics: true 
            });

            async function init() {
                const connectBtn = document.getElementById('connectBtn');
                const signBtn = document.getElementById('signBtn');
                const statusDiv = document.getElementById('status');
                
                let userAddress = null;

                watchAccount(config, {
                    onChange(account) {
                        if (account.isConnected) {
                            userAddress = account.address;
                            statusDiv.innerText = 'Connected: ' + userAddress;
                            connectBtn.style.display = 'none';
                            signBtn.style.display = 'block';
                        } else {
                            userAddress = null;
                            statusDiv.innerText = 'Not Connected';
                            connectBtn.style.display = 'block';
                            signBtn.style.display = 'none';
                        }
                    }
                });
                
                connectBtn.onclick = () => modal.open();

                signBtn.onclick = async () => {
                    if(!userAddress) return;
                    statusDiv.innerText = 'Preparing login message...';
                    
                    try {
                        // 1. Get Message from our local server (which gets it from StandX)
                        const prepRes = await fetch('/api/prepare-login', {
                            method: 'POST',
                            body: JSON.stringify({ address: userAddress })
                        });
                        const prepData = await prepRes.json();
                        
                        if(!prepData.success) throw new Error(prepData.error);

                        const message = prepData.message;
                        statusDiv.innerText = 'Please sign the message in your wallet...';

                        // 2. Request Signature
                        const signature = await signMessage(config, { message });
                        
                        statusDiv.innerText = 'Signature obtained! Logging in...';

                        // 3. Send back to server
                        const loginRes = await fetch('/api/submit-signature', {
                            method: 'POST',
                            body: JSON.stringify({ signature })
                        });
                        const loginData = await loginRes.json();

                        if(loginData.success) {
                            statusDiv.innerHTML = '<b style="color:green">SUCCESS! Check your terminal for the Token.</b>';
                        } else {
                            throw new Error(loginData.error);
                        }
                    } catch(e) {
                         statusDiv.innerText = 'Error: ' + e.message;
                         console.error(e);
                    }
                };
            }
            init();
        </script>
        <style>
            body { font-family: sans-serif; text-align: center; padding: 50px; }
            button { padding: 15px 30px; font-size: 18px; cursor: pointer; margin-top: 20px;}
            #status { margin-top: 20px; color: #666; }
        </style>
    </head>
    <body>
        <h1>StandX Bot Login</h1>
        <p>Use your Binance Web3 Wallet (via WalletConnect) to authorize the bot.</p>
        <div id="status">Waiting for connection...</div>
        <button id="connectBtn">Connect Wallet</button>
        <button id="signBtn" style="display:none">Sign Login Message</button>
    </body>
    </html>
    `,
      {
        headers: { "Content-Type": "text/html" },
      }
    );
  },
});
