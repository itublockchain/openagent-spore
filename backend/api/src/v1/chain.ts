import { ethers } from 'ethers'
import * as fs from 'fs'
import * as path from 'path'
import SwarmTreasuryABI from '../../../../contracts/artifacts/src/SwarmTreasury.sol/SwarmTreasury.json'
import SwarmEscrowABI from '../../../../contracts/artifacts/src/SwarmEscrow.sol/SwarmEscrow.json'
import USDCGatewayABI from '../../../../contracts/artifacts/src/USDCGateway.sol/USDCGateway.json'
import CCTPDepositReceiverABI from '../../../../contracts/artifacts/src/CCTPDepositReceiver.sol/CCTPDepositReceiver.json'
import ogDeployments from '../../../../contracts/deployments/og_testnet.json'

// Minimal MessageTransmitterV2 ABI — we only need receiveMessage to relay
// attested CCTP burns into Base Sepolia, plus MessageSent event so the
// CCTPRelayer can derive messageHash from a source-chain burn receipt.
const MESSAGE_TRANSMITTER_V2_ABI = [
  {
    type: 'function',
    name: 'receiveMessage',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'MessageSent',
    inputs: [{ name: 'message', type: 'bytes', indexed: false }],
  },
] as const

const ETH_SEPOLIA_CHAIN_ID = 11155111
const ARB_SEPOLIA_CHAIN_ID = 421614

export const CCTP_SOURCE_CHAINS: Record<number, { domain: number; rpcUrl: string; name: string }> = {
  [ETH_SEPOLIA_CHAIN_ID]: {
    domain: 0,
    name: 'Ethereum Sepolia',
    rpcUrl: process.env.ETH_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  [ARB_SEPOLIA_CHAIN_ID]: {
    domain: 3,
    name: 'Arbitrum Sepolia',
    rpcUrl: process.env.ARB_SEPOLIA_RPC_URL || 'https://arbitrum-sepolia-rpc.publicnode.com',
  },
}

/**
 * Two-chain glue. The swarm runs on 0G Galileo (chainId 16602) but
 * users pay in real USDC on Base Sepolia (chainId 84532). The API
 * operator EOA bridges between them: it credits/debits Treasury on
 * 0G, and matches releases on USDCGateway on Base.
 *
 * USDC is fixed at 6 decimals system-wide (matches Circle's testnet
 * USDC). Treasury balances are stored in the same units — no scaling
 * happens between chains.
 */

export const USDC_DECIMALS = 6

let cached: ChainClient | null = null

interface BaseDeployments {
  USDCGateway?: string
  USDC?: string
  CCTPDepositReceiver?: string
  CCTPDepositReceiverDeployBlock?: number
  MessageTransmitterV2?: string
}

export interface ChainClient {
  // 0G testnet — swarm contracts
  ogProvider: ethers.JsonRpcProvider
  /** NonceManager-wrapped operator signer for 0G chain. Concurrent
   *  sendTransaction calls from anywhere in the API (AgentRunner gas
   *  prefund, SporeiseRunner Treasury debits, BridgeWatcher credit
   *  mirror, SlashWatcher batch) all share this single instance so
   *  nonce assignments are sequential — without that, two consumers
   *  race on `getTransactionCount(addr,'pending')` and one tx loses
   *  with REPLACEMENT_UNDERPRICED or NONCE_EXPIRED. */
  ogWallet: ethers.NonceManager | null
  treasuryAddr: string
  escrowAddr: string
  readTreasury: ethers.Contract
  readEscrow: ethers.Contract
  /** Write paths short-circuit with 503 in routes when these are null. */
  writeTreasury: ethers.Contract | null
  writeEscrow: ethers.Contract | null

  // Sporeise gas Treasury — separate ledger for SDK-managed runs so the
  // operator config of the legacy SwarmTreasury doesn't block billing.
  // When `L2_SPORE_GAS_TREASURY_ADDRESS` is unset, falls back to the
  // main `treasury*` handles above (legacy single-treasury behaviour).
  // Same Treasury contract type — just a separate deployment whose
  // `operator()` matches the API PRIVATE_KEY, so debits actually land.
  gasTreasuryAddr: string
  readGasTreasury: ethers.Contract
  writeGasTreasury: ethers.Contract | null

  // Base Sepolia — payment gateway + CCTP receiver
  baseProvider: ethers.JsonRpcProvider
  /** Same NonceManager rationale as ogWallet — Base-side operator txs
   *  (CCTP receiveMessage relays, USDCGateway releases) live on a
   *  separate nonce track from 0G but still need serialization within
   *  the Base chain. */
  baseWallet: ethers.NonceManager | null
  gatewayAddr: string
  baseUsdcAddr: string
  readGateway: ethers.Contract
  writeGateway: ethers.Contract | null

  // Circle CCTP V2 — Base Sepolia destination side
  cctpReceiverAddr: string
  cctpReceiverDeployBlock: number
  readCctpReceiver: ethers.Contract | null
  /** Operator-signed receiver used by CCTPRelayer for the post-mint
   *  `settle(message)` follow-up tx (CCTP V2 has no automatic hook). */
  writeCctpReceiver: ethers.Contract | null
  messageTransmitterAddr: string
  /** Operator-signed contract used by CCTPRelayer to submit
   *  receiveMessage on Base after Iris attestation. */
  writeMessageTransmitter: ethers.Contract | null

  // Source chains used by CCTPRelayer to fetch burn receipts +
  // MessageSent events. Read-only — no signing on source chains.
  sourceProviders: Record<number, ethers.JsonRpcProvider>

  /** Operator EOA address — same key on both chains. Null if PRIVATE_KEY
   *  isn't set. */
  operatorAddress: string | null
}

function loadBaseDeployments(): BaseDeployments {
  const p = path.resolve(__dirname, '../../../../contracts/deployments/base_sepolia.json')
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as BaseDeployments
  } catch {
    return {}
  }
}

