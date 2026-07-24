const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');

const instanceId = Math.random().toString(36).substring(2, 6).toUpperCase();

// ==========================================
// 1. DUMMY SERVER FOR CLOUD HOSTING
// ==========================================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Solana Tracker (Memory Mode) is active! [Engine: ${instanceId}]\n`);
}).listen(PORT, '0.0.0.0', () => {
    console.log(`📡 Server bound on port ${PORT}`);
});

// ==========================================
// 2. CONFIGURATION & STATE MEMORY
// ==========================================
const botToken = '8824963965:AAFtESw6niqh7FsgGrKyUotv-5x8o0lqFLw';
const chatID = '7113872351';
const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';

const HOLD_CHECK_DELAY_MS = 2 * 60 * 1000; 

const targetWallets = [
    { name: 'Insider 1', address: '2AqFJzcgSMQ9v7Vwh4yE7Vux8brcrjus1eg4K1zM2zUd' },
    { name: 'Insider 2', address: '5URyNUmhcuWdZiiQrtNdFrSbQPfq72UV2gqQasr9c19Y' },
    { name: '200x insider', address: 'A4KxLRntS2V6giboMyfDtwoysmsKPaz8Juw6CwHYxVXn' }
];

// STATE MEMORY: This remembers which tokens the bot told you about.
const trackedPositions = {};
targetWallets.forEach(w => trackedPositions[w.address] = new Set());

// ==========================================
// 3. INITIALIZATION
// ==========================================
const bot = new TelegramBot(botToken, { polling: true });
const connection = new Connection(rpcUrl, 'confirmed');
const lastSeenSignatures = {};

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `✅ **Memory Tracker Bot is LIVE!**\n⚙️ Engine ID: \`${instanceId}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/ping/, (msg) => {
    bot.sendMessage(msg.chat.id, `🏓 **Pong!** Engine online. Tracking verified holds only.\n⚙️ Engine ID: \`${instanceId}\``, { parse_mode: 'Markdown' });
});

console.log(`🚀 Engine Instance [${instanceId}] active (State Memory Enabled)...`);

// ==========================================
// 4. HELPER FUNCTIONS
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
    } catch (e) {}
    return { name: "Unknown Token", symbol: "UNKNOWN" };
}

async function getTokenPrice(mintAddress) {
    try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
        const data = await response.json();
        if (data && data.pairs && data.pairs.length > 0) {
            const bestPair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            return parseFloat(bestPair.priceUsd || 0);
        }
    } catch (err) {}
    return 0;
}

async function verifyWalletHoldsToken(walletAddress, mintAddress) {
    try {
        const parsedAccounts = await connection.getParsedTokenAccountsByOwner(
            new PublicKey(walletAddress),
            { mint: new PublicKey(mintAddress) }
        );
        if (!parsedAccounts || parsedAccounts.value.length === 0) return 0;

        let totalBalance = 0;
        for (const acc of parsedAccounts.value) {
            totalBalance += acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
        }
        return totalBalance;
    } catch (err) {
        return 0;
    }
}

