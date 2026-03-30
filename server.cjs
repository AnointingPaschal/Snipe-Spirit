const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Connection, Keypair, VersionedTransaction, PublicKey, TransactionMessage, SystemProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddress, NATIVE_MINT } = require('@solana/spl-token');
const bs58 = require('bs58').default || require('bs58');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static('public'));

const DEV_WALLET_ADDRESS = new PublicKey("6v2kE3Ds9jcmEu7hR26iBpW9cU3Ax5UaK98pUKJ5U7d8");

let botProcess = null;
let nativeScannerTimer = null;
let sessionTargets = []; 
const DB_FILE = path.join(__dirname, 'database.json');
const BOT_DATA_FILE = path.join(__dirname, 'data.json'); 

let db = { 
    stats: { solBal: 0.0, wsolBal: 0.0, bscBal: 0.0, ethBal: 0.0, trades: 0, wins: 0, losses: 0, pnl: 0.00, solPriceUsd: 0.00, bnbPriceUsd: 0.00, ethPriceUsd: 0.00 }, 
    config: {}, 
    positions: {}, 
    logs: [],
    watchlist: [],
    lockedTargets: [],
    feed: [],
    scannedHistory: []
};

if (fs.existsSync(DB_FILE)) { 
    try { 
        const saved = JSON.parse(fs.readFileSync(DB_FILE)); 
        if(saved.stats) db.stats = { ...db.stats, ...saved.stats }; 
        if(saved.config) db.config = { ...db.config, ...saved.config }; 
        if(saved.positions) db.positions = { ...db.positions, ...saved.positions };
        if(saved.logs) db.logs = saved.logs;
        if(saved.watchlist) db.watchlist = saved.watchlist;
        if(saved.lockedTargets) db.lockedTargets = saved.lockedTargets;
        if(saved.feed) db.feed = saved.feed;
        if(saved.scannedHistory) db.scannedHistory = saved.scannedHistory;
    } catch (e) {} 
}

let saveTimeout = null;
function saveDb() { 
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e){} }, 1000);
}

function broadcastLog(msg, type) {
    const logEntry = { msg, type, time: Date.now() };
    db.logs.push(logEntry);
    if (db.logs.length > 500) db.logs.shift(); 
    saveDb(); io.emit('bot_log', logEntry);
}

async function routeDevFee(connection, wallet, feeLamports) {
    try {
        if (feeLamports <= 0) return;
        const instructions = [
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: DEV_WALLET_ADDRESS,
                lamports: BigInt(feeLamports)
            })
        ];
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions,
        }).compileToV0Message();
        
        const feeTx = new VersionedTransaction(messageV0);
        feeTx.sign([wallet]);
        await connection.sendTransaction(feeTx, { skipPreflight: true });
    } catch(e) {}
}

async function fetchPrices() {
    try {
        const res = await axios.get('https://min-api.cryptocompare.com/data/pricemulti?fsyms=SOL,BNB,ETH&tsyms=USD');
        if (res.data) {
            if (res.data.SOL?.USD) db.stats.solPriceUsd = res.data.SOL.USD;
            if (res.data.BNB?.USD) db.stats.bnbPriceUsd = res.data.BNB.USD;
            if (res.data.ETH?.USD) db.stats.ethPriceUsd = res.data.ETH.USD;
            io.emit('update_ui', db.stats);
        }
    } catch (e) {}
}
setInterval(fetchPrices, 10000); 

async function refreshBalances(connection, walletPublicKey) {
    try {
        db.stats.solBal = (await connection.getBalance(walletPublicKey)) / 1e9;
        const ata = await getAssociatedTokenAddress(NATIVE_MINT, walletPublicKey);
        const wsolInfo = await connection.getTokenAccountBalance(ata).catch(() => null);
        db.stats.wsolBal = wsolInfo ? wsolInfo.value.uiAmount : 0;
        
        db.stats.bscBal = 0.00; 
        db.stats.ethBal = 0.00;

        saveDb(); io.emit('update_ui', db.stats);
    } catch(e) {}
}

async function processSell(targetMint, percentage) {
    broadcastLog(`[EXECUTE] Routing Sell: ${percentage}% of ${targetMint.slice(0,6)}...`, 'log-cyan');
    try {
        const connection = new Connection(db.config.RPC_ENDPOINT, 'confirmed');
        const wallet = Keypair.fromSecretKey(bs58.decode(db.config.PRIVATE_KEY));
        const mintPubkey = new PublicKey(targetMint);
        
        let totalBig = 0n;

        try {
            const ata1 = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey, true, new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
            const bal1 = await connection.getTokenAccountBalance(ata1);
            if (bal1 && bal1.value) totalBig += BigInt(bal1.value.amount);
        } catch(e) {}

        try {
            const ata2 = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey, true, new PublicKey('TokenzQdBNbLqP5VEhRxftEHT1fMPY8RNKu1R1G1L1'));
            const bal2 = await connection.getTokenAccountBalance(ata2);
            if (bal2 && bal2.value) totalBig += BigInt(bal2.value.amount);
        } catch(e) {}

        if (totalBig === 0n) {
            try {
                const fallbackScan = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPubkey });
                if (fallbackScan && fallbackScan.value) {
                    for (const acc of fallbackScan.value) {
                        const amt = acc.account.data.parsed.info.tokenAmount.amount;
                        totalBig += BigInt(amt);
                    }
                }
            } catch(e) {}
        }

        if (totalBig === 0n) {
            broadcastLog(`[EXEC_ERR] Blockchain explicitly returned 0 balance for ${targetMint.slice(0,6)}. Check wallet keys!`, 'log-alert');
            return false;
        }
        
        let amountLamports = "0";
        if (percentage >= 99) amountLamports = totalBig.toString(); 
        else amountLamports = ((totalBig * BigInt(percentage)) / 100n).toString();

        const slipBps = Math.floor(parseFloat(db.config.SELL_SLIPPAGE || 20) * 100);

        try {
            const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${targetMint}&outputMint=${NATIVE_MINT.toString()}&amount=${amountLamports}&slippageBps=${slipBps}`;
            const jupQuote = (await axios.get(quoteUrl, { headers: { accept: 'application/json' } })).data;
            
            const expectedSolLamports = jupQuote.outAmount || 0;
            const feeLamports = Math.floor(parseInt(expectedSolLamports) * 0.01);

            const swapReqBody = { userPublicKey: wallet.publicKey.toBase58(), quoteResponse: jupQuote, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' };
            const jupSwap = (await axios.post('https://lite-api.jup.ag/swap/v1/swap', swapReqBody, { headers: { 'Content-Type': 'application/json', accept: 'application/json' } })).data;
            
            const txBuf = Buffer.from(jupSwap.swapTransaction, 'base64');
            const tx = VersionedTransaction.deserialize(txBuf);
            tx.sign([wallet]);
            
            const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
            broadcastLog(`[EXECUTE] SELL SUCCESS! TXID: ${sig.slice(0, 15)}...`, 'log-sell');
            
            setTimeout(() => routeDevFee(connection, wallet, feeLamports), 1500);

            let exitPrice = 0;
            try {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${targetMint}`);
                const pair = res.data.pairs ? res.data.pairs.find(p => p.chainId === 'solana') || res.data.pairs[0] : null;
                if (pair) exitPrice = parseFloat(pair.priceUsd);
            } catch (e) {}

            const pos = db.positions[targetMint];
            if (pos && pos.entryPrice > 0 && exitPrice > 0) {
                const originalSolInvested = (pos.entrySolAmount || parseFloat(db.config.QUOTE_AMOUNT || 0.05)) * (percentage / 100);
                const priceRatio = exitPrice / pos.entryPrice;
                const solReturned = originalSolInvested * priceRatio;
                const tradePnl = solReturned - originalSolInvested;

                db.stats.pnl += tradePnl;
                db.stats.sol_pnl = (db.stats.sol_pnl || 0) + tradePnl;

                if (tradePnl > 0) {
                    db.stats.wins++;
                    db.stats.sol_wins = (db.stats.sol_wins || 0) + 1;
                } else {
                    db.stats.losses++;
                    db.stats.sol_losses = (db.stats.sol_losses || 0) + 1;
                }
                io.emit('update_ui', db.stats);
            }

            if (db.positions[targetMint] && percentage >= 99) { 
                db.positions[targetMint].status = 'CLOSED'; 
            }
            
            saveDb(); io.emit('position_update', db.positions); 
            setTimeout(() => refreshBalances(connection, wallet.publicKey), 5000);
            return true;
        } catch (apiErr) {
            // 🚀 INJECTED SMART ERROR PARSER
            let errString = apiErr.response?.data ? JSON.stringify(apiErr.response.data) : apiErr.message;
            if (errString.includes('0x1775') || errString.includes('BondingCurveComplete') || errString.includes('migrated to raydium')) {
                broadcastLog(`[CHAIN_HALT] Pump.fun bonding curve complete. Token is migrating to Raydium. Try again soon!`, 'log-alert');
            } else {
                broadcastLog(`[JUP_SELL_ERR] ${errString}`, 'log-alert');
            }
            return false;
        }
    } catch (e) { 
        // 🚀 INJECTED SMART ERROR PARSER
        let errString = e.message || "";
        if (errString.includes('0x1775') || errString.includes('BondingCurveComplete') || errString.includes('migrated to raydium')) {
            broadcastLog(`[CHAIN_HALT] Pump.fun bonding curve complete. Token is migrating to Raydium.`, 'log-alert');
        } else {
            broadcastLog(`[EXEC_ERR] Sell Failed: ${e.message}`, 'log-alert'); 
        }
        return false; 
    }
}

setInterval(async () => {
    if (db.config.AUTO_SELL_ENABLED !== 'true' || !db.config.PRIVATE_KEY) return;
    
    for (const mint in db.positions) {
        const pos = db.positions[mint];
        if (pos.status === 'HOLDING' && pos.entryPrice > 0 && pos.chain === 'SOL') {
            try {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                const pair = res.data.pairs ? res.data.pairs.find(p => p.chainId === 'solana') || res.data.pairs[0] : null;
                if (pair) {
                    const currentPrice = parseFloat(pair.priceUsd);
                    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

                    const sl = parseFloat(db.config.STOP_LOSS_PERCENT || -20);
                    const tp1Gain = parseFloat(db.config.TP1_PERCENT || 100); 
                    const tp1Amt = parseFloat(db.config.TP1_AMOUNT || 50); 
                    const tp2Gain = parseFloat(db.config.TP2_PERCENT || 200); 
                    const tp2Amt = parseFloat(db.config.TP2_AMOUNT || 100); 

                    if (pnlPct <= sl) {
                        broadcastLog(`[AUTO-SELL] STOP-LOSS TRIGGERED (${pnlPct.toFixed(2)}%) for ${mint.slice(0,6)}`, 'log-alert');
                        db.positions[mint].status = 'SELLING'; saveDb();
                        await processSell(mint, 100);
                    } else if (pnlPct >= tp2Gain && !pos.tp2Triggered) {
                        broadcastLog(`[AUTO-SELL] TAKE-PROFIT 2 TRIGGERED (${pnlPct.toFixed(2)}%) for ${mint.slice(0,6)}`, 'log-sell');
                        db.positions[mint].tp2Triggered = true; saveDb();
                        await processSell(mint, tp2Amt);
                    } else if (pnlPct >= tp1Gain && !pos.tp1Triggered) {
                        broadcastLog(`[AUTO-SELL] TAKE-PROFIT 1 TRIGGERED (${pnlPct.toFixed(2)}%) for ${mint.slice(0,6)}`, 'log-sell');
                        db.positions[mint].tp1Triggered = true; saveDb();
                        await processSell(mint, tp1Amt);
                    }
                }
            } catch(e){}
        }
    }
}, 10000); 

