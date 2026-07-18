const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');

const instanceId = Math.random().toString(36).substring(2, 6).toUpperCase();

// ==========================================
// 1. WEB ALIVE SERVER (RENDER COMPLIANT)
// ==========================================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Veyron Engine Active: [${instanceId}]\n`);
}).listen(PORT, '0.0.0.0');

// ==========================================
// 2. CONFIGURATION & CREDENTIALS
// ==========================================
const botToken = '8824963965:AAFtESw6niqh7FsgGrKyUotv-5x8o0lqFLw';
const chatID = '7113872351';
const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';

const targetWallets = [
    { name: 'Insider 1', address: '2AqFJzcgSMQ9v7Vwh4yE7Vux8brcrjus1eg4K1zM2zUd' },
    { name: 'Insider 2', address: '5URyNUmhcuWdZiiQrtNdFrSbQPfq72UV2gqQasr9c19Y' }
];

const bot = new TelegramBot(botToken, { polling: true });
const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
const lastSeenSignatures = new Map();

// Initialize empty tracking sets for each wallet
targetWallets.forEach(w => lastSeenSignatures.set(w.address, new Set()));

// ==========================================
// 3. TELEGRAM INTERACTION LIVENESS
// ==========================================
bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, `✅ **Veyron Tracker Engine Online**\n⚙️ ID: \`${instanceId}\``, { parse_mode: 'Markdown' }));
bot.onText(/\/ping/, (msg) => bot.sendMessage(msg.chat.id, `🏓 **Pong!** Engine active and listening.`, { parse_mode: 'Markdown' }));

console.log(`🚀 Engine [${instanceId}] successfully initialized.`);

// ==========================================
// 4. PARSERS & CRYPTO DATA ENGINE
// ==========================================
function formatAmount(amount) {
    const abs = Math.abs(amount);
    if (abs >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return amount.toFixed(2);
}

async function getTokenMetadata(mintAddress) {
    if (!mintAddress || mintAddress === "So11111111111111111111111111111111111111112") return { name: "Solana", symbol: "SOL" };
    try {
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'metadata-lookup', method: 'getAsset', params: { id: mintAddress } })
        });
        const data = await response.json();
        const metadata = data?.result?.content?.metadata;
        return { 
            name: metadata?.name || "Unknown Token", 
            symbol: metadata?.symbol || "TOKEN"
        };
    } catch (e) { 
        return { name: "Unknown Token", symbol: "TOKEN" }; 
    }
}

async function parseAndSendAlert(tx, signature, wallet) {
    if (!tx || !tx.meta) return;

    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    const allMints = [...new Set([...preBalances, ...postBalances].map(b => b.mint))];
    
    let activeMint = null;
    let tokenChange = 0;

    // Scan for token balance deviations linked directly to the target wallet
    for (const mint of allMints) {
        if (mint === 'So11111111111111111111111111111111111111112') continue; 
        
        const pre = preBalances.find(p => p.mint === mint && p.owner === wallet.address)?.uiTokenAmount?.uiAmount || 0;
        const post = postBalances.find(p => p.mint === mint && p.owner === wallet.address)?.uiTokenAmount?.uiAmount || 0;
        
        if (post !== pre) {
            activeMint = mint;
            tokenChange = post - pre;
            break; 
        }
    }

    // Calculate native SOL adjustments
    const accountKeys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey.toBase58());
    const targetIdx = accountKeys.indexOf(wallet.address);
    const solChange = targetIdx !== -1 ? (tx.meta.postBalances[targetIdx] - tx.meta.preBalances[targetIdx]) / 1e9 : 0;

    const solscanUrl = `https://solscan.io/tx/${signature}`;

    if (activeMint) {
        const meta = await getTokenMetadata(activeMint);
        const actionType = tokenChange > 0 ? '🟢 BUY' : '🔴 SELL';
        
        const msg = `⚡ **${actionType} DETECTED** ⚡\n\n` +
                    `👤 **Wallet:** ${wallet.name}\n` +
                    `🪙 **Token:** ${meta.name} (${meta.symbol})\n` +
                    `💰 **Amount:** \`${formatAmount(tokenChange)} ${meta.symbol}\`\n` +
                    `⛽ **SOL Value:** \`${solChange > 0 ? '+' : ''}${solChange.toFixed(3)} SOL\`\n` +
                    `💊 **CA:** \`${activeMint}\`\n\n` +
                    `🔗 [Solscan](${solscanUrl}) | [DexScreener](https://dexscreener.com/solana/${activeMint})`;
        
        await bot.sendMessage(chatID, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(console.error);
    } else if (Math.abs(solChange) > 0.005) { 
        // Handles pure SOL transitions (Excluding structural gas transaction micro-fees)
        const actionType = solChange > 0 ? '📥 SOL RECEIVED' : '📤 SOL SENT';
        const msg = `💰 **${actionType}** 💰\n\n` +
                    `👤 **Wallet:** ${wallet.name}\n` +
                    `💵 **Amount:** \`${Math.abs(solChange).toFixed(3)} SOL\`\n\n` +
                    `🔗 [View Transaction](${solscanUrl})`;
        
        await bot.sendMessage(chatID, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(console.error);
    }
}

// ==========================================
// 5. CORE CONCURRENCY POLLING ROUTINE
// ==========================================
async function checkWallet(wallet) {
    try {
        const pubKey = new PublicKey(wallet.address);
        const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 50 });
        
        const walletCache = lastSeenSignatures.get(wallet.address);

        // Cold Boot Setup
        if (walletCache.size === 0 && signatures.length > 0) {
            signatures.forEach(s => walletCache.add(s.signature));
            return;
        }

        // Isolate untracked incoming signatures
        const pendingSignatures = [];
        for (const sigInfo of signatures) {
            if (!walletCache.has(sigInfo.signature)) {
                pendingSignatures.push(sigInfo.signature);
            }
        }

        if (pendingSignatures.length === 0) return;

        // CRITICAL FIX: Flip execution sequence to process oldest events first
        pendingSignatures.reverse();

        for (const signature of pendingSignatures) {
            try {
                const tx = await connection.getParsedTransaction(signature, { 
                    commitment: 'confirmed', 
                    maxSupportedTransactionVersion: 0 
                });
                
                if (tx) {
                    await parseAndSendAlert(tx, signature, wallet);
                    walletCache.add(signature); // Locked in only on successful processing
                }
            } catch (txError) {
                console.error(`⚠️ Temporary skip on signature [${signature}]:`, txError.message);
                // Signature remains unadded, forcing processing attempt on next cycle loop
            }
        }

        // Memory cleanup to prevent runtime out-of-memory crashes
        if (walletCache.size > 200) {
            const currentCacheArray = Array.from(walletCache);
            lastSeenSignatures.set(wallet.address, new Set(currentCacheArray.slice(-100)));
        }

    } catch (err) { 
        console.error(`❌ Core Connection Error on ${wallet.name}:`, err.message); 
    }
}

async function runLoop() {
    await Promise.all(targetWallets.map(w => checkWallet(w)));
    setTimeout(runLoop, 2000); // Stable 2-second recursive window execution
}

// Start tracking application loop
runLoop();
