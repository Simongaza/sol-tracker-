const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');

// ==========================================
// 1. DUMMY SERVER FOR RENDER (Keeps Free Tier Alive)
// ==========================================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Solana Multi-Tracker Bot is running!\n');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`📡 Port bound successfully on port ${PORT}`);
});

// ==========================================
// 2. HARDCODED CONFIGURATION
// ==========================================
const botToken = '8824963965:AAFtESw6niqh7FsgGrKyUotv-5x8o0lqFLw';
const chatID = '7113872351';
const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';

// Array of wallets with unique display profiles
const targetWallets = [
    { name: 'Insider 1', address: '2AqFJzcgSMQ9v7Vwh4yE7Vux8brcrjus1eg4K1zM2zUd' },
    { name: 'Insider 2', address: '5URyNUmhcuWdZiiQrtNdFrSbQPfq72UV2gqQasr9c19Y' }
];

// ==========================================
// 3. INITIALIZATION & STATE
// ==========================================
const bot = new TelegramBot(botToken, { polling: false });
const connection = new Connection(rpcUrl, 'confirmed');

// Stores the known signatures for each wallet tracking context
const lastSeenSignatures = {};

console.log(`🚀 Unbreakable HTTP Multi-Polling Engine active...`);

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
        console.error("❌ Failed to fetch token metadata:", e.message);
    }
    return { name: "Unknown Token", symbol: "UNKNOWN" };
}

