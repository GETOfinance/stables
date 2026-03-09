import { ZERO_ADDRESS, normalizeAddress } from './utils.mjs'

const DEFAULT_TENDERLY_RPC_URL = 'https://virtual.mainnet.eu.rpc.tenderly.co/e9db97d6-ae88-45ff-8cc5-79e399163e8e'
const DEFAULT_TENDERLY_EXPLORER_URL = 'https://dashboard.tenderly.co/explorer/vnet/e9db97d6-ae88-45ff-8cc5-79e399163e8e/transactions'
const DEFAULT_TENDERLY_RECIPIENT = '0xFaE70639b30Ab9B59A579FcA17F3d4Bd1E57A379'
const DEFAULT_TENDERLY_USDC_ADDRESS = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

export function getWorkflowServicePrice(env = process.env) {
  return String(env.STABLES_X402_PRICE || '1 USDC').trim() || '1 USDC'
}

export function getTenderlyChainId(env = process.env) {
  return Number(env.STABLES_TENDERLY_CHAIN_ID || env.TENDERLY_CHAIN_ID || 9991)
}

export function getTenderlyChainLabel(env = process.env) {
  return String(env.STABLES_TENDERLY_CHAIN_LABEL || `Tenderly Eth Mainnet (${getTenderlyChainId(env)})`).trim()
}

export function getTenderlyRpcUrl(env = process.env) {
  return String(env.STABLES_TENDERLY_RPC_URL || env.TENDERLY_RPC_URL || DEFAULT_TENDERLY_RPC_URL).trim()
}

export function getTenderlyExplorerUrl(env = process.env) {
  return String(env.STABLES_TENDERLY_EXPLORER_URL || env.TENDERLY_EXPLORER_URL || DEFAULT_TENDERLY_EXPLORER_URL).trim()
}

export function getX402Recipient(env = process.env) {
  const configured = normalizeAddress(env.STABLES_X402_RECIPIENT || env.X402_RECIPIENT || DEFAULT_TENDERLY_RECIPIENT)
  return configured || ZERO_ADDRESS
}

export function getTenderlyPrivateKey(env = process.env) {
  const value = String(env.STABLES_TENDERLY_PRIVATE_KEY || env.TENDERLY_PRIVATE_KEY || '').trim()
  return value ? (value.startsWith('0x') ? value : `0x${value}`) : ''
}

export function getTenderlyUsdcAddress(env = process.env) {
  return normalizeAddress(env.STABLES_TENDERLY_USDC_ADDRESS || DEFAULT_TENDERLY_USDC_ADDRESS) || DEFAULT_TENDERLY_USDC_ADDRESS.toLowerCase()
}

export function getAllowStubTx(env = process.env) {
  return String(env.STABLES_AGENT_ALLOW_STUB_TX || '').trim().toLowerCase() === 'true'
}

export function getPrepaidTxHash(env = process.env) {
  return String(env.STABLES_X402_TX_HASH || '').trim()
}