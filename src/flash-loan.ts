import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  address,
  createKeyPairSignerFromBytes,
  pipe,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  sendAndConfirmTransactionFactory,
  sendTransactionWithoutConfirmingFactory,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  fetchEncodedAccount,
} from "@solana/kit";
import {
  KaminoMarket,
  KaminoReserve,
  PROGRAM_ID,
  lendingMarketAuthPda,
  getFlashLoanInstructions,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@kamino-finance/klend-sdk";
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
} from "@solana/transaction-messages";
import { compileTransaction, signTransaction } from "@solana/transactions";
import { createKeyPairFromBytes } from "@solana/keys";
import { none } from "@solana/options";
import Decimal from "decimal.js";

/*
 * Configuration constants for the Kamino Flash Loan demo.
 * Values are loaded from environment variables with sensible defaults.
 */
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PRIVATE_KEY_PATH =
  process.env.PRIVATE_KEY_PATH ||
  path.join(process.env.HOME || "", ".config/solana/id.json");
const KAMINO_MARKET_ADDRESS =
  process.env.KAMINO_MARKET_ADDRESS ||
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const SOL_MINT =
  process.env.SOL_MINT || "So11111111111111111111111111111111111111112";
const USDC_MINT =
  process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/*
 * Default amount for flash loan in lamports.
 * 1000000 = 1 USDC (assuming 6 decimals for USDC mint).
 */
const FLASH_LOAN_AMOUNT = process.env.FLASH_LOAN_AMOUNT || "1000000";

/*
 * Default duration in milliseconds for determining if a slot is recent.
 * Used when loading the Kamino market to cache reserve states.
 */
const DEFAULT_RECENT_SLOT_DURATION_MS = 400;

/*
 * Represents the balance and state information of a reserve.
 */
interface ReserveBalance {
  symbol: string;
  mint: string;
  availableAmount: Decimal;
  borrowedAmount: Decimal;
  flashLoanFee: Decimal;
  decimals: number;
  totalDeposits: Decimal;
  totalBorrows: Decimal;
}

/**
 * Read a u64 value from a Uint8Array at the given offset (little-endian).
 * Token accounts store the amount at byte offset 64.
 */
function readUint64LE(data: Uint8Array, offset: number): bigint {
  let result = BigInt(0);
  for (let i = 0; i < 8; i++) {
    result += BigInt(data[offset + i]) << BigInt(i * 8);
  }
  return result;
}

/*
 * Load wallet from file path and return both a signer and keyPair.
 * @param walletPath - Path to the JSON file containing the private key
 * @returns Object containing the KeyPairSigner and KeyPair for transaction signing
 */
async function loadWallet(walletPath: string) {
  const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const walletBytes = new Uint8Array(walletData);
  const signer = await createKeyPairSignerFromBytes(walletBytes);
  const keyPair = await createKeyPairFromBytes(walletBytes, false);
  return { signer, keyPair };
}

/*
 * Retrieves the current balance information for a given reserve.
 * @param reserve - The KaminoReserve to query
 * @returns Promise<ReserveBalance> containing available amount, borrowed amount, fees, and totals
 */
async function getReserveBalances(
  reserve: KaminoReserve,
): Promise<ReserveBalance> {
  const availableAmount = reserve.getLiquidityAvailableAmount();
  const borrowedAmount = reserve.getBorrowedAmount();
  const flashLoanFee = reserve.getFlashLoanFee();
  const decimals = reserve.getMintDecimals();

  /*
   * Calculate totals from state by dividing the collateral mint total supply
   * by the mint factor to get the actual token amount.
   */
  const mintTotalSupply = new Decimal(
    reserve.state.collateral.mintTotalSupply.toString(),
  ).div(reserve.getMintFactor());

  return {
    symbol: reserve.getTokenSymbol(),
    mint: reserve.getLiquidityMint().toString(),
    availableAmount,
    borrowedAmount,
    flashLoanFee,
    decimals,
    totalDeposits: mintTotalSupply,
    totalBorrows: borrowedAmount,
  };
}

/**
 * Fetch the token balance of a given ATA address.
 * Returns 0n if the account does not exist or cannot be read.
 *
 * Token account layout (SPL Token):
 *   0-32:  mint
 *   32-64: owner
 *   64-72: amount (u64 LE)
 */
