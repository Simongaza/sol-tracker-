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
// 3. INITIALIZATION
// ==========================================
const bot = new TelegramBot(botToken, { polling: false });
const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: wssUrl
});
const targetPublicKey = new PublicKey(targetWalletAddress);

console.log(`🚀 Advanced Tracking started for wallet: ${targetWalletAddress}`);

function formatAmount(amount) {
    const absAmount = Math.abs(amount);
    if (absAmount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (absAmount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (absAmount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return amount.toFixed(4);
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

            console.log(`✨ Activity detected! Fetching transaction details...`);

            // Wait 2 seconds to ensure the block transaction is fully indexed
            await new Promise(resolve => setTimeout(resolve, 2000));

            const tx = await connection.getParsedTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (!tx || !tx.meta) {
                console.log("⚠️ Could not parse transaction metadata.");
                return;
            }

            // Track changes in Native SOL
            const postBalancesSol = tx.meta.postBalances || [];
            const preBalancesSol = tx.meta.preBalances || [];
            const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey ? k.pubkey.toString() : k.toString());
            const targetIndex = accountKeys.indexOf(targetWalletAddress);

            let solChange = 0;
            if (targetIndex !== -1) {
                const preSol = preBalancesSol[targetIndex] || 0;
                const postSol = postBalancesSol[targetIndex] || 0;
                solChange = (postSol - preSol) / 1e9;
            }

            // Track Token changes (SPL Tokens)
            const preBalances = tx.meta.preTokenBalances || [];
            const postBalances = tx.meta.postTokenBalances || [];

            let tokenMint = "Unknown";
            let tokenAmountChange = 0;

            // Map all tokens involved for our target wallet
            const targetTokens = new Set();
            preBalances.forEach(p => { if (p.owner === targetWalletAddress) targetTokens.add(p.mint); });
            postBalances.forEach(p => { if (p.owner === targetWalletAddress) targetTokens.add(p.mint); });

            // Remove wrapped SOL from target token checks
            targetTokens.delete('So11111111111111111111111111111111111111112');

            // Calculate exact balance adjustments across all found tokens
            for (const mint of targetTokens) {
                const preObj = preBalances.find(p => p.mint === mint && p.owner === targetWalletAddress);
                const postObj = postBalances.find(p => p.mint === mint && p.owner === targetWalletAddress);

                const preAmount = preObj ? preObj.uiTokenAmount.uiAmount : 0;
                const postAmount = postObj ? postObj.uiTokenAmount.uiAmount : 0;
                const change = postAmount - preAmount;

                if (change !== 0) {
                    tokenMint = mint;
                    tokenAmountChange = change;
                    break; // Handle the primary altered token in this tx event
                }
            }

            let actionType = "TRANSACTION";
            let actionEmoji = "⚡";
            let displayAmount = "0.00";
            let tokenName = "Unknown";
            let tokenSymbol = "";
            let targetMintOutput = tokenMint;

            if (tokenAmountChange !== 0) {
                const meta = await getTokenMetadata(tokenMint);
                tokenName = meta.name;
                tokenSymbol = meta.symbol;
                displayAmount = `${formatAmount(tokenAmountChange)} ${tokenSymbol}`;

                if (tokenAmountChange > 0) {
                    actionType = "BUY DETECTED";
                    actionEmoji = "🟢";
                } else {
                    actionType = "SELL DETECTED";
                    actionEmoji = "🔴";
                }
            } else if (Math.abs(solChange) > 0.005) { // Filter out standard transaction/gas fees
                tokenName = "Solana";
                tokenSymbol = "SOL";
                targetMintOutput = "Native SOL Asset";
                displayAmount = `${formatAmount(solChange)} SOL`;

                if (solChange > 0) {
                    actionType = "SOL RECEIVED";
                    actionEmoji = "📥";
                } else {
                    actionType = "SOL SENT";
                    actionEmoji = "📤";
                }
            } else {
                console.log("ℹ️ Skipping minor network maintenance or non-asset movement log.");
                return;
            }

            const solscanUrl = `https://solscan.io/tx/${signature}`;
            const dexscreenerUrl = tokenMint !== "Unknown" ? `https://dexscreener.com/solana/${tokenMint}` : `https://dexscreener.com/solana/`;

            const alertMessage = `
${actionEmoji} **${actionType}!** ${actionEmoji}

👤 **Wallet:** \`${targetWalletAddress.substring(0, 6)}...${targetWalletAddress.substring(targetWalletAddress.length - 4)}\`
🪙 **Token:** **${tokenName}** ${tokenSymbol ? `(${tokenSymbol})` : ''}
💰 **Amount:** \`${displayAmount}\`
💊 **Token CA:** \`${targetMintOutput}\`

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
            `;

            await bot.sendMessage(chatID, alertMessage, { 
                parse_mode: 'Markdown', 
                disable_web_page_preview: true 
            });
            
            console.log(`✅ Sent alert for ${tokenName} (${displayAmount})`);
        } catch (error) {
            console.error('❌ Error executing transaction alert:', error);
        }
    },
    'confirmed'
);
