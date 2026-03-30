# 🎯 Snipe Spirit: Multi-Chain Sniper Terminal

Advanced AI-powered trading command center that discovers trending tokens across Solana, BSC, and Ethereum, analyzes them with built-in sentiment intelligence, and executes trades with zero-recycle memory.

> **Built by [AnointingPaschal](https://github.com/AnointingPaschal)** — Upgraded from a simple CLI script into a full-scale, locally hosted institutional trading UI.

![Solana](https://img.shields.io/badge/Solana-SVM-purple)
![Binance](https://img.shields.io/badge/Binance-EVM-yellow)
![Ethereum](https://img.shields.io/badge/Ethereum-EVM-blue)
![License](https://img.shields.io/badge/License-MIT-green)

![Snipe Spirit Dashboard](132127.jpg)

## ⚡ Features

- **Multi-Chain Architecture:** Seamlessly switch between Solana (Jupiter API), BSC, and Ethereum (Ethers.js ready) directly from the UI.
- **Zero-Recycle Scanner:** Permanent local database memory ensures you never scan or see the same token twice. Always 100% fresh targets.
- **Live Signals Feed:** Dedicated intelligence tab that snapshots entry Market Cap and Price, tracking real-time multiplier (X) gains.
- **Advanced Auto-Sell:** Built-in Stop-Loss, Take-Profit 1 (Partial Sell), and Take-Profit 2 (Moonbag) mechanics.
- **Smart Chain Guards:** Natively catches and handles Pump.fun to Raydium migration halts without crashing.
- **Nuclear Balance Scanner:** Forces deep RPC polling to find exact fractional token balances (down to the 9th decimal).
- **Institutional UI:** Fully interactive dashboard with live floating PnL, token header banners, DexScreener integrations, and feed pagination.

## 🧠 How The Brain Works

The bot analyzes tokens across multiple networks using dynamic filters configurable in the UI:

| Signal | What it checks | Impact |
|--------|---------------|--------|
| **Liquidity & MCAP** | Configurable minimums (e.g., $5K Liq, $10K MC) | Filters out completely dead pairs |
| **Token Age** | Configurable age minimums | Ensures tokens survive initial block-0 dumps |
| **AI Sentiment** | On-the-fly reasoning matrix | Outputs Enter/Skip confidence scores |
| **Buy/Sell Pressure** | 24H transaction ratios | Visualized natively in the UI progress bars |
| **Network Segregation** | Checks native chain | Prevents crossing SOL trades with EVM chains |
| **Security Validation** | RugCheck & Burn checks | Blocks honeypots (Solana specific) |
| **Smart Interceptor** | `0x1775` Catching | Prevents execution during Pump.fun migrations |
| **Zero-Recycle** | `scannedHistory` ledger | Instantly rejects any previously seen contract |

Only displays targets that pass your exact UI configuration limits.

## 📁 Project Structure

```text
Snipe-Spirit/
├── server.cjs          # Main backend — Multi-chain routing, scanning, and Socket.io
├── public/
│   └── index.html      # Institutional Frontend UI (Dashboard, Vault, Feed, Terminal)
├── database.json       # (GitIgnored) Persistent local memory, keys, and PnL states
├── .env                # (GitIgnored) Local environment variables 
├── .gitignore          # Shield protecting private keys and databases
└── README.md           # Documentation
```

## 🚀 Quick Start

### Prerequisites
- **Node.js** v18+
- **Ethers.js** (Required for EVM trading: `npm install ethers`)
- **A Solana, BSC, or ETH wallet** funded for gas.

### Setup

```bash
# 1. Clone the repo
git clone [https://github.com/AnointingPaschal/Snipe-Spirit.git](https://github.com/AnointingPaschal/Snipe-Spirit.git)
cd Snipe-Spirit

# 2. Install dependencies
npm install express socket.io axios @solana/web3.js @solana/spl-token bs58 ethers

# 3. Boot the terminal
node server.cjs
```

### Configure via UI (No .env needed)

Open `http://localhost:5000` in your browser.
Click **Core Settings** to input:
* Active Network (SOL, BSC, ETH)
* Private Keys (Base58 for SOL, 0x for EVM)
* RPC Endpoints
* Base Buy Amounts

## 💡 How It Works (Step by Step)

```text
1. DISCOVER  → Scans DexScreener, Pump.fun, or Raydium based on UI config.
              → Pulls up to 50 targets, cross-references against permanent memory.

2. VALIDATE  → Filters out all duplicates and previously seen tokens.
              → Checks Minimum Liquidity, MCAP, and Age parameters.

3. ENRICH    → Pulls live token banners, socials, and Buy/Sell pressure.
              → Snaps initial Price and MCAP for the Live Signals Feed.

4. DECIDE    → AI Sentiment engine analyzes the token.
              → Populates the Scanner and Live Feed for manual review.

5. EXECUTE   → User clicks "Execute Buy" in the UI.
              → Backend intercepts, extracts 1% Dev Fee, and routes 99% via Jupiter/PancakeSwap.

6. MONITOR   → Moves token to Open Positions Vault.
              → Auto-sells at predefined Stop-Loss (-20%) or multi-stage Take-Profits.
              → Live floating PnL perfectly segregated by active network.
```

## 🔧 Configuration

All configurations are handled completely visually via the UI Modals. No manual text editing required.

| Variable | Default | Description |
|----------|---------|-------------|
| `ACTIVE_NETWORK` | `SOL` | Toggles dashboard, balances, and routing between SOL/BSC/ETH |
| `SCAN_LIMIT` | `10` | Maximum fresh tokens to pull per scan |
| `QUOTE_AMOUNT` | `0.05` | Base currency amount to spend per trade |
| `SCAN_SOURCE` | `dexscreener` | Source for targets (DexScreener, Pump.fun, Raydium) |
| `MIN_LIQUIDITY` | `5000` | Minimum pool USD to consider |
| `MIN_MCAP` | `10000` | Minimum Market Cap USD to consider |
| `AUTO_SELL_ENABLED`| `false` | Enables the background monitor for automated exits |
| `STOP_LOSS_PERCENT`| `-20` | Auto-sell 100% loss threshold |
| `TP1_PERCENT` | `100` | Take-Profit Stage 1 Gain trigger |
| `TP1_AMOUNT` | `50` | Take-Profit Stage 1 Sell Amount (%) |

## 📊 Example Output

```text
> [SYS] IGNITING RECON RADAR...
> [SOL_SCAN] Target Locked (1/10): F9ytdb...
> [SOL_SCAN] Target Locked (2/10): 3TYgKw...
> [SYS] 10 Targets Acquired. Halting scanner.
> [EXECUTE] Engaging Jupiter API for: F9ytdb...
> [EXECUTE] Transmitting to network...
> [CHAIN_HALT] Pump.fun bonding curve complete. Token is migrating to Raydium. Try again soon!
> [EXECUTE] Engaging Jupiter API for: 3TYgKw...
> [EXECUTE] Transmitting to network...
> [EXECUTE] SUCCESS! TXID: 4xRqPv9LmK...
> [AUTO-SELL] TAKE-PROFIT 1 TRIGGERED (115.00%) for 3TYgKw
> [EXECUTE] Routing Sell: 50% of 3TYgKw...
> [EXECUTE] SELL SUCCESS! TXID: 5yTrQw...
```

## ⚠️ Disclaimers

- **This is experimental trading software.** Use at your own risk.
- **Private Keys:** Never upload your `database.json` file. It is git-ignored by default. Snipe Spirit runs locally to ensure your private keys never leave your device.
- **Memecoins are extremely volatile.** You can lose everything.
- **Not financial advice.** Do your own research.

## 🤝 Contributing

PRs welcome! Some ideas:
- Full Ethers.js ABI implementation for PancakeSwap/Uniswap execution.
- Telegram notification integration.
- Hardware Wallet (Ledger/Trezor) adapter support.

## 📜 License

MIT — do whatever you want with it. If you make money, enjoy the snipes! ☕

---

**Built with precision by [AnointingPaschal](https://github.com/AnointingPaschal)**