async function getTokenBalance(
  rpc: ReturnType<typeof createSolanaRpc>,
  ataAddress: string,
): Promise<bigint> {
  try {
    const account = await fetchEncodedAccount(rpc, address(ataAddress));
    /*
     * fetchEncodedAccount throws if account doesn't exist, but the type
     * is MaybeEncodedAccount so we need to narrow with exists check
     */
    if (!account.exists) {
      return 0n;
    }
    /* Token account: amount is at byte offset 64, stored as u64 LE */
    if (account.data.length >= 72) {
      return readUint64LE(account.data, 64);
    }
    return 0n;
  } catch {
    /* Account does not exist or cannot be fetched */
    return 0n;
  }
}

/*
 * Derive the WebSocket URL from an HTTP RPC URL.
 * e.g. https://beta.helius-rpc.com/... -> wss://beta.helius-rpc.com/...
 */
function httpToWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^https?:\/\//, "wss://");
}

/*
 * Main function that orchestrates the entire flash loan execution.
 * Handles wallet loading, market connection, reserve selection, fee calculation,
 * transaction building, signing, and submission to the network.
 */
async function executeFlashLoan() {
  console.log("=== Kamino Flash Loan Demo ===\n");

  // 1. Load wallet
  console.log("1. Loading wallet...");
  const { signer: owner, keyPair } = await loadWallet(PRIVATE_KEY_PATH);
  console.log(`   Wallet address: ${owner.address}`);

  // 2. Create RPC client
  console.log("\n2. Connecting to Helius RPC...");
  const rpc = createSolanaRpc(RPC_URL);
  console.log(`   RPC: ${RPC_URL.substring(0, 50)}...`);

  // 3. Load Kamino Market
  console.log("\n3. Loading Kamino Market...");
  const marketAddress = address(KAMINO_MARKET_ADDRESS);
  const market = await KaminoMarket.load(
    rpc,
    marketAddress,
    DEFAULT_RECENT_SLOT_DURATION_MS,
    PROGRAM_ID,
  );

  if (!market) {
    throw new Error(`Failed to load Kamino market at ${KAMINO_MARKET_ADDRESS}`);
  }
  console.log(`   Market loaded: ${marketAddress}`);
  console.log(`   Number of reserves: ${market.reserves.size}`);

  // 4. Display all reserves with their balances
  console.log("\n4. Reserve Balances:");
  console.log("   -------------------------------------------");

  for (const [_reserveAddr, reserve] of market.reserves) {
    const balance = await getReserveBalances(reserve);
    console.log(`\n   ${balance.symbol} (${balance.mint.substring(0, 8)}...)`);
    console.log(`      Available: ${balance.availableAmount.toString()}`);
    console.log(`      Borrowed: ${balance.borrowedAmount.toString()}`);
    console.log(
      `      Total Deposits (cToken supply): ${balance.totalDeposits.toString()}`,
    );
    console.log(`      Flash Loan Fee: ${balance.flashLoanFee.toString()}`);
    console.log(`      Decimals: ${balance.decimals}`);
  }

  // 5. Select a reserve for flash loan
  console.log("\n5. Selecting reserve for flash loan...");
  let selectedReserve = market.getReserveByMint(address(USDC_MINT));

  if (!selectedReserve) {
    console.log("   USDC reserve not found, trying SOL...");
    selectedReserve = market.getReserveByMint(address(SOL_MINT));
    if (!selectedReserve) {
      throw new Error("No suitable reserve found for flash loan");
    }
  }

  const reserveBalance = await getReserveBalances(selectedReserve);
  console.log(`   Using ${reserveBalance.symbol} reserve`);

  // 6. Get flash loan details
  console.log("\n6. Flash Loan Configuration:");
  console.log("   -------------------------------------------");

  const flashLoanFee = selectedReserve.getFlashLoanFee();
  const mintDecimals = selectedReserve.getMintDecimals();
  const amountToBorrow = new Decimal(FLASH_LOAN_AMOUNT);

  console.log(`   Reserve: ${selectedReserve.address}`);
  console.log(`   Flash Loan Fee Rate: ${flashLoanFee.toString()}`);
  console.log(`   Mint Decimals: ${mintDecimals}`);
  console.log(
    `   Borrow Amount: ${amountToBorrow.toString()} lamports (from FLASH_LOAN_AMOUNT env var)`,
  );

  /*
   * 7. Calculate fees using the SDK's built-in fee calculator.
   * This matches the on-chain calculation exactly.
   */
  const referralFeeBps = Number(market.state.referralFeeBps);
  const hasReferrer = false; /* No referrer in this demo */
  const { protocolFees, referrerFees } = selectedReserve.calculateFlashLoanFees(
    amountToBorrow,
    referralFeeBps,
    hasReferrer,
  );
  const totalFee = protocolFees.add(referrerFees);
  const repayAmount = amountToBorrow.add(totalFee);

  console.log(`   Protocol Fee: ${protocolFees.toString()} lamports`);
  console.log(`   Referrer Fee: ${referrerFees.toString()} lamports`);
  console.log(`   Total Fee: ${totalFee.toString()} lamports`);
  console.log(
    `   Repay Amount (principal + fee): ${repayAmount.toString()} lamports`,
  );

  // 8. Get lending market authority PDA
  const lendingMarketAuth = await lendingMarketAuthPda(
    market.address,
    market.programId,
  );
  console.log(`\n   Lending Market: ${market.address}`);
  console.log(`   Lending Market Auth: ${lendingMarketAuth[0]}`);

  // 9. Get reserve liquidity vaults
  console.log("\n7. Reserve Liquidity Vaults:");
  console.log(
    `   Supply Vault: ${selectedReserve.state.liquidity.supplyVault}`,
  );
  console.log(`   Fee Vault: ${selectedReserve.state.liquidity.feeVault}`);

  // 10. Get destination ATA for the borrowed tokens
  console.log("\n8. Getting Destination ATA...");
  const liquidityMint = selectedReserve.getLiquidityMint();
  const destinationAta = await getAssociatedTokenAddress(
    liquidityMint,
    owner.address,
    selectedReserve.getLiquidityTokenProgram(),
  );
  console.log(`   Destination ATA: ${destinationAta}`);

  /*
   * 11. Check the user's ATA balance BEFORE the flash loan.
   * The flash loan borrows X tokens to the ATA, but the repay instruction
   * needs X + fee tokens. The fee must come from the user's existing balance.
   */
  console.log("\n9. Checking ATA balance for fee coverage...");
  const currentAtaBalance = await getTokenBalance(
    rpc,
    destinationAta.toString(),
  );
  const mintFactor = new Decimal(10).pow(mintDecimals);
  console.log(
    `   Current ATA Balance: ${currentAtaBalance.toString()} lamports (${new Decimal(currentAtaBalance.toString()).div(mintFactor).toString()} tokens)`,
  );
  console.log(
    `   Required Fee: ${totalFee.toString()} lamports (${totalFee.div(mintFactor).toString()} tokens)`,
  );

  if (currentAtaBalance < BigInt(totalFee.floor().toString())) {
    const feeNeeded = BigInt(totalFee.floor().toString()) - currentAtaBalance;
    console.error("\n   ❌ INSUFFICIENT BALANCE FOR FLASH LOAN FEE");
    console.error(
      `   Your ATA has ${currentAtaBalance.toString()} lamports but needs ${totalFee.floor().toString()} lamports for the fee.`,
    );
    console.error(
      `   You need at least ${feeNeeded.toString()} more lamports (${new Decimal(feeNeeded.toString()).div(mintFactor).toString()} tokens) in your ATA.`,
    );
    console.error("\n   How to fix:");
    console.error("   1. Transfer some tokens to your ATA to cover the fee");
    console.error("   2. Reduce FLASH_LOAN_AMOUNT to lower the fee");
    console.error(
      "   3. Add arbitrage/swap instructions between borrow and repay to generate profit",
    );
    console.error(
      "\n   Note: Flash loans borrow X tokens and require X + fee to repay.",
    );
    console.error(
      "   The fee must come from your existing ATA balance or profits from intermediate operations.",
    );
    process.exit(1);
  }
  console.log(`   ✅ Sufficient balance for fee coverage`);

  // 12. Create ATA if needed
  console.log("\n10. Creating ATA if needed...");
  const [ataAddress, createAtaIx] =
    await createAssociatedTokenAccountIdempotentInstruction(
      owner,
      liquidityMint,
      owner.address,
      selectedReserve.getLiquidityTokenProgram(),
      destinationAta,
    );
  console.log(`   ATA Address: ${ataAddress}`);
  console.log(`   Create ATA Instruction: ${createAtaIx.programAddress}`);

  // 13. Get flash loan instructions
  console.log("\n11. Getting Flash Loan Instructions...");
  const { flashBorrowIx, flashRepayIx } = getFlashLoanInstructions({
    borrowIxIndex: 1 /* Index after the ATA creation instruction */,
    userTransferAuthority: owner,
    lendingMarketAuthority: lendingMarketAuth[0],
    lendingMarketAddress: market.address,
    reserve: selectedReserve,
    amountLamports: amountToBorrow,
    destinationAta: ataAddress,
    referrerAccount: none(),
    referrerTokenState: none(),
    programId: market.programId,
  });
  console.log(`   Flash Borrow Instruction: ${flashBorrowIx.programAddress}`);
  console.log(`   Flash Repay Instruction: ${flashRepayIx.programAddress}`);

  // 14. Build the transaction
  console.log("\n12. Building Transaction...");

  /* Get recent blockhash from the network to set transaction expiry */
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  /* Create transaction message with version 0 (legacy format) */
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner.address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        m,
      ),
    (m) => appendTransactionMessageInstruction(createAtaIx, m),
    (m) => appendTransactionMessageInstruction(flashBorrowIx, m),
    /*
     * In a real scenario, you would add your strategy instructions here
     * (arbitrage, liquidation, etc.) between the borrow and repay.
     * The profit from these operations must cover the flash loan fee.
     */
    (m) => appendTransactionMessageInstruction(flashRepayIx, m),
  );

  console.log(
    `   Transaction created with ${transactionMessage.instructions.length} instructions`,
  );
  console.log(`   Blockhash: ${latestBlockhash.blockhash.substring(0, 20)}...`);

  // 15. Compile the transaction
  console.log("\n13. Compiling Transaction...");
  const transaction = compileTransaction(transactionMessage);
  console.log(
    `   Compiled transaction with ${Object.keys(transaction.signatures).length} signers required`,
  );

  // 16. Sign the transaction
  console.log("\n14. Signing Transaction...");
  const signedTransaction = await signTransaction([keyPair], transaction);
  console.log(`   Transaction signed`);

  // 17. Send and confirm the transaction
  console.log("\n15. Sending Transaction...");

  /*
   * Try to use sendAndConfirmTransactionFactory with WebSocket subscriptions
   * for proper on-chain confirmation. Fall back to fire-and-forget if WS fails.
   */
  let confirmed = false;
  try {
    const wsUrl = httpToWsUrl(RPC_URL);
    const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
    const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions,
    });

    await sendAndConfirmTransaction(signedTransaction, {
      commitment: "confirmed",
      skipPreflight: true,
    });
    confirmed = true;
    console.log("   ✅ Transaction confirmed on-chain!");
  } catch (confirmError: any) {
    /* If confirmation fails, try to extract meaningful error info */
    const errorMessage =
      confirmError?.message || confirmError?.toString() || "Unknown error";

    if (errorMessage.includes("not been confirmed")) {
      /* Transaction was sent but not confirmed in time - it may still succeed */
      console.log("   ⚠️  Transaction sent but not yet confirmed.");
      console.log("   Check the transaction status on Solscan.");
    } else if (
      errorMessage.includes("failed") ||
      errorMessage.includes("Error")
    ) {
      console.error("   ❌ Transaction failed on-chain:", errorMessage);
      confirmed = true; /* We know it failed, don't retry */
    } else {
      /* WebSocket connection issue - fall back to fire-and-forget */
      console.log(
        "   ⚠️  Could not confirm via WebSocket, falling back to fire-and-forget...",
      );
    }
  }

  /* If we couldn't confirm via WebSocket, use fire-and-forget as fallback */
  if (!confirmed) {
    try {
      const sendTransaction = sendTransactionWithoutConfirmingFactory({ rpc });
      await sendTransaction(signedTransaction, {
        commitment: "confirmed",
        skipPreflight: true,
      });
      console.log("   Transaction sent (fire-and-forget mode).");
      console.log(
        "   ⚠️  Note: Transaction was sent but confirmation was not verified.",
      );
      console.log("   Check the transaction status on Solscan.");
    } catch (e) {
      if (
        isSolanaError(
          e,
          SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
        )
      ) {
        console.error("   ❌ Transaction failed in simulation:", e.cause);
      } else {
        throw e;
      }
    }
  }

  console.log("\n=== Flash Loan Execution Complete ===");
}

/*
 * Entry point for the flash loan demo application.
 * Wraps executeFlashLoan in a try-catch to handle and display errors gracefully.
 */
async function main() {
  try {
    await executeFlashLoan();
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