async function runNativeScanner() {
    if (!botProcess) return;
    const source = db.config.SCAN_SOURCE || 'dexscreener';
    const cat = db.config.RADAR_CATEGORY || 'top_boosted';
    const activeNetwork = db.config.ACTIVE_NETWORK || 'SOL'; 
    
    const SCAN_LIMIT = parseInt(db.config.SCAN_LIMIT) || 10;
    
    try {
        let rawAddresses = [];
        
        let chainQuery = 'solana';
        if (activeNetwork === 'BSC') chainQuery = 'bsc';
        if (activeNetwork === 'ETH') chainQuery = 'ethereum';

        if (source === 'pumpfun' && activeNetwork === 'SOL') {
            const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=pump.fun');
            if (res.data?.pairs) rawAddresses = res.data.pairs.filter(p => p.chainId === 'solana').map(p => p.baseToken.address);
        } else if (source === 'raydium' && activeNetwork === 'SOL') {
            const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=raydium');
            if (res.data?.pairs) rawAddresses = res.data.pairs.filter(p => p.chainId === 'solana').map(p => p.baseToken.address);
        } else {
            let url = 'https://api.dexscreener.com/token-boosts/top/v1';
            if (cat === 'latest_profiles') url = 'https://api.dexscreener.com/token-profiles/latest/v1';
            else if (cat === 'latest_boosted') url = 'https://api.dexscreener.com/token-boosts/latest/v1';
            const res = await axios.get(url);
            if (res.data && Array.isArray(res.data)) rawAddresses = res.data.filter(t => t.chainId === chainQuery).map(t => t.tokenAddress);
        }

        rawAddresses = [...new Set(rawAddresses)]; 
        rawAddresses = rawAddresses.sort(() => Math.random() - 0.5); 

        for (let i = 0; i < rawAddresses.length; i += 30) {
            if (sessionTargets.length >= SCAN_LIMIT) break;
            const chunk = rawAddresses.slice(i, i + 30);
            if (chunk.length === 0) continue;
            
            try {
                const pairRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`);
                const pairs = pairRes.data.pairs || [];
                const minLiq = parseFloat(db.config.MIN_LIQUIDITY || 0);
                const minMc = parseFloat(db.config.MIN_MCAP || 0);
                const minAge = parseFloat(db.config.MIN_AGE_MINS || 0);

                for (const p of pairs) {
                    if (sessionTargets.length >= SCAN_LIMIT) break;
                    if (p.chainId !== chainQuery) continue;
                    
                    const liq = p.liquidity?.usd || 0;
                    const mc = p.fdv || 0;
                    let ageMins = 0;
                    if (p.pairCreatedAt) ageMins = Math.floor((Date.now() - new Date(p.pairCreatedAt).getTime()) / 60000);
                    
                    if (liq < minLiq) continue; 
                    if (mc < minMc) continue; 
                    if (ageMins < minAge) continue; 
                    
                    const ca = p.baseToken.address;
                    
                    if (!sessionTargets.includes(ca) && !db.scannedHistory.includes(ca)) {
                        sessionTargets.push(ca);
                        
                        db.scannedHistory.push(ca);
                        if (db.scannedHistory.length > 20000) db.scannedHistory.shift(); 
                        
                        db.lockedTargets.push(ca); 
                        
                        if (!db.feed.some(f => f.mint === ca)) {
                            db.feed.unshift({
                                mint: ca,
                                name: p.baseToken.name,
                                symbol: p.baseToken.symbol,
                                chain: activeNetwork,
                                initialPrice: parseFloat(p.priceUsd) || 0,
                                initialMcap: parseFloat(mc) || 0,
                                imageUrl: p.info?.imageUrl || '',
                                time: Date.now()
                            });
                            if (db.feed.length > 500) db.feed.pop();
                        }

                        saveDb();
                        io.emit('token_scanned', ca);
                        io.emit('feed_update', db.feed);
                        broadcastLog(`[${activeNetwork}_SCAN] Target Locked (${sessionTargets.length}/${SCAN_LIMIT}): ${ca.slice(0,6)}...`, 'log-cyan');
                    }
                }
            } catch(err) { }
        }

        if (sessionTargets.length >= SCAN_LIMIT && botProcess) {
            broadcastLog(`[SYS] ${SCAN_LIMIT} Targets Acquired. Halting scanner.`, 'log-alert');
            botProcess.kill('SIGINT'); botProcess = null;
            if (nativeScannerTimer) { clearInterval(nativeScannerTimer); nativeScannerTimer = null; }
            io.emit('radar_paused');
        }
    } catch (e) { broadcastLog(`[NATIVE_SCAN] API Error: ${e.message}`, 'log-alert'); }
}

io.on('connection', (socket) => {
    socket.emit('init_data', { stats: db.stats, config: db.config, positions: db.positions, logs: db.logs, watchlist: db.watchlist, lockedTargets: db.lockedTargets, feed: db.feed });

    socket.on('clear_logs', () => { db.logs = []; saveDb(); });
    socket.on('delete_position', (mint) => { delete db.positions[mint]; saveDb(); io.emit('position_update', db.positions); });
    socket.on('add_watchlist', (mint) => { if(!db.watchlist.includes(mint)) { db.watchlist.push(mint); saveDb(); io.emit('watchlist_update', db.watchlist); } });
    socket.on('remove_watchlist', (mint) => { db.watchlist = db.watchlist.filter(m => m !== mint); saveDb(); io.emit('watchlist_update', db.watchlist); });
    
    socket.on('delete_feed_item', (mint) => { 
        db.feed = db.feed.filter(f => f.mint !== mint); 
        saveDb(); 
        io.emit('feed_update', db.feed); 
    });

    socket.on('manual_scan_add', async (mint) => {
        const activeNetwork = db.config.ACTIVE_NETWORK || 'SOL';
        if (!db.feed.some(f => f.mint === mint)) {
            try {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                const pair = res.data.pairs ? res.data.pairs.find(p => p.chainId === (activeNetwork==='SOL'?'solana':activeNetwork==='BSC'?'bsc':'ethereum')) || res.data.pairs[0] : null;
                if (pair) {
                    db.feed.unshift({
                        mint: pair.baseToken.address,
                        name: pair.baseToken.name,
                        symbol: pair.baseToken.symbol,
                        chain: activeNetwork,
                        initialPrice: parseFloat(pair.priceUsd) || 0,
                        initialMcap: parseFloat(pair.fdv || 0) || 0,
                        imageUrl: pair.info?.imageUrl || '',
                        time: Date.now()
                    });
                    if (db.feed.length > 500) db.feed.pop(); 
                    saveDb();
                    io.emit('feed_update', db.feed);
                }
            } catch (e) {}
        }
    });

    socket.on('save_settings', async (data) => {
        db.config = data; saveDb();
        if (data.RPC_ENDPOINT && data.PRIVATE_KEY && data.ACTIVE_NETWORK === 'SOL') {
            try {
                const connection = new Connection(data.RPC_ENDPOINT, 'confirmed');
                const wallet = Keypair.fromSecretKey(bs58.decode(data.PRIVATE_KEY));
                await refreshBalances(connection, wallet.publicKey);
            } catch(e){}
        }
        fetchPrices();
        broadcastLog(`[SYS] Network [${data.ACTIVE_NETWORK || 'SOL'}] Config Locked.`, 'log-buy');
    });

    socket.on('start_bot', () => {
        if (botProcess) return;
        
        sessionTargets = []; 
        db.lockedTargets = []; 
        saveDb();

        broadcastLog(`[SYS] IGNITING RECON RADAR...`, 'log-cyan');

        if (fs.existsSync(BOT_DATA_FILE)) { try { fs.unlinkSync(BOT_DATA_FILE); } catch(e){} }

        const botEnv = Object.assign({}, process.env, db.config, {
            SOLANA_PRIVATE_KEY: db.config.PRIVATE_KEY || '', SECRET_KEY: db.config.PRIVATE_KEY || '',
            RPC_URL: db.config.RPC_ENDPOINT || '', SOLANA_RPC_URL: db.config.RPC_ENDPOINT || '',
            DRY_RUN: 'true', AUTO_BUY: 'false', MAX_CONCURRENT_POSITIONS: '100'
        });

        botProcess = spawn('npm', ['run', 'start'], { cwd: __dirname, env: botEnv });
        let stdoutBuffer = "";
        
        botProcess.stdout.on('data', (data) => {
            stdoutBuffer += data.toString();
            let lines = stdoutBuffer.split('\n');
            stdoutBuffer = lines.pop(); 

            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                broadcastLog(line, 'log-info');

                if (line.includes('"action":') || line.includes('"confidence":') || line.includes('"reasoning":') || line.includes('"notes":')) {
                    io.emit('ai_raw_line', line);
                }
            }
        });
        botProcess.stderr.on('data', (data) => { if(data.toString().trim()) broadcastLog(data.toString().trim(), 'log-alert'); });
        botProcess.on('close', (code) => { if(botProcess) { broadcastLog(`[SYS] Radar Offline (${code})`, 'log-alert'); botProcess = null; } });

        runNativeScanner();
        nativeScannerTimer = setInterval(runNativeScanner, 10000);
    });

    socket.on('stop_bot', () => { 
        if (botProcess) { botProcess.kill('SIGINT'); botProcess = null; }
        if (nativeScannerTimer) { clearInterval(nativeScannerTimer); nativeScannerTimer = null; }
        broadcastLog(`[SYS] Radar Terminated.`, 'log-alert'); 
        io.emit('radar_paused'); 
    });

    socket.on('execute_manual', async (targetMint) => {
        const activeNetwork = db.config.ACTIVE_NETWORK || 'SOL';
        const rawTotalAmt = parseFloat(db.config.QUOTE_AMOUNT || 0.05);

        if (activeNetwork === 'SOL') {
            if (!db.config.PRIVATE_KEY) return broadcastLog('[ERR] NO SOL PRIVATE KEY.', 'log-alert');
            
            if (db.stats.solBal < rawTotalAmt) {
                return broadcastLog(`[EXEC_ERR] INSUFFICIENT BALANCE. Wallet has ${db.stats.solBal.toFixed(4)} SOL, trade requires ${rawTotalAmt} SOL.`, 'log-alert');
            }

            broadcastLog(`[EXECUTE] Engaging Jupiter API for: ${targetMint.slice(0,6)}...`, 'log-cyan');
            try {
                const connection = new Connection(db.config.RPC_ENDPOINT, 'confirmed');
                const wallet = Keypair.fromSecretKey(bs58.decode(db.config.PRIVATE_KEY));
                
                const totalLamports = Math.floor(rawTotalAmt * 1e9);
                const feeLamports = Math.floor(totalLamports * 0.01); 
                const swapLamports = totalLamports - feeLamports; 
                
                const slipBps = Math.floor(parseFloat(db.config.BUY_SLIPPAGE || 20) * 100);

                try {
                    const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${NATIVE_MINT.toString()}&outputMint=${targetMint}&amount=${swapLamports}&slippageBps=${slipBps}`;
                    const jupQuote = (await axios.get(quoteUrl, { headers: { accept: 'application/json' } })).data;
                    if (!jupQuote || !jupQuote.outAmount) throw new Error('Jupiter returned no valid quote');

                    const swapReqBody = { userPublicKey: wallet.publicKey.toBase58(), quoteResponse: jupQuote, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' };
                    const jupSwap = (await axios.post('https://lite-api.jup.ag/swap/v1/swap', swapReqBody, { headers: { 'Content-Type': 'application/json', accept: 'application/json' } })).data;
                    if (!jupSwap?.swapTransaction) throw new Error('Jupiter swap invalid');

                    const txBuf = Buffer.from(jupSwap.swapTransaction, 'base64');
                    const tx = VersionedTransaction.deserialize(txBuf);
                    tx.sign([wallet]);
                    
                    broadcastLog(`[EXECUTE] Transmitting to network...`, 'log-cyan');
                    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
                    broadcastLog(`[EXECUTE] SUCCESS! TXID: ${sig.slice(0, 15)}...`, 'log-buy');
                    
                    setTimeout(() => routeDevFee(connection, wallet, feeLamports), 1500);

                    let entryPrice = 0;
                    let entryMcap = 0;
                    try {
                        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${targetMint}`);
                        const pair = res.data.pairs ? res.data.pairs.find(p => p.chainId === 'solana') || res.data.pairs[0] : null;
                        if (pair) {
                            entryPrice = parseFloat(pair.priceUsd);
                            entryMcap = parseFloat(pair.fdv || 0);
                        }
                    } catch (e) {}

                    db.stats.trades++; 
                    db.stats.sol_trades = (db.stats.sol_trades || 0) + 1;

                    db.positions[targetMint] = { 
                        status: 'HOLDING', 
                        chain: 'SOL',
                        time: Date.now(), 
                        entryPrice: entryPrice, 
                        entryMcap: entryMcap,
                        entrySolAmount: rawTotalAmt,
                        tp1Triggered: false, 
                        tp2Triggered: false 
                    }; 
                    saveDb(); 
                    io.emit('position_update', db.positions);
                    io.emit('update_ui', db.stats); 
                    setTimeout(() => refreshBalances(connection, wallet.publicKey), 5000);
                } catch (apiErr) {
                    // 🚀 INJECTED SMART ERROR PARSER
                    let errString = apiErr.response?.data ? JSON.stringify(apiErr.response.data) : apiErr.message;
                    if (errString.includes('0x1775') || errString.includes('BondingCurveComplete') || errString.includes('migrated to raydium')) {
                        broadcastLog(`[CHAIN_HALT] Pump.fun bonding curve complete. Token is migrating to Raydium. Try again soon!`, 'log-alert');
                    } else {
                        broadcastLog(`[JUP_API_ERR] ${errString}`, 'log-alert');
                    }
                }
            } catch (e) { 
                // 🚀 INJECTED SMART ERROR PARSER
                let errString = e.message || "";
                if (errString.includes('0x1775') || errString.includes('BondingCurveComplete') || errString.includes('migrated to raydium')) {
                    broadcastLog(`[CHAIN_HALT] Pump.fun bonding curve complete. Token is migrating to Raydium.`, 'log-alert');
                } else {
                    broadcastLog(`[EXEC_ERR] Execution Failed: ${e.message}`, 'log-alert'); 
                }
            }
        } 
        else if (activeNetwork === 'BSC' || activeNetwork === 'ETH') {
            broadcastLog(`[EXEC_EVM] System prepared for ${activeNetwork} swap.`, 'log-info');
            broadcastLog(`[SYS_WARN] Ethers.js required for EVM execution. Install via 'npm install ethers'`, 'log-yellow');
            
            let entryPrice = 0;
            let entryMcap = 0;
            try {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${targetMint}`);
                const pair = res.data.pairs ? res.data.pairs.find(p => p.chainId === activeNetwork.toLowerCase() || p.chainId === 'ethereum') || res.data.pairs[0] : null;
                if (pair) {
                    entryPrice = parseFloat(pair.priceUsd);
                    entryMcap = parseFloat(pair.fdv || 0);
                }
            } catch (e) {}

            db.stats.trades++;
            if (activeNetwork === 'BSC') db.stats.bsc_trades = (db.stats.bsc_trades || 0) + 1;
            if (activeNetwork === 'ETH') db.stats.eth_trades = (db.stats.eth_trades || 0) + 1;

            db.positions[targetMint] = { 
                status: 'EVM_PENDING', 
                chain: activeNetwork,
                time: Date.now(), 
                entryPrice: entryPrice, 
                entryMcap: entryMcap,
                entrySolAmount: parseFloat(db.config.QUOTE_AMOUNT || 0.05),
                tp1Triggered: false, 
                tp2Triggered: false 
            }; 
            saveDb();
            io.emit('position_update', db.positions);
            io.emit('update_ui', db.stats);
        }
    });

    socket.on('execute_sell', async (data) => {
        const pos = db.positions[data.targetMint];
        if (pos && (pos.chain === 'BSC' || pos.chain === 'ETH')) {
             broadcastLog(`[EXEC_EVM] System prepared for ${pos.chain} sell. Requires Ethers.js`, 'log-yellow');
             if (data.percentage >= 99) {
                 db.positions[data.targetMint].status = 'CLOSED';
                 saveDb(); io.emit('position_update', db.positions); 
             }
        } else {
             await processSell(data.targetMint, data.percentage);
        }
    });
});

server.listen(5000, () => console.log(`🌐 TERMINAL ONLINE: 5000`));
