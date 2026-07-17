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
// 2. HARDCODED CONFIGURATION
// ==========================================
const botToken = '8824963965:AAFtESw6niqh7FsgGrKyUotv-5x8o0lqFLw';
const chatID = '7113872351';
const targetWalletAddress = '2AqFJzcgSMQ9v7Vwh4yE7Vux8brcrjus1eg4K1zM2zUd';
const wssUrl = 'wss://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';
const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';

// ==========================================
// 3. INITIALIZATION & CACHE
// ==========================================
const bot = new TelegramBot(botToken, { polling: false });
const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: wssUrl
});
const targetPublicKey = new PublicKey(targetWalletAddress);

// In-memory cache to prevent duplicate alerts/double-posting
const processedSignatures = new Set();

console.log(`🚀 Resilient Tracking active for: ${targetWalletAddress}`);

function formatAmount(amount) {
    const absAmount = Math.abs(amount);
    if (absAmount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (absAmount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (absAmount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return amount.toFixed(2);
}

async function getTokenMetadata(mintAddress) {
    if (!mintAddress || mintAddress === "Unknown" || mintAddress === "SOL") {
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

            // 1. Prevent duplicate logs from multiple instances/retries
            if (processedSignatures.has(signature)) {
                console.log(`⚠️ Duplicate signature blocked: ${signature}`);
                return;
            }
            processedSignatures.add(signature);
            if (processedSignatures.size > 100) {
                const first = processedSignatures.values().next().value;
                processedSignatures.delete(first); // Maintain memory cap of 100 sigs
            }

            console.log(`✨ Activity detected! Fetching transaction details...`);

            // Wait 2 full seconds to allow transaction propagation
            await new Promise(resolve => setTimeout(resolve, 2000));

            const tx = await connection.getParsedTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (!tx || !tx.meta) {
                console.log("⚠️ Could not parse transaction metadata.");
                return;
            }

            const preTokenBalances = tx.meta.preTokenBalances || [];
            const postTokenBalances = tx.meta.postTokenBalances || [];
            
            // Collect ALL involved token mints
            const involvedMints = new Set();
            preTokenBalances.forEach(p => { if (p.owner === targetWalletAddress) involvedMints.add(p.mint); });
            postTokenBalances.forEach(p => { if (p.owner === targetWalletAddress) involvedMints.add(p.mint); });
            
            // Filter out wrapped SOL so we treat SOL tracking natively and cleanly
            involvedMints.delete('So11111111111111111111111111111111111111112');

            // Calculate exact balance changes for every meme coin involved
            const tokenChanges = [];
            for (const mint of involvedMints) {
                const pre = preTokenBalances.find(p => p.mint === mint && p.owner === targetWalletAddress);
                const post = postTokenBalances.find(p => p.mint === mint && p.owner === targetWalletAddress);

                const preAmount = pre ? (pre.uiTokenAmount.uiAmount || 0) : 0;
                const postAmount = post ? (post.uiTokenAmount.uiAmount || 0) : 0;
                const change = postAmount - preAmount;

                if (Math.abs(change) > 0) {
                    tokenChanges.push({ mint, change });
                }
            }

            // Calculate SOL Change
            let solChange = 0;
            const postBalancesSol = tx.meta.postBalances || [];
            const preBalancesSol = tx.meta.preBalances || [];
            const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey ? k.pubkey.toString() : k.toString());
            const targetIndex = accountKeys.indexOf(targetWalletAddress);

            if (targetIndex !== -1) {
                const preSol = preBalancesSol[targetIndex] || 0;
                const postSol = postBalancesSol[targetIndex] || 0;
                solChange = (postSol - preSol) / 1e9;
            }

            // Skip transaction if there is no asset movement of any kind
            if (tokenChanges.length === 0 && Math.abs(solChange) <= 0.005) {
                console.log("ℹ️ Skipping minor fee transaction.");
                return;
            }

            let alertMessage = "";
            const solscanUrl = `https://solscan.io/tx/${signature}`;

            // Case A: SPL Token Trade (DEX Swap, Transfer, Buy, Sell)
            if (tokenChanges.length > 0) {
                // We'll highlight the first changed token as the primary event asset
                const primaryToken = tokenChanges[0];
                const meta = await getTokenMetadata(primaryToken.mint);
                const tokenName = meta.name;
                const tokenSymbol = meta.symbol;

                const actionType = primaryToken.change > 0 ? "BUY DETECTED" : "SELL DETECTED";
                const actionEmoji = primaryToken.change > 0 ? "🟢" : "🔴";
                const dexscreenerUrl = `https://dexscreener.com/solana/${primaryToken.mint}`;

                alertMessage = `
${actionEmoji} **${actionType}!** ${actionEmoji}

👤 **Wallet:** \`${targetWalletAddress.substring(0, 6)}...${targetWalletAddress.substring(targetWalletAddress.length - 4)}\`
🪙 **Token:** **${tokenName}** ${tokenSymbol ? `(${tokenSymbol})` : ''}
💰 **Amount:** \`${formatAmount(primaryToken.change)} ${tokenSymbol}\`
💊 **Token CA:** \`${primaryToken.mint}\`
⛽ **SOL Value:** \`${solChange > 0 ? '+' : ''}${solChange.toFixed(4)} SOL\`

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
                `;
            } 
            // Case B: Pure SOL Transaction (No tokens involved)
            else {
                const actionType = solChange > 0 ? "SOL RECEIVED" : "SOL SENT";
                const actionEmoji = solChange > 0 ? "📥" : "📤";

                alertMessage = `
${actionEmoji} **${actionType}!** ${actionEmoji}

👤 **Wallet:** \`${targetWalletAddress.substring(0, 6)}...${targetWalletAddress.substring(targetWalletAddress.length - 4)}\`
🪙 **Token:** **Solana (SOL)**
💰 **Amount:** \`${formatAmount(solChange)} SOL\`
💊 **Token CA:** \`Native SOL Asset\`

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](https://dexscreener.com/solana/)
                `;
            }

            await bot.sendMessage(chatID, alertMessage, { 
                parse_mode: 'Markdown', 
                disable_web_page_preview: true 
            });
            
            console.log(`✅ Alert processed for transaction: ${signature}`);
        } catch (error) {
            console.error('❌ Error executing transaction alert:', error);
        }
    },
    'confirmed'
);