// ==========================================
// 4. TRANSACTION PARSER & ALERT SENDER
// ==========================================
async function parseAndSendAlert(tx, signature, wallet) {
    const walletAddress = wallet.address;
    const walletName = wallet.name;

    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];
    
    // Collect all unique token mints where our tracked wallet is the owner
    const involvedMints = new Set();
    preTokenBalances.forEach(p => { if (p.owner === walletAddress) involvedMints.add(p.mint); });
    postTokenBalances.forEach(p => { if (p.owner === walletAddress) involvedMints.add(p.mint); });
    
    // Ignore wrapped SOL in the token array to track it cleanly via native balances
    involvedMints.delete('So11111111111111111111111111111111111111112');

    // Calculate absolute balance changes for every meme coin involved
    const tokenChanges = [];
    for (const mint of involvedMints) {
        const pre = preTokenBalances.find(p => p.mint === mint && p.owner === walletAddress);
        const post = postTokenBalances.find(p => p.mint === mint && p.owner === walletAddress);

        const preAmount = pre ? (pre.uiTokenAmount.uiAmount || 0) : 0;
        const postAmount = post ? (post.uiTokenAmount.uiAmount || 0) : 0;
        const change = postAmount - preAmount;

        if (Math.abs(change) > 0) {
            tokenChanges.push({ mint, change });
        }
    }

    // Calculate Net Native SOL Change
    let solChange = 0;
    const postBalancesSol = tx.meta.postBalances || [];
    const preBalancesSol = tx.meta.preBalances || [];
    const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey ? k.pubkey.toString() : k.toString());
    const targetIndex = accountKeys.indexOf(walletAddress);

    if (targetIndex !== -1) {
        const preSol = preBalancesSol[targetIndex] || 0;
        const postSol = postBalancesSol[targetIndex] || 0;
        solChange = (postSol - preSol) / 1e9;
    }

    // Skip transaction if there is no major asset movement of any kind
    if (tokenChanges.length === 0 && Math.abs(solChange) <= 0.005) {
        console.log(`ℹ️ Skipping minor network fee transaction for ${walletName}.`);
        return;
    }

    let alertMessage = "";
    const solscanUrl = `https://solscan.io/tx/${signature}`;

    // Case A: Token Trade/Swap Detected (e.g. HOUSEM, PTBL, ANCAT)
    if (tokenChanges.length > 0) {
        const primaryToken = tokenChanges[0];
        const meta = await getTokenMetadata(primaryToken.mint);
        const tokenName = meta.name;
        const tokenSymbol = meta.symbol;

        const actionType = primaryToken.change > 0 ? "BUY DETECTED" : "SELL DETECTED";
        const actionEmoji = primaryToken.change > 0 ? "🟢" : "🔴";
        const dexscreenerUrl = `https://dexscreener.com/solana/${primaryToken.mint}`;

        alertMessage = `
${actionEmoji} **${actionType}!** ${actionEmoji}

👤 **Wallet:** **${walletName}** (\`${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}\`)
🪙 **Token:** **${tokenName}** ${tokenSymbol ? `(${tokenSymbol})` : ''}
💰 **Amount:** \`${formatAmount(primaryToken.change)} ${tokenSymbol}\`
💊 **Token CA:** \`${primaryToken.mint}\`
⛽ **SOL Value:** \`${solChange > 0 ? '+' : ''}${solChange.toFixed(4)} SOL\`

🔗 **Solscan:** [View Transaction](${solscanUrl})
📈 **DexScreener:** [Check Charts](${dexscreenerUrl})
        `;
    } 
    // Case B: Pure SOL Transaction (No SPL tokens involved)
    else {
        const actionType = solChange > 0 ? "SOL RECEIVED" : "SOL SENT";
        const actionEmoji = solChange > 0 ? "📥" : "📤";

        alertMessage = `
${actionEmoji} **${actionType}!** ${actionEmoji}

👤 **Wallet:** **${walletName}** (\`${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}\`)
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
    
    console.log(`✅ Alert pushed successfully for ${walletName}: ${signature}`);
}

// Fetch transaction data safely, retrying if the RPC node has an indexing lag
async function fetchWithRetry(signature, wallet, retries = 5, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const tx = await connection.getParsedTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (tx && tx.meta) {
                await parseAndSendAlert(tx, signature, wallet);
                return;
            }
            console.log(`⚠️ Transaction ${signature.substring(0,6)}... not indexed yet. Retrying in ${delay/1000}s... (${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (e) {
            console.error(`❌ Fetch error on try ${i + 1}:`, e.message);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    console.error(`❌ Failed to retrieve indexed data for signature: ${signature}`);
}

// ==========================================
// 5. CORE STATEFUL POLLING ENGINE
// ==========================================
async function pollWallets() {
    for (const wallet of targetWallets) {
        const walletAddress = wallet.address;
        const walletName = wallet.name;

        try {
            const pubKey = new PublicKey(walletAddress);
            // Fetch the last 5 signatures to prevent missing rapid bursts of trades
            const signaturesInfo = await connection.getSignaturesForAddress(pubKey, { limit: 5 });
            
            if (!signaturesInfo || signaturesInfo.length === 0) continue;
            const signatures = signaturesInfo.map(s => s.signature);

            // Cold boot initialization: set up known history baseline so it doesn't spam old historical trades
            if (!lastSeenSignatures[walletAddress]) {
                lastSeenSignatures[walletAddress] = new Set(signatures);
                console.log(`📥 Tracking baseline locked for ${walletName} (${signatures.length} history items cached)`);
                continue;
            }

            // Identify brand new signatures
            const newSignatures = [];
            for (const sig of signatures) {
                if (!lastSeenSignatures[walletAddress].has(sig)) {
                    newSignatures.push(sig);
                }
            }

            // If new transactions are detected, process them chronologically (oldest to newest)
            if (newSignatures.length > 0) {
                newSignatures.reverse(); 

                for (const sig of newSignatures) {
                    console.log(`🔔 New active transaction caught on ${walletName}: ${sig}`);
                    
                    lastSeenSignatures[walletAddress].add(sig);
                    
                    // Keep cache bounded per wallet context to prevent memory leaks
                    if (lastSeenSignatures[walletAddress].size > 50) {
                        const oldestCachedItem = lastSeenSignatures[walletAddress].values().next().value;
                        lastSeenSignatures[walletAddress].delete(oldestCachedItem);
                    }

                    // Process and alert
                    await fetchWithRetry(sig, wallet);
                }
            }
        } catch (err) {
            console.error(`❌ Network error while polling ${walletName}:`, err.message);
        }
    }
}

// Execute polling check perfectly every 4 seconds
setInterval(pollWallets, 4000);
