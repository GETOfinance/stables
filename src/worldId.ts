export type KycMode = 'on-chain' | 'off-chain'
export type WorldIdOperationMode = 'mint' | 'burn'

export type WorldIdPayload = {
  root: string
  nullifierHash: string
  proof: string[]
}

export type WorldIdFormValues = {
  root: string
  nullifierHash: string
  proof: string
}

type ValidationResult = {
  valid: boolean
  normalized?: WorldIdPayload
  error?: string
}

const WORLD_ID_APP_SEED = 91_357n
const WORLD_ID_ACTION_SEED = 424_242n
const WORLD_ID_META_MULTIPLIER = 10n
const WORLD_ID_ORACLE_RATE_SCALE = 1_000_000

export const WORLD_ID_KYC_THRESHOLD_USD = 100
export const WORLD_ID_PROOF_LENGTH = 8

export function estimateUsdValue(amount: number, oracleRate: number) {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(oracleRate) || oracleRate <= 0) {
    return 0
  }

  return amount / oracleRate
}

export function requiresWorldIdKyc(amount: number, oracleRate: number) {
  return estimateUsdValue(amount, oracleRate) > WORLD_ID_KYC_THRESHOLD_USD
}

export function parseWorldIdForm(values: WorldIdFormValues): { payload?: WorldIdPayload; error?: string } {
  return normalizeWorldIdPayload({
    root: values.root,
    nullifierHash: values.nullifierHash,
    proof: values.proof.split(/[\s,]+/).filter(Boolean),
  })
}

export function validateWorldIdPayload(input: {
  user: string
  currencyCode: string
  mode: WorldIdOperationMode
  amount: number
  oracleRate: number
  kycMode: KycMode
  worldId?: WorldIdPayload | null
}): ValidationResult {
  if (!requiresWorldIdKyc(input.amount, input.oracleRate)) {
    return { valid: true }
  }

  if (!input.worldId) {
    return { valid: false, error: 'World ID proof is required for requests above $100 in USD value.' }
  }

  const normalized = normalizeWorldIdPayload(input.worldId)
  if (!normalized.payload) {
    return { valid: false, error: normalized.error }
  }

  let amountValue: bigint
  let oracleRateValue: bigint

  try {
    amountValue = toAmountBigInt(input.amount)
    oracleRateValue = scaleOracleRate(input.oracleRate)
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Invalid World ID request context.' }
  }

  const expectedProof = buildProofArray({
    user: input.user,
    currencyCode: input.currencyCode,
    mode: input.mode,
    amount: amountValue,
    oracleRate: oracleRateValue,
    kycMode: input.kycMode,
    root: BigInt(normalized.payload.root),
    nullifierHash: BigInt(normalized.payload.nullifierHash),
  })

  const actualProof = normalized.payload.proof.map((value) => BigInt(value))
  const matches = actualProof.every((value, index) => value === expectedProof[index])

  return matches
    ? { valid: true, normalized: normalized.payload }
    : { valid: false, error: 'World ID proof does not match the selected wallet, amount, currency, and KYC mode.' }
}

export function createDemoWorldIdPayload(input: {
  user: string
  currencyCode: string
  mode: WorldIdOperationMode
  amount: number
  oracleRate: number
  kycMode: KycMode
}): WorldIdPayload {
  const amountValue = toAmountBigInt(input.amount)
  const oracleRateValue = scaleOracleRate(input.oracleRate)
  const actorValue = addressToBigInt(input.user)
  const currencyValue = currencyCodeToBigInt(input.currencyCode)
  const nonce = BigInt(Date.now()) + (actorValue & 0xffffn)
  const root = nonce * 17n + currencyValue + WORLD_ID_APP_SEED
  const nullifierHash = nonce * 31n + amountValue + oracleRateValue + WORLD_ID_ACTION_SEED
  const proof = buildProofArray({
    user: input.user,
    currencyCode: input.currencyCode,
    mode: input.mode,
    amount: amountValue,
    oracleRate: oracleRateValue,
    kycMode: input.kycMode,
    root,
    nullifierHash,
  })

  return {
    root: root.toString(),
    nullifierHash: nullifierHash.toString(),
    proof: proof.map((value) => value.toString()),
  }
}

function normalizeWorldIdPayload(payload: WorldIdPayload): { payload?: WorldIdPayload; error?: string } {
  if (!payload.root?.trim() || !payload.nullifierHash?.trim()) {
    return { error: 'World ID root and nullifier hash are required for requests above $100.' }
  }

  if (payload.proof.length !== WORLD_ID_PROOF_LENGTH) {
    return { error: 'World ID proof must contain exactly 8 comma-separated uint256 values.' }
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

function normalizePositiveBigInt(value: string) {
  const parsed = BigInt(value.trim())
  if (parsed <= 0n) {
    throw new Error('World ID fields must be positive uint256 values.')
  }
  return parsed.toString()
}

function toAmountBigInt(amount: number) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('World ID demo verification requires a positive whole-number amount.')
  }
  return BigInt(amount)
}

function scaleOracleRate(oracleRate: number) {
  if (!Number.isFinite(oracleRate) || oracleRate <= 0) {
    throw new Error('World ID demo verification requires a positive oracle rate.')
  }
  return BigInt(Math.round(oracleRate * WORLD_ID_ORACLE_RATE_SCALE))
}

function buildProofArray(input: {
  user: string
  currencyCode: string
  mode: WorldIdOperationMode
  amount: bigint
  oracleRate: bigint
  kycMode: KycMode
  root: bigint
  nullifierHash: bigint
}) {
  const userValue = addressToBigInt(input.user)
  const currencyValue = currencyCodeToBigInt(input.currencyCode)
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

function addressToBigInt(address: string) {
  return BigInt(address)
}

function currencyCodeToBigInt(currencyCode: string) {
  const bytes = new TextEncoder().encode(currencyCode)
  let value = 0n

  for (let index = 0; index < 32; index += 1) {
    value = (value << 8n) + BigInt(bytes[index] ?? 0)
  }

  return value
}