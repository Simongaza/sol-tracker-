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
    res.end(`Solana Tracker (Hold + Sell Alert Mode) is active! [Engine: ${instanceId}]\n`);
}).listen(PORT, '0.0.0.0', () => {
    console.log(`📡 Server bound on port ${PORT}`);
});

// ==========================================
// 2. CONFIGURATION
// ==========================================
const botToken = '8824963965:AAFtESw6niqh7FsgGrKyUotv-5x8o0lqFLw';
const chatID = '7113872351';
const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';

// 2 minutes delay (120,000 ms) before checking if a buy is still held
const HOLD_CHECK_DELAY_MS = 2 * 60 * 1000; 

const targetWallets = [
    { name: 'Insider 1', address: '2AqFJzcgSMQ9v7Vwh4yE7Vux8brcrjus1eg4K1zM2zUd' },
    { name: 'Insider 2', address: '5URyNUmhcuWdZiiQrtNdFrSbQPfq72UV2gqQasr9c19Y' },
    { name: '200x insider', address: 'A4KxLRntS2V6giboMyfDtwoysmsKPaz8Juw6CwHYxVXn' }
];

// ==========================================
// 3. INITIALIZATION
// ==========================================
const bot = new TelegramBot(botToken, { polling: true });
const connection = new Connection(rpcUrl, 'confirmed');
const lastSeenSignatures = {};

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `✅ **Hold + Sell Alert Tracker Bot is LIVE!**\n⚙️ Engine ID: \`${instanceId}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/ping/, (msg) => {
    bot.sendMessage(msg.chat.id, `🏓 **Pong!** Engine online scanning buys & dumps.\n⚙️ Engine ID: \`${instanceId}\``, { parse_mode: 'Markdown' });
});

console.log(`🚀 Engine Instance [${instanceId}] active (Tracking Holds + Sell Signals)...`);

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

// Fetch token metadata from Solana RPC
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
    } catch (e) { /* Silent fallback */ }
    return { name: "Unknown Token", symbol: "UNKNOWN" };
}

// Fetch real-time token price from DexScreener API
async function getTokenPrice(mintAddress) {
    try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
        const data = await response.json();
        
        if (data && data.pairs && data.pairs.length > 0) {
            const bestPair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            return parseFloat(bestPair.priceUsd || 0);
        }
    } catch (err) {
        console.error(`❌ DexScreener price error for ${mintAddress}:`, err.message);
    }
    return 0;
}

// Query on-chain token balance to check if still held
async function verifyWalletHoldsToken(walletAddress, mintAddress) {
    try {
        const parsedAccounts = await connection.getParsedTokenAccountsByOwner(
            new PublicKey(walletAddress),
            { mint: new PublicKey(mintAddress) }
        );

        if (!parsedAccounts || parsedAccounts.value.length === 0) return 0;

        let totalBalance = 0;
        for (const acc of parsedAccounts.value) {
            const amount = acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
            totalBalance += amount;
        }
        return totalBalance;
    } catch (err) {
        console.error(`❌ Hold check error for ${mintAddress}:`, err.message);
        return 0;
    }
}

// ==========================================
// 5. PARSER (HANDLES BOTH BUYS & SELLS)
// ==========================================
async function parseAndSendAlert(tx, signature, wallet) {
    if (!tx || !tx.meta || tx.meta.err) return; 
    
    const walletAddress = wallet.address;
    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];
    
    const involvedMints = new Set();
    preTokenBalances.forEach(p => { if (p.owner === walletAddress) involvedMints.add(p.mint); });
    postTokenBalances.forEach(p => { if (p.owner === walletAddress) involvedMints.add(p.mint); });
    involvedMints.delete('So11111111111111111111111111111111111111112'); // Exclude Wrapped SOL

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
    // A. IMMEDIATE SELL ALERTS (EXIT SIGNAL)
    // ------------------------------------------
    if (sells.length > 0) {
        const sellToken = sells[0];
        const mintAddress = sellToken.mint;
        const soldAmount = sellToken.change;

        const meta = await getTokenMetadata(mintAddress);
        const dexscreenerUrl = `https://dexscreener.com/solana/${mintAddress}`;
        const solscanUrl = `https://solscan.io/tx/${signature}`;

        const sellAlert = `
🔴 **SELL DETECTED!** 🔴

👤 **Wallet:** **${wallet.name}** (\`${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}\`)
🪙 **Token:** **${meta.name}** ${meta.symbol ? `(${meta.symbol})` : ''}
💊 **Token CA:** \`${mintAddress}\`

📤 **Sold Amount:** \`${formatAmount(soldAmount)} ${meta.symbol}\`

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
        `;

        try {
            await bot.sendMessage(chatID, sellAlert.trim(), { parse_mode: 'Markdown', disable_web_page_preview: true });
            console.log(`🔴 Immediate sell alert sent for ${meta.symbol} (${mintAddress})`);
        } catch (err) {
            console.error("❌ Telegram Send Error:", err.message);
        }
        return;
    }

    // ------------------------------------------
    // B. DELAYED BUY ALERTS (HOLD FILTER)
    // ------------------------------------------
    if (buys.length > 0) {
        const primaryToken = buys[0];
        const mintAddress = primaryToken.mint;
        const boughtAmount = primaryToken.change;

        console.log(`⏳ Buy detected for ${wallet.name} on ${mintAddress}. Capturing entry price...`);
        
        // Snapshot 1: Entry price
        const entryPriceUsd = await getTokenPrice(mintAddress);

        // Wait 2 minutes before confirming hold
        setTimeout(async () => {
            const currentHeldBalance = await verifyWalletHoldsToken(walletAddress, mintAddress);

            if (currentHeldBalance > 0) {
                // Snapshot 2: Current price after 2 minutes
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

⏱️ *Verified: Token still held 2+ mins after buy.*

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
                `;

                try {
                    await bot.sendMessage(chatID, holdAlert.trim(), { parse_mode: 'Markdown', disable_web_page_preview: true });
                    console.log(`✅ Alert sent for held token ${mintAddress}`);
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
