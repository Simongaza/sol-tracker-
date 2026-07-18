const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const http = require('http');

const instanceId = Math.random().toString(36).substring(2, 6).toUpperCase();

// 1. DUMMY SERVER FOR RENDER
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Bot is running! [Engine: ${instanceId}]\n`);
}).listen(PORT, '0.0.0.0');

// 2. CONFIGURATION
const botToken = '8824963965:AAFtESw6niqh7FsgGrKyUotv-5x8o0lqFLw';
const chatID = '7113872351';
const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=f9853790-c087-4200-b5de-41d5c4789573';

const targetWallets = [
    { name: 'Insider 1', address: '2AqFJzcgSMQ9v7Vwh4yE7Vux8brcrjus1eg4K1zM2zUd' },
    { name: 'Insider 2', address: '5URyNUmhcuWdZiiQrtNdFrSbQPfq72UV2gqQasr9c19Y' }
];

const bot = new TelegramBot(botToken, { polling: true });
const connection = new Connection(rpcUrl, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60000 });
const lastSeenSignatures = new Map();

// 3. INITIALIZATION
bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, `✅ Bot is LIVE! Engine: ${instanceId}`));

// 4. PARSERS & HELPERS
function formatAmount(amount) {
    const abs = Math.abs(amount);
    if (abs >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(amount / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(amount / 1e3).toFixed(2)}K`;
    return amount.toFixed(4);
}

async function getTokenMetadata(mintAddress) {
    if (!mintAddress || mintAddress === "Unknown" || mintAddress === "SOL") return { name: "Solana", symbol: "SOL" };
    try {
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'getAsset', params: { id: mintAddress } })
        });
        const { result } = await response.json();
        return { name: result?.content?.metadata?.name || "Unknown", symbol: result?.content?.metadata?.symbol || "TOKEN" };
    } catch (e) { return { name: "Unknown", symbol: "TOKEN" }; }
}

async function parseAndSendAlert(tx, signature, wallet) {
    if (!tx || !tx.meta) return;
    
    const walletAddress = wallet.address;
    const tokenChanges = [];
    
    // Check Token Balances
    const allBalances = [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])];
    const uniqueMints = [...new Set(allBalances.map(b => b.mint))].filter(m => m !== 'So11111111111111111111111111111111111111112');

    for (const mint of uniqueMints) {
        const pre = tx.meta.preTokenBalances?.find(p => p.mint === mint && p.owner === walletAddress)?.uiTokenAmount?.uiAmount || 0;
        const post = tx.meta.postTokenBalances?.find(p => p.mint === mint && p.owner === walletAddress)?.uiTokenAmount?.uiAmount || 0;
        if (post !== pre) tokenChanges.push({ mint, change: post - pre });
    }

    // Check SOL Balance
    const accountKeys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey.toBase58());
    const idx = accountKeys.indexOf(walletAddress);
    const solChange = idx !== -1 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9 : 0;

    if (tokenChanges.length === 0 && Math.abs(solChange) < 0.0001) return;

    // Send Alert
    const solscanUrl = `https://solscan.io/tx/${signature}`;
    if (tokenChanges.length > 0) {
        const tc = tokenChanges[0];
        const meta = await getTokenMetadata(tc.mint);
        const msg = `${tc.change > 0 ? '🟢 BUY' : '🔴 SELL'}\n👤 **${wallet.name}**\n🪙 ${meta.name} (${meta.symbol})\n💰 ${formatAmount(tc.change)} tokens\n⛽ ${solChange.toFixed(3)} SOL\n🔗 [View Tx](${solscanUrl})`;
        await bot.sendMessage(chatID, msg, { parse_mode: 'Markdown' }).catch(console.error);
    } else if (Math.abs(solChange) > 0.01) {
        const msg = `${solChange > 0 ? '📥 RECEIVED' : '📤 SENT'}\n👤 **${wallet.name}**\n💰 ${Math.abs(solChange).toFixed(3)} SOL\n🔗 [View Tx](${solscanUrl})`;
        await bot.sendMessage(chatID, msg, { parse_mode: 'Markdown' }).catch(console.error);
    }
}

// 5. CORE ENGINE (Concurrency Optimized)
async function checkWallet(wallet) {
    try {
        const pubKey = new PublicKey(wallet.address);
        // Bumped limit to 10 to ensure no overlap
        const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 10 });
        
        if (!lastSeenSignatures.has(wallet.address)) {
            lastSeenSignatures.set(wallet.address, new Set(signatures.map(s => s.signature)));
            return;
        }

        for (const sigInfo of signatures) {
            if (!lastSeenSignatures.get(wallet.address).has(sigInfo.signature)) {
                lastSeenSignatures.get(wallet.address).add(sigInfo.signature);
                const tx = await connection.getParsedTransaction(sigInfo.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
                await parseAndSendAlert(tx, sigInfo.signature, wallet);
            }
        }
        // Cleanup memory
        if (lastSeenSignatures.get(wallet.address).size > 50) {
            const arr = Array.from(lastSeenSignatures.get(wallet.address));
            lastSeenSignatures.set(wallet.address, new Set(arr.slice(-30)));
        }
    } catch (err) { console.error(`Error on ${wallet.name}:`, err.message); }
}

async function runLoop() {
    await Promise.all(targetWallets.map(w => checkWallet(w)));
    setTimeout(runLoop, 2500); // Poll every 2.5 seconds
}

runLoop();
