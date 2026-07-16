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
// Using HTTP RPC for fetching tx details and WebSocket for logs
const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: wssUrl
});
const targetPublicKey = new PublicKey(targetWalletAddress);

console.log(`🚀 Tracking started for wallet: ${targetWalletAddress}`);
console.log(`📡 Connected to Helius nodes...`);

// Helper function to format large numbers (e.g., 171660000 -> 171.66M)
function formatAmount(amount) {
    const absAmount = Math.abs(amount);
    if (absAmount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (absAmount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (absAmount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return amount.toFixed(2);
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

            // Wait 1.5 seconds to make sure the transaction is fully indexed on-chain
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Fetch transaction details
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

            // Find token changes for the target wallet (ignoring Wrapped SOL)
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

            // If the token was completely sold out
            if (tokenAmountChange === 0) {
                preBalances.forEach(pre => {
                    if (pre.owner === targetWalletAddress && pre.mint !== 'So11111111111111111111111111111111111111112') {
                        const post = postBalances.find(p => p.mint === pre.mint && p.owner === targetWalletAddress);
                        if (!post) {
                            tokenMint = pre.mint;
                            tokenAmountChange = -pre.uiTokenAmount.uiAmount; // Negative change = Sell
                        }
                    }
                });
            }

            // Determine if Buy or Sell
            if (tokenAmountChange > 0) {
                actionType = "BUY DETECTED";
                actionEmoji = "🟢";
            } else if (tokenAmountChange < 0) {
                actionType = "SELL DETECTED";
                actionEmoji = "🔴";
            }

            const solscanUrl = `https://solscan.io/tx/${signature}`;
            const dexscreenerUrl = `https://dexscreener.com/solana/${tokenMint}`;

            // Build the detailed alert message
            const alertMessage = `
${actionEmoji} **${actionType}!** ${actionEmoji}

👤 **Wallet:** \`${targetWalletAddress.substring(0, 6)}...${targetWalletAddress.substring(targetWalletAddress.length - 4)}\`
🪙 **Amount:** \`${formatAmount(tokenAmountChange)}\` tokens
💊 **Token CA:** \`${tokenMint}\`

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
            `;

            // Send notification to Telegram
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
