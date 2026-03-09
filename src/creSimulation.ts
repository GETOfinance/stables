export type Mode = 'mint' | 'burn'

import { requiresWorldIdKyc, validateWorldIdPayload, type KycMode, type WorldIdPayload } from './worldId'

export type Currency = {
  code: string
  name: string
  rate: number
}

export type ActivityStatus = 'recorded' | 'rejected'

export type ActivityItem = {
  id: string
  title: string
  subtitle: string
  status: ActivityStatus
}

export type SimulationInput = {
  walletAddress?: string
  mode: Mode
  kycMode: KycMode
  currencyCode: string
  amount: number
  oracleRate: number
  currentBalance: number
  worldId?: WorldIdPayload | null
}

export type SimulationResult = {
  accepted: boolean
  apiRate: number
  differenceBps: number
  nextBalance: number
  activity: ActivityItem
  terminalLines: string[]
  rejectionReason?: 'rate' | 'kyc'
  rejectionMessage?: string
}

export const SIMULATION_USER_ADDRESS = '0x000000000000000000000000000000000000dEaD'

export const CRE_PROJECT_SUMMARY = {
  contractName: 'StablecoinManager',
  workflowName: 'stablecoin-workflow-local',
  forwarderAddress: '0x15fc6ae953e024d975e77382eeec56a9101f9f88',
  contractPath: 'stablecoin/contracts/src/StablecoinManager.sol',
  workflowPath: 'stablecoin/my-workflow/main.ts',
  rateToleranceBps: 1000,
  worldIdThresholdUsd: 100,
}

export const currencies: Currency[] = [
  { code: 'USDC', name: 'USD Coin', rate: 1 },
  { code: 'USD', name: 'US Dollar', rate: 1 },
  { code: 'EUR', name: 'Euro', rate: 0.92 },
  { code: 'JPY', name: 'Japanese Yen', rate: 149 },
  { code: 'CNY', name: 'Chinese Yuan', rate: 7.2 },
  { code: 'NGN', name: 'Nigerian Naira', rate: 1600 },
  { code: 'ZAR', name: 'South African Rand', rate: 18 },
  { code: 'KES', name: 'Kenyan Shilling', rate: 129 },
  { code: 'GHS', name: 'Ghanaian Cedi', rate: 15 },
  { code: 'UGX', name: 'Ugandan Shilling', rate: 3780 },
]

export const INITIAL_TERMINAL_LINES = [
  `$ scaffold ready -> ${CRE_PROJECT_SUMMARY.contractPath}`,
  `$ scaffold ready -> ${CRE_PROJECT_SUMMARY.workflowPath}`,
  '$ npm run cre:bridge',
  '$ cre workflow simulate ./my-workflow --target local-settings --broadcast',
  '[bridge] Waiting for the local CRE bridge; browser fallback stays available.',
  `[forwarder] ${CRE_PROJECT_SUMMARY.forwarderAddress} on Sepolia`,
  `[kyc] World ID required when request value exceeds $${CRE_PROJECT_SUMMARY.worldIdThresholdUsd} USD`,
]

const RATE_MULTIPLIERS: Record<string, number> = {
  USDC: 1.004,
  USD: 1.018,
  EUR: 0.986,
  JPY: 1.109,
  CNY: 1.024,
  NGN: 0.978,
  ZAR: 0.894,
  KES: 1.031,
  GHS: 0.993,
  UGX: 1.027,
}

export function simulateCreOperation(input: SimulationInput): SimulationResult {
  const actor = input.walletAddress || SIMULATION_USER_ADDRESS
  const apiRate = roundRate(input.oracleRate * (RATE_MULTIPLIERS[input.currencyCode] ?? 1.012))
  const differenceBps = Math.round((Math.abs(apiRate - input.oracleRate) / input.oracleRate) * 10_000)
  const kycRequired = requiresWorldIdKyc(input.amount, input.oracleRate)
  const kycValidation = validateWorldIdPayload({
    user: actor,
    currencyCode: input.currencyCode,
    mode: input.mode,
    amount: input.amount,
    oracleRate: input.oracleRate,
    kycMode: input.kycMode,
    worldId: input.worldId,
  })
  const accepted = differenceBps < CRE_PROJECT_SUMMARY.rateToleranceBps && (!kycRequired || kycValidation.valid)
  const rejectionReason =
    differenceBps >= CRE_PROJECT_SUMMARY.rateToleranceBps ? 'rate' : kycRequired && !kycValidation.valid ? 'kyc' : undefined
  const nextBalance = accepted
    ? input.mode === 'mint'
      ? input.currentBalance + input.amount
      : input.currentBalance - input.amount
    : input.currentBalance

  const activity = {
    id: `${Date.now()}-${input.currencyCode}-${input.mode}`,
    title: `${accepted ? 'Recorded' : 'Rejected'} ${input.mode} ${formatAmount(input.amount)} ${input.currencyCode}`,
    subtitle: accepted
      ? `StablecoinManager updated for ${shortenAddress(actor)} · Δ ${formatDifference(differenceBps)}`
      : rejectionReason === 'kyc'
        ? `World ID KYC blocked write for ${shortenAddress(actor)} · ${input.kycMode}`
        : `Rate guard blocked write for ${shortenAddress(actor)} · Δ ${formatDifference(differenceBps)}`,
    status: accepted ? 'recorded' : 'rejected',
  } as const

  const terminalLines = [
    `$ cre workflow simulate ${CRE_PROJECT_SUMMARY.workflowName} --broadcast`,
    `[http] ${input.mode.toUpperCase()} request ${formatAmount(input.amount)} ${input.currencyCode} from ${shortenAddress(actor)}`,
    kycRequired
      ? `[kyc] World ID required for >$${CRE_PROJECT_SUMMARY.worldIdThresholdUsd} requests -> ${input.kycMode}`
      : '[kyc] Request value is within the $100 threshold -> World ID not required',
    '[evm-log] OperationRequested emitted by StablecoinManager',
    `[oracle] ${input.oracleRate.toLocaleString()} ${input.currencyCode} per 1 stablecoin`,
    `[api] Exchangerate API returned ${apiRate.toLocaleString()} ${input.currencyCode}`,
    `[check] Δ ${formatDifference(differenceBps)} ${accepted ? '< 10% -> record' : '>= 10% -> reject'}`,
    ...(differenceBps < CRE_PROJECT_SUMMARY.rateToleranceBps && kycRequired
      ? [kycValidation.valid ? '[kyc] World ID proof accepted' : `[kyc] ${kycValidation.error}`]
      : []),
    accepted
      ? `[evm-write] OperationRecorded -> new balance ${formatAmount(nextBalance)} ${input.currencyCode}`
      : rejectionReason === 'kyc'
        ? `[evm-write] OperationRejected -> World ID KYC failed; balance remains ${formatAmount(input.currentBalance)} ${input.currencyCode}`
        : `[evm-write] OperationRejected -> balance remains ${formatAmount(input.currentBalance)} ${input.currencyCode}`,
  ]

  return {
    accepted,
    apiRate,
    differenceBps,
    nextBalance,
    activity,
    terminalLines,
    rejectionReason,
    rejectionMessage: rejectionReason === 'kyc' ? kycValidation.error : undefined,
  }
}

function roundRate(value: number) {
  return Number(value.toFixed(4))
}

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function formatAmount(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function formatDifference(differenceBps: number) {
  return `${(differenceBps / 100).toFixed(2)}%`
}