// ==========================================
// 5. PARSER (MEMORY LOGIC APPLIED)
// ==========================================
async function parseAndSendAlert(tx, signature, wallet) {
    if (!tx || !tx.meta || tx.meta.err) return; 
    
    const walletAddress = wallet.address;
    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];
    
    const involvedMints = new Set();
    preTokenBalances.forEach(p => { if (p.owner === walletAddress) involvedMints.add(p.mint); });
    postTokenBalances.forEach(p => { if (p.owner === walletAddress) involvedMints.add(p.mint); });
    involvedMints.delete('So11111111111111111111111111111111111111112'); 

    const buys = [];
    const sells = [];

    for (const mint of involvedMints) {
        const pre = preTokenBalances.find(p => p.mint === mint && p.owner === walletAddress);
        const post = postTokenBalances.find(p => p.mint === mint && p.owner === walletAddress);

        const preAmount = pre?.uiTokenAmount?.uiAmount || 0;
        const postAmount = post?.uiTokenAmount?.uiAmount || 0;
        const change = postAmount - preAmount;

        if (change > 0) buys.push({ mint, change });
        if (change < 0) sells.push({ mint, change: Math.abs(change) });
    }

    // ------------------------------------------
    // A. IMMEDIATE SELL ALERTS (FILTERED BY MEMORY)
    // ------------------------------------------
    if (sells.length > 0) {
        const sellToken = sells[0];
        const mintAddress = sellToken.mint;
        const soldAmount = sellToken.change;

        // MEMORY CHECK: Only alert if we told you they were holding this token
        if (trackedPositions[walletAddress] && trackedPositions[walletAddress].has(mintAddress)) {
            const meta = await getTokenMetadata(mintAddress);
            const dexscreenerUrl = `https://dexscreener.com/solana/${mintAddress}`;
            const solscanUrl = `https://solscan.io/tx/${signature}`;

            // Check if they dumped the entire bag
            const remainingBalance = await verifyWalletHoldsToken(walletAddress, mintAddress);
            let bagStatus = remainingBalance === 0 ? "⚠️ **POSITION FULLY CLOSED** ⚠️" : `💼 **Remaining Bag:** \`${formatAmount(remainingBalance)} ${meta.symbol}\``;

            const sellAlert = `
🔴 **TRACKED SELL DETECTED!** 🔴

👤 **Wallet:** **${wallet.name}** (\`${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}\`)
🪙 **Token:** **${meta.name}** ${meta.symbol ? `(${meta.symbol})` : ''}
💊 **Token CA:** \`${mintAddress}\`

📤 **Sold Amount:** \`${formatAmount(soldAmount)} ${meta.symbol}\`
${bagStatus}

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
            `;

            try {
                await bot.sendMessage(chatID, sellAlert.trim(), { parse_mode: 'Markdown', disable_web_page_preview: true });
                console.log(`🔴 Tracked sell alert sent for ${meta.symbol} (${mintAddress})`);
                
                // If they have no tokens left, remove it from the bot's memory
                if (remainingBalance === 0) {
                    trackedPositions[walletAddress].delete(mintAddress);
                    console.log(`🗑️ Position fully closed. Removed ${mintAddress} from memory.`);
                }
            } catch (err) {
                console.error("❌ Telegram Send Error:", err.message);
            }
        } else {
            // Fails the memory check. The bot stays completely silent.
            console.log(`🗑️ Ignored untracked sell for ${mintAddress} (Not in active holds).`);
        }
    }

    // ------------------------------------------
    // B. DELAYED BUY ALERTS (ADD TO MEMORY)
    // ------------------------------------------
    if (buys.length > 0) {
        const primaryToken = buys[0];
        const mintAddress = primaryToken.mint;
        const boughtAmount = primaryToken.change;

        console.log(`⏳ Buy detected for ${wallet.name} on ${mintAddress}. Capturing entry price...`);
        const entryPriceUsd = await getTokenPrice(mintAddress);

        setTimeout(async () => {
            const currentHeldBalance = await verifyWalletHoldsToken(walletAddress, mintAddress);

            if (currentHeldBalance > 0) {
                
                // NEW STEP: Add this token to the bot's memory so it watches for the sell
                if (trackedPositions[walletAddress]) {
                    trackedPositions[walletAddress].add(mintAddress);
                }

                const currentPriceUsd = await getTokenPrice(mintAddress);
                const currentValueUsd = currentPriceUsd * currentHeldBalance;
                const costBasisForHeld = entryPriceUsd * currentHeldBalance;
                const unrealizedProfit = currentValueUsd - costBasisForHeld;
                
                let profitString = '';
                if (entryPriceUsd > 0 && currentPriceUsd > 0) {
                    const profitPercent = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
                    const sign = unrealizedProfit >= 0 ? '+' : '';
                    const emoji = unrealizedProfit >= 0 ? '🚀' : '🩸';
                    
                    const formattedProfit = unrealizedProfit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    const formattedValue = currentValueUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    
                    profitString = `\n${emoji} **Unrealized PnL:** \`${sign}$${formattedProfit}\` (${sign}${profitPercent.toFixed(2)}%)\n💰 **Current Bag Value:** \`$${formattedValue}\``;
                } else if (currentValueUsd > 0) {
                    profitString = `\n💰 **Current Bag Value:** \`$${currentValueUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\``;
                }

                const meta = await getTokenMetadata(mintAddress);
                const dexscreenerUrl = `https://dexscreener.com/solana/${mintAddress}`;
                const solscanUrl = `https://solscan.io/tx/${signature}`;

                const holdAlert = `
💎 **INSIDER IS HOLDING!** 💎

👤 **Wallet:** **${wallet.name}** (\`${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}\`)
🪙 **Token:** **${meta.name}** ${meta.symbol ? `(${meta.symbol})` : ''}
💊 **Token CA:** \`${mintAddress}\`

📥 **Bought Amount:** \`${formatAmount(boughtAmount)} ${meta.symbol}\`
💼 **Currently Holding:** \`${formatAmount(currentHeldBalance)} ${meta.symbol}\`${profitString}

⏱️ *Verified: Token still held 2+ mins after buy. Added to Watchlist.*

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
                `;

                try {
                    await bot.sendMessage(chatID, holdAlert.trim(), { parse_mode: 'Markdown', disable_web_page_preview: true });
                    console.log(`✅ Alert sent & memory updated for ${mintAddress}`);
                } catch (err) {
                    console.error("❌ Telegram Send Error:", err.message);
                }
            } else {
                console.log(`🗑️ Fast-flip buy ignored for ${mintAddress} (Insider sold within 2 mins).`);
            }
        }, HOLD_CHECK_DELAY_MS);
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
// 6. MAIN ENGINE LOOP
// ==========================================
async function pollWallets() {
    for (const wallet of targetWallets) {
        try {
            const pubKey = new PublicKey(wallet.address);
            const signaturesInfo = await connection.getSignaturesForAddress(pubKey, { limit: 5 });
            
            if (!signaturesInfo || signaturesInfo.length === 0) continue;

            if (!lastSeenSignatures[wallet.address]) {
                lastSeenSignatures[wallet.address] = new Set();
                for (const sigInfo of signaturesInfo) {
                    lastSeenSignatures[wallet.address].add(sigInfo.signature);
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
    
    setTimeout(pollWallets, 5000);
}

pollWallets();