export function getChainClient(): ChainClient {
  if (cached) return cached

  // ---- 0G testnet ----
  const ogRpcUrl = process.env.OG_RPC_URL || 'https://evmrpc-testnet.0g.ai'
  const treasuryAddr = process.env.L2_TREASURY_ADDRESS || (ogDeployments as any).SwarmTreasury
  const escrowAddr = process.env.L2_ESCROW_ADDRESS || (ogDeployments as any).SwarmEscrow
  if (!treasuryAddr) throw new Error('[v1/chain] SwarmTreasury address missing — deploy first')
  if (!escrowAddr) throw new Error('[v1/chain] SwarmEscrow address missing — deploy first')

  const ogProvider = new ethers.JsonRpcProvider(ogRpcUrl, undefined, { staticNetwork: true })
  const readTreasury = new ethers.Contract(treasuryAddr, SwarmTreasuryABI.abi, ogProvider)
  const readEscrow = new ethers.Contract(escrowAddr, SwarmEscrowABI.abi, ogProvider)

  // Sporeise gas Treasury override. When env points at a separate
  // SwarmTreasury-shape contract, sporeise debits land there instead
  // of the main Treasury — useful when the main Treasury's `operator`
  // doesn't match our PRIVATE_KEY and rotation isn't an option.
  const gasTreasuryAddr = process.env.L2_SPORE_GAS_TREASURY_ADDRESS || treasuryAddr
  const readGasTreasury = gasTreasuryAddr === treasuryAddr
    ? readTreasury
    : new ethers.Contract(gasTreasuryAddr, SwarmTreasuryABI.abi, ogProvider)

  // ---- Base Sepolia ----
  const baseRpcUrl = process.env.BASE_RPC_URL || 'https://sepolia.base.org'
  const baseDeployments = loadBaseDeployments()
  const gatewayAddr = process.env.BASE_GATEWAY_ADDRESS || baseDeployments.USDCGateway || ''
  const baseUsdcAddr =
    process.env.BASE_USDC_ADDRESS ||
    baseDeployments.USDC ||
    '0x036CbD53842c5426634e7929541eC2318f3dCF7e' // Circle's canonical Base Sepolia USDC

  const baseProvider = new ethers.JsonRpcProvider(baseRpcUrl, undefined, { staticNetwork: true })
  const readGateway = gatewayAddr
    ? new ethers.Contract(gatewayAddr, USDCGatewayABI.abi, baseProvider)
    : (null as any)

  // ---- CCTP V2 receiver + MessageTransmitter on Base ----
  const cctpReceiverAddr = process.env.BASE_CCTP_RECEIVER_ADDRESS || baseDeployments.CCTPDepositReceiver || ''
  const cctpReceiverDeployBlock = baseDeployments.CCTPDepositReceiverDeployBlock || 0
  const messageTransmitterAddr =
    process.env.BASE_MESSAGE_TRANSMITTER_V2_ADDRESS ||
    baseDeployments.MessageTransmitterV2 ||
    '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'

  const readCctpReceiver = cctpReceiverAddr
    ? new ethers.Contract(cctpReceiverAddr, CCTPDepositReceiverABI.abi, baseProvider)
    : null

  // ---- Source-chain providers (read-only, for CCTPRelayer) ----
  const sourceProviders: Record<number, ethers.JsonRpcProvider> = {}
  for (const [chainIdStr, cfg] of Object.entries(CCTP_SOURCE_CHAINS)) {
    sourceProviders[Number(chainIdStr)] = new ethers.JsonRpcProvider(
      cfg.rpcUrl,
      undefined,
      { staticNetwork: true },
    )
  }

  // ---- Signer (same PK both chains) ----
  // NonceManager wraps both wallets so every operator-signed tx in the
  // API funnels through a single nonce counter per chain. Address is
  // derived from a one-shot Wallet (no provider needed) since
  // NonceManager doesn't expose a sync `.address`.
  let ogWallet: ethers.NonceManager | null = null
  let baseWallet: ethers.NonceManager | null = null
  let writeTreasury: ethers.Contract | null = null
  let writeGasTreasury: ethers.Contract | null = null
  let writeEscrow: ethers.Contract | null = null
  let writeGateway: ethers.Contract | null = null
  let writeMessageTransmitter: ethers.Contract | null = null
  let writeCctpReceiver: ethers.Contract | null = null
  let operatorAddress: string | null = null

  const pk = process.env.PRIVATE_KEY
  if (pk) {
    ogWallet = new ethers.NonceManager(new ethers.Wallet(pk, ogProvider))
    baseWallet = new ethers.NonceManager(new ethers.Wallet(pk, baseProvider))
    operatorAddress = new ethers.Wallet(pk).address
    writeTreasury = new ethers.Contract(treasuryAddr, SwarmTreasuryABI.abi, ogWallet)
    writeGasTreasury = gasTreasuryAddr === treasuryAddr
      ? writeTreasury
      : new ethers.Contract(gasTreasuryAddr, SwarmTreasuryABI.abi, ogWallet)
    writeEscrow = new ethers.Contract(escrowAddr, SwarmEscrowABI.abi, ogWallet)
    if (gatewayAddr) {
      writeGateway = new ethers.Contract(gatewayAddr, USDCGatewayABI.abi, baseWallet)
    }
    if (messageTransmitterAddr) {
      writeMessageTransmitter = new ethers.Contract(
        messageTransmitterAddr,
        MESSAGE_TRANSMITTER_V2_ABI as any,
        baseWallet,
      )
    }
    if (cctpReceiverAddr) {
      writeCctpReceiver = new ethers.Contract(
        cctpReceiverAddr,
        CCTPDepositReceiverABI.abi,
        baseWallet,
      )
    }
  }

  cached = {
    ogProvider,
    ogWallet,
    treasuryAddr,
    escrowAddr,
    readTreasury,
    readEscrow,
    writeTreasury,
    writeEscrow,
    gasTreasuryAddr,
    readGasTreasury,
    writeGasTreasury,
    baseProvider,
    baseWallet,
    gatewayAddr,
    baseUsdcAddr,
    readGateway,
    writeGateway,
    cctpReceiverAddr,
    cctpReceiverDeployBlock,
    readCctpReceiver,
    writeCctpReceiver,
    messageTransmitterAddr,
    writeMessageTransmitter,
    sourceProviders,
    operatorAddress,
  }
  return cached
}

/** Back-compat alias. */
export const getTreasuryClient = getChainClient

/** Reset cached client. Useful for tests / env reloads. */
export function _resetChainClient(): void {
  cached = null
}
