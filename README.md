# Kamino Finance Flash Loan

A basic implementation of flash loans using Kamino Finance's lending protocol on Solana.

## Prerequisites

- Node.js 18+
- A Solana wallet with some USDC & SOL (to cover the flash loan and network fees)
- A Helius RPC API key (or another Solana RPC provider)

## Setup

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd kamino-flashloan
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your settings:
   - `RPC_URL` - Your Helius RPC URL (get one at [helius.dev](https://helius.dev))
   - `PRIVATE_KEY_PATH` - Path to your wallet keypair file
   - `FLASH_LOAN_AMOUNT` - Amount to borrow in lamports (default: 10000000 = 10 USDC)

4. **Ensure your wallet has USDC**
   - You need USDC & SOL in your wallet to cover the flash loan and network fees
   - The fee is calculated based on the borrow amount

## Running

```bash
npm run dev
```

This will build the TypeScript and execute the flash loan.

## How It Works

1. Loads your wallet and connects to the Kamino market
2. Displays reserve balances (available liquidity, borrow rates, flash loan fees)
3. Borrows USDC from the Kamino reserve
4. Repays the flash loan with the fee

**Note:** This is a basic implementation. In production, you would add strategy instructions (arbitrage, liquidation, etc.) between the borrow and repay instructions to generate profit that covers the flash loan fee.

## Example Transaction

An example of a flash loan transaction on Solana:

[https://solscan.io/tx/3kEGZSYg7t2rWpzRTE5oguQRxFSq9fxh7VavupRG9fufcgV67274jM5jmJ5AjP6Kruif6SDzoB6vFyktG6Mijdey](https://solscan.io/tx/3kEGZSYg7t2rWpzRTE5oguQRxFSq9fxh7VavupRG9fufcgV67274jM5jmJ5AjP6Kruif6SDzoB6vFyktG6Mijdey)
