const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');
require('dotenv').config();

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
// 2. CONFIGURATION & CREDENTIALS
// ==========================================
const botToken = process.env.TELEGRAM_BOT_TOKEN || '8824963965:AAFtESw6niqh7FsgGrKyUotv-5x8o0lqFLw';
const chatID = process.env.TELEGRAM_CHAT_ID || '7113872351';
const targetWalletAddress = process.env.TARGET_WALLET || '2AqFJzcgSMQ9v7Vwh4yE7Vux8brcrjus1eg4K1zM2zUd';
const wssUrl = process.env.HELIUS_WSS_URL || 'wss://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';

// ==========================================
// 3. INITIALIZATION
// ==========================================
const bot = new TelegramBot(botToken, { polling: false });
const connection = new Connection(wssUrl, 'confirmed');
const targetPublicKey = new PublicKey(targetWalletAddress);

console.log(`🚀 Tracking started for wallet: ${targetWalletAddress}`);
console.log(`📡 Connected to Helius WebSocket...`);

// ==========================================
// 4. REAL-TIME BLOCKCHAIN LISTENER
// ==========================================
connection.onLogs(
    targetPublicKey,
    async (logs, context) => {
        try {
            const signature = logs.signature;
            if (!signature) return;

            console.log(`✨ Activity detected! Tx: ${signature}`);

            const solscanUrl = `https://solscan.io/tx/${signature}`;
            const alertMessage = `
🚨 **NEW TRANSACTION DETECTED!** 🚨

👤 **Wallet:** \`${targetWalletAddress.substring(0, 6)}...${targetWalletAddress.substring(targetWalletAddress.length - 4)}\`
🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](https://dexscreener.com/solana/${targetWalletAddress})
            `;

            // Send notification to Telegram
            await bot.sendMessage(chatID, alertMessage, { 
                parse_mode: 'Markdown', 
                disable_web_page_preview: true 
            });
            
            console.log(`✅ Alert successfully sent to Telegram!`);
        } catch (error) {
            console.error('❌ Error executing transaction alert:', error);
        }
    },
    'confirmed'
);
