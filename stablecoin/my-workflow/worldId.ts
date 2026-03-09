export type KycMode = 'on-chain' | 'off-chain'
export type WorldIdOperationMode = 'mint' | 'burn'

export type WorldIdPayload = {
  root: bigint | string | number
  nullifierHash: bigint | string | number
  proof: Array<bigint | string | number>
}

const WORLD_ID_APP_SEED = 91_357n
const WORLD_ID_ACTION_SEED = 424_242n
const WORLD_ID_META_MULTIPLIER = 10n
const WORLD_ID_KYC_THRESHOLD_USD = 100n
const WORLD_ID_ORACLE_RATE_SCALE = 1_000_000n
const WORLD_ID_PROOF_LENGTH = 8

export function decodeKycMode(rawValue: number | bigint): KycMode {
  return Number(rawValue) === 0 ? 'on-chain' : 'off-chain'
}

export function requiresWorldIdKyc(amount: bigint, oracleRate: bigint) {
  return amount * WORLD_ID_ORACLE_RATE_SCALE > oracleRate * WORLD_ID_KYC_THRESHOLD_USD
}

export function validateWorldIdPayload(input: {
  user: string
  currencyCode: `0x${string}`
  mode: WorldIdOperationMode
  amount: bigint
  oracleRate: bigint
  kycMode: KycMode
  worldId?: WorldIdPayload | null
}): { valid: boolean; error?: string } {
  if (!requiresWorldIdKyc(input.amount, input.oracleRate)) {
    return { valid: true }
  }

  const normalized = normalizeWorldIdPayload(input.worldId)
  if (!normalized.payload) {
    return { valid: false, error: normalized.error }
  }

  const expectedProof = buildProofArray({
    user: input.user,
    currencyCode: input.currencyCode,
    mode: input.mode,
    amount: input.amount,
    oracleRate: input.oracleRate,
    kycMode: input.kycMode,
    root: normalized.payload.root,
    nullifierHash: normalized.payload.nullifierHash,
  })

  const matches = normalized.payload.proof.every((value, index) => value === expectedProof[index])
  return matches ? { valid: true } : { valid: false, error: 'World ID proof does not match the selected wallet, amount, currency, and KYC mode.' }
}

function normalizeWorldIdPayload(payload?: WorldIdPayload | null) {
  if (!payload) {
    return { error: 'World ID proof is required for requests above $100 in USD value.' }
  }

  if (payload.proof.length !== WORLD_ID_PROOF_LENGTH) {
    return { error: 'World ID proof must contain exactly 8 uint256 values.' }
  }

  try {
    return {
      payload: {
        root: normalizePositiveBigInt(payload.root),
        nullifierHash: normalizePositiveBigInt(payload.nullifierHash),
        proof: payload.proof.map((value) => normalizePositiveBigInt(value)),
      },
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid World ID payload.' }
  }
}

function normalizePositiveBigInt(value: bigint | string | number) {
  const parsed = BigInt(value)
  if (parsed <= 0n) {
    throw new Error('World ID fields must be positive uint256 values.')
  }
  return parsed
}

function buildProofArray(input: {
  user: string
  currencyCode: `0x${string}`
  mode: WorldIdOperationMode
  amount: bigint
  oracleRate: bigint
  kycMode: KycMode
  root: bigint
  nullifierHash: bigint
}) {
  const userValue = BigInt(input.user)
  const currencyValue = BigInt(input.currencyCode)
  const modeValue = input.mode === 'mint' ? 0n : 1n
  const kycValue = input.kycMode === 'on-chain' ? 0n : 1n
  const metaValue = modeValue * WORLD_ID_META_MULTIPLIER + kycValue + 1n
  const digest =
    input.root ^
    input.nullifierHash ^
    input.amount ^
    input.oracleRate ^
    userValue ^
    currencyValue ^
    metaValue ^
    WORLD_ID_APP_SEED ^
    WORLD_ID_ACTION_SEED

  return [
    input.root + 1n,
    input.nullifierHash + 2n,
    input.amount,
    input.oracleRate,
    userValue,
    currencyValue,
    metaValue,
    digest,
  ]
}