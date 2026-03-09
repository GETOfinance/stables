import { getTenderlyChainId, getWorkflowServicePrice, getX402Recipient } from './config.mjs'
import { makeQuoteId, parseUsdcToUnits } from './utils.mjs'

export function estimateCreOutputUsd(amount, oracleRateMicro) {
  const amountValue = Number(BigInt(amount))
  const oracleRateValue = Number(BigInt(oracleRateMicro)) / 1_000_000
  if (!Number.isFinite(amountValue) || !Number.isFinite(oracleRateValue) || oracleRateValue <= 0) return 0
  return amountValue / oracleRateValue
}

export function buildWorkflowQuote({ amount, oracleRate, currencyCode }, env = process.env) {
  const requiredPrice = getWorkflowServicePrice(env)
  const requiredUnits = parseUsdcToUnits(requiredPrice)
  if (requiredUnits === null) {
    throw new Error(`Unsupported STABLES_X402_PRICE value: ${requiredPrice}`)
  }

  return {
    quoteId: makeQuoteId(),
    currencyCode,
    creValueUsd: estimateCreOutputUsd(amount, oracleRate),
    requiredPrice,
    requiredUnits,
    requiredChain: String(getTenderlyChainId(env)),
    requiredRecipient: getX402Recipient(env),
    explain: 'Consumed CRE workflow billed at a fixed ProceedGate-style x402 price.',
  }
}