const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');

const instanceId = Math.random().toString(36).substring(2, 6).toUpperCase();

// ==========================================
// 1. DUMMY SERVER FOR RENDER/RAILWAY
// ==========================================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Solana Multi-Tracker Bot is running! [Engine: ${instanceId}]\n`);
}).listen(PORT, '0.0.0.0', () => {
    console.log(`📡 Server bound on port ${PORT}`);
});

// ==========================================
// 2. CONFIGURATION
// ==========================================
const botToken = '8824963965:AAFtESw6niqh7FsgGrKyUotv-5x8o0lqFLw';
const chatID = '7113872351';
const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';

const targetWallets = [
    { name: 'Insider 1', address: '2AqFJzcgSMQ9v7Vwh4yE7Vux8brcrjus1eg4K1zM2zUd' },
    { name: 'Insider 2', address: '5URyNUmhcuWdZiiQrtNdFrSbQPfq72UV2gqQasr9c19Y' },
    { name: '200x insider', address: 'A4KxLRntS2V6giboMyfDtwoysmsKPaz8Juw6CwHYxVXn' }
];

// ==========================================
// 3. INITIALIZATION & TELEGRAM COMMANDS
// ==========================================
// Polling is now TRUE so the bot can receive your direct messages
const bot = new TelegramBot(botToken, { polling: true });
const connection = new Connection(rpcUrl, 'confirmed');
const lastSeenSignatures = {};

// Type /start or /ping in Telegram to verify the bot is alive!
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `✅ **Veyron Tracker Bot is LIVE!**\n⚙️ Engine ID: \`${instanceId}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/ping/, (msg) => {
    bot.sendMessage(msg.chat.id, `🏓 **Pong!** Bot is online and actively scanning.\n⚙️ Engine ID: \`${instanceId}\``, { parse_mode: 'Markdown' });
});

console.log(`🚀 Engine Instance [${instanceId}] active...`);

// ==========================================
// 4. PARSERS & HELPERS
// ==========================================
function formatAmount(amount) {
    const absAmount = Math.abs(amount);
    if (absAmount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (absAmount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (absAmount >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return amount.toFixed(2);
}

async function getTokenMetadata(mintAddress) {
    if (!mintAddress || mintAddress === "Unknown" || mintAddress === "SOL") return { name: "Solana", symbol: "SOL" };
    try {
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'lookup', method: 'getAsset', params: { id: mintAddress } })
        });
        const { result } = await response.json();
        if (result?.content?.metadata) {
            return { name: result.content.metadata.name || "Unknown Token", symbol: result.content.metadata.symbol || "UNKNOWN" };
        }
    } catch (e) { /* Silent fallback if lookup fails */ }
    return { name: "Unknown Token", symbol: "UNKNOWN" };
}

async function parseAndSendAlert(tx, signature, wallet) {
    // Drop completely failed transactions so you don't get false alarms
    if (!tx || !tx.meta || tx.meta.err) return; 
    
    const walletAddress = wallet.address;
    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];
    
    const involvedMints = new Set();
    preTokenBalances.forEach(p => { if (p.owner === walletAddress) involvedMints.add(p.mint); });
    postTokenBalances.forEach(p => { if (p.owner === walletAddress) involvedMints.add(p.mint); });
    involvedMints.delete('So11111111111111111111111111111111111111112'); // Ignore wrapped SOL

    const tokenChanges = [];
    for (const mint of involvedMints) {
        const pre = preTokenBalances.find(p => p.mint === mint && p.owner === walletAddress);
        const post = postTokenBalances.find(p => p.mint === mint && p.owner === walletAddress);

        const preAmount = pre?.uiTokenAmount?.uiAmount || 0;
        const postAmount = post?.uiTokenAmount?.uiAmount || 0;
        const change = postAmount - preAmount;

        if (Math.abs(change) > 0) tokenChanges.push({ mint, change });
    }

    let solChange = 0;
    const postBalancesSol = tx.meta.postBalances || [];
    const preBalancesSol = tx.meta.preBalances || [];
    
    // Safely parse account keys whether they are objects or raw strings
    const accountKeys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : (k.pubkey ? k.pubkey.toString() : k.toString()));
    const targetIndex = accountKeys.indexOf(walletAddress);

    if (targetIndex !== -1) {
        solChange = ((postBalancesSol[targetIndex] || 0) - (preBalancesSol[targetIndex] || 0)) / 1e9;
    }

    // Ignore tiny dust fees if no tokens moved
    if (tokenChanges.length === 0 && Math.abs(solChange) <= 0.005) return;

    let alertMessage = "";
    const solscanUrl = `https://solscan.io/tx/${signature}`;

    if (tokenChanges.length > 0) {
        const primaryToken = tokenChanges[0];
        const meta = await getTokenMetadata(primaryToken.mint);
        const actionType = primaryToken.change > 0 ? "BUY DETECTED" : "SELL DETECTED";
        const actionEmoji = primaryToken.change > 0 ? "🟢" : "🔴";
        const dexscreenerUrl = `https://dexscreener.com/solana/${primaryToken.mint}`;

        alertMessage = `
${actionEmoji} **${actionType}!** ${actionEmoji}

👤 **Wallet:** **${wallet.name}** (\`${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}\`)
🪙 **Token:** **${meta.name}** ${meta.symbol ? `(${meta.symbol})` : ''}
💰 **Amount:** \`${formatAmount(primaryToken.change)} ${meta.symbol}\`
💊 **Token CA:** \`${primaryToken.mint}\`
⛽ **SOL Value:** \`${solChange > 0 ? '+' : ''}${solChange.toFixed(4)} SOL\`

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
        `;
    } else {
        const actionType = solChange > 0 ? "SOL RECEIVED" : "SOL SENT";
        const actionEmoji = solChange > 0 ? "📥" : "📤";

        alertMessage = `
${actionEmoji} **${actionType}!** ${actionEmoji}

👤 **Wallet:** **${wallet.name}** (\`${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}\`)
🪙 **Token:** **Solana (SOL)**
💰 **Amount:** \`${formatAmount(solChange)} SOL\`

🔗 **Solscan:** [View Transaction](${solscanUrl})
        `;
    }

    try {
        await bot.sendMessage(chatID, alertMessage.trim(), { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (err) {
        console.error("❌ Telegram Send Error:", err.message);
    }
}

async function fetchWithRetry(signature, wallet, retries = 5, delay = 3000) {
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
            if (tx && tx.meta) {
                await parseAndSendAlert(tx, signature, wallet);
                return;
            }
            await new Promise(r => setTimeout(r, delay));
        } catch (e) {
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ==========================================
// 5. CORE ENGINE (CRASH-PROOF LOOP)
// ==========================================
async function pollWallets() {
    for (const wallet of targetWallets) {
        try {
            const pubKey = new PublicKey(wallet.address);
            const signaturesInfo = await connection.getSignaturesForAddress(pubKey, { limit: 5 });
            
            if (!signaturesInfo || signaturesInfo.length === 0) continue;

            // Cold Boot Catch-Up Logic
            if (!lastSeenSignatures[wallet.address]) {
                lastSeenSignatures[wallet.address] = new Set();
                const fiveMinsAgo = Math.floor(Date.now() / 1000) - (5 * 60);

                for (const sigInfo of signaturesInfo) {
                    lastSeenSignatures[wallet.address].add(sigInfo.signature);
                    
                    // If a trade happened in the last 5 mins while bot was offline/sleeping, alert it!
                    if (sigInfo.blockTime && sigInfo.blockTime > fiveMinsAgo) {
                        await fetchWithRetry(sigInfo.signature, wallet);
                    }
                }
                continue;
            }

            const newSignatures = [];
            for (const sigInfo of signaturesInfo) {
                if (!lastSeenSignatures[wallet.address].has(sigInfo.signature)) {
                    newSignatures.push(sigInfo.signature);
                    lastSeenSignatures[wallet.address].add(sigInfo.signature);
                }
            }

            if (newSignatures.length > 0) {
                newSignatures.reverse(); 
                for (const sig of newSignatures) {
                    // Prevent memory leaks
                    if (lastSeenSignatures[wallet.address].size > 50) {
                        lastSeenSignatures[wallet.address].delete(lastSeenSignatures[wallet.address].values().next().value);
                    }
                    await fetchWithRetry(sig, wallet);
                }
            }
        } catch (err) {
            console.error(`❌ Polling error on ${wallet.name}:`, err.message);
        }
    }
    
    // RECURSIVE TIMEOUT: Prevents avalanche crashing and RPC bans
    setTimeout(pollWallets, 5000);
}

// Start the engine
pollWallets();
