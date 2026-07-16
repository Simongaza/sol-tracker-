const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');

// ==========================================
// 1. DUMMY SERVER FOR RENDER (Keeps Free Tier Alive)
// ==========================================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Solana Tracker Bot is running!\n');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`📡 Port bound successfully on port ${PORT}`);
});

// ==========================================
// 2. HARDCODED CONFIGURATION (No Env Vars Needed!)
// ==========================================
const botToken = '8824963965:AAFtESw6niqh7FsgGrKyUotv-5x8o0lqFLw';
const chatID = '7113872351';
const targetWalletAddress = '2AqFJzcgSMQ9v7Vwh4yE7Vux8brcrjus1eg4K1zM2zUd';
const wssUrl = 'wss://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';
const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';

// ==========================================
// 3. INITIALIZATION
// ==========================================
const bot = new TelegramBot(botToken, { polling: false });
const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: wssUrl
});
const targetPublicKey = new PublicKey(targetWalletAddress);

console.log(`🚀 Tracking started for wallet: ${targetWalletAddress}`);
console.log(`📡 Connected to Helius nodes...`);

function formatAmount(amount) {
    const absAmount = Math.abs(amount);
    if (absAmount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (absAmount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (absAmount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return amount.toFixed(2);
}

// Fetches real Token Names and Symbols instead of displaying "Unknown" or raw CAs
async function getTokenMetadata(mintAddress) {
    if (!mintAddress || mintAddress === "Unknown" || mintAddress === "Native SOL Asset") {
        return { name: "Solana", symbol: "SOL" };
    }
    try {
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'token-name-lookup',
                method: 'getAsset',
                params: { id: mintAddress }
            })
        });
        const { result } = await response.json();
        if (result && result.content && result.content.metadata) {
            return {
                name: result.content.metadata.name || "Unknown Token",
                symbol: result.content.metadata.symbol || "UNKNOWN"
            };
        }
    } catch (e) {
        console.error("❌ Failed to fetch token metadata:", e);
    }
    return { name: "Unknown Token", symbol: "UNKNOWN" };
}

// ==========================================
// 4. REAL-TIME BLOCKCHAIN LISTENER
// ==========================================
connection.onLogs(
    targetPublicKey,
    async (logs, context) => {
        try {
            const signature = logs.signature;
            if (!signature) return;

            console.log(`✨ Activity detected! Fetching transaction details...`);

            await new Promise(resolve => setTimeout(resolve, 1500));

            const tx = await connection.getParsedTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (!tx || !tx.meta) {
                console.log("⚠️ Could not parse transaction metadata.");
                return;
            }

            const preBalances = tx.meta.preTokenBalances || [];
            const postBalances = tx.meta.postTokenBalances || [];

            let tokenMint = "Unknown";
            let tokenAmountChange = 0;
            let actionType = "TRANSACTION";
            let actionEmoji = "⚡";

            // 1. EXACT TOKEN CHECK (Your working logic)
            postBalances.forEach(post => {
                if (post.owner === targetWalletAddress && post.mint !== 'So11111111111111111111111111111111111111112') {
                    const pre = preBalances.find(p => p.mint === post.mint && p.owner === targetWalletAddress);
                    const preAmount = pre ? pre.uiTokenAmount.uiAmount : 0;
                    const postAmount = post.uiTokenAmount.uiAmount;
                    const change = postAmount - preAmount;
                    if (change !== 0) {
                        tokenMint = post.mint;
                        tokenAmountChange = change;
                    }
                }
            });

            // 2. TOKEN SOLD OUT CHECK (Your working logic)
            if (tokenAmountChange === 0) {
                preBalances.forEach(pre => {
                    if (pre.owner === targetWalletAddress && pre.mint !== 'So11111111111111111111111111111111111111112') {
                        const post = postBalances.find(p => p.mint === pre.mint && p.owner === targetWalletAddress);
                        if (!post) {
                            tokenMint = pre.mint;
                            tokenAmountChange = -pre.uiTokenAmount.uiAmount;
                        }
                    }
                });
            }

            // 3. FALLBACK TO NATIVE SOL CHECK (If no SPL Token changed)
            let isSolTx = false;
            if (tokenAmountChange === 0) {
                const postBalancesSol = tx.meta.postBalances || [];
                const preBalancesSol = tx.meta.preBalances || [];
                const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey ? k.pubkey.toString() : k.toString());
                const targetIndex = accountKeys.indexOf(targetWalletAddress);

                if (targetIndex !== -1) {
                    const preSol = preBalancesSol[targetIndex] || 0;
                    const postSol = postBalancesSol[targetIndex] || 0;
                    const solChange = (postSol - preSol) / 1e9;

                    // Filter out standard transaction fees (anything less than 0.005 SOL)
                    if (Math.abs(solChange) > 0.005) {
                        tokenAmountChange = solChange;
                        tokenMint = "Native SOL Asset";
                        isSolTx = true;
                    }
                }
            }

            // If no actual asset movement happened, quit early
            if (tokenAmountChange === 0) {
                console.log("ℹ️ Skipping non-asset movement log.");
                return;
            }

            // Get token names instead of raw output
            const meta = await getTokenMetadata(tokenMint);
            const tokenName = meta.name;
            const tokenSymbol = meta.symbol;

            // Determine Action and Emojis
            if (isSolTx) {
                if (tokenAmountChange > 0) {
                    actionType = "SOL RECEIVED";
                    actionEmoji = "📥";
                } else {
                    actionType = "SOL SENT";
                    actionEmoji = "📤";
                }
            } else {
                if (tokenAmountChange > 0) {
                    actionType = "BUY DETECTED";
                    actionEmoji = "🟢";
                } else {
                    actionType = "SELL DETECTED";
                    actionEmoji = "🔴";
                }
            }

            const solscanUrl = `https://solscan.io/tx/${signature}`;
            const dexscreenerUrl = tokenMint !== "Native SOL Asset" 
                ? `https://dexscreener.com/solana/${tokenMint}` 
                : `https://dexscreener.com/solana/`;

            const displayAmount = isSolTx ? `${formatAmount(tokenAmountChange)} SOL` : `${formatAmount(tokenAmountChange)} ${tokenSymbol}`;

            const alertMessage = `
${actionEmoji} **${actionType}!** ${actionEmoji}

👤 **Wallet:** \`${targetWalletAddress.substring(0, 6)}...${targetWalletAddress.substring(targetWalletAddress.length - 4)}\`
🪙 **Token:** **${tokenName}** ${tokenSymbol ? `(${tokenSymbol})` : ''}
💰 **Amount:** \`${displayAmount}\`
💊 **Token CA:** \`${tokenMint}\`

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
            `;

            await bot.sendMessage(chatID, alertMessage, { 
                parse_mode: 'Markdown', 
                disable_web_page_preview: true 
            });
            
            console.log(`✅ ${actionType} alert sent successfully!`);
        } catch (error) {
            console.error('❌ Error executing transaction alert:', error);
        }
    },
    'confirmed'
);
