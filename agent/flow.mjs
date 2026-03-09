import { getPrepaidTxHash, getTenderlyChainLabel, getTenderlyExplorerUrl, getTenderlyPrivateKey } from './config.mjs'
import { facilitatorVerifyPayment } from './facilitator.mjs'
import { buildWorkflowQuote } from './pricing.mjs'
import { submitTenderlyUsdcPayment } from './tenderly.mjs'
import { makeDecisionId, makeProceedToken, shortenAddress } from './utils.mjs'

function log(emit, line) {
  emit?.(line)
}

export async function runAgentFlow({ creInput, creOutcome, emit, env = process.env }) {
  const quote = buildWorkflowQuote(creInput, env)
  const decisionId = makeDecisionId()

  log(emit, `[agent] ProceedGate-style local agent started for CRE outcome ${creOutcome.status}`)
  log(emit, `[agent] CRE value estimate -> $${quote.creValueUsd.toFixed(6)} from ${creInput.amount} ${creInput.currencyCode}`)
  log(emit, `[agent] ProceedGate USDC reference -> ${quote.requiredPrice}`)
  log(emit, `[agent] /v1/billing/quote -> ${quote.quoteId} ${quote.requiredPrice} on ${getTenderlyChainLabel(env)} to ${shortenAddress(quote.requiredRecipient)}`)
  log(emit, `[agent] /v1/governor/check -> 402 friction required for consumed CRE workflow (${decisionId})`)

  let txHash = getPrepaidTxHash(env)
  if (txHash) {
    log(emit, `[agent] Using configured x402 payment tx -> ${txHash}`)
  } else if (getTenderlyPrivateKey(env)) {
    txHash = await submitTenderlyUsdcPayment(env, { recipient: quote.requiredRecipient, requiredUnits: quote.requiredUnits, emit })
  } else {
    log(emit, '[agent] No Tenderly payment credentials found; payment remains pending until STABLES_TENDERLY_PRIVATE_KEY or STABLES_X402_TX_HASH is provided.')
    return {
      status: 'pending',
      quoteId: quote.quoteId,
      decisionId,
      requiredPrice: quote.requiredPrice,
      requiredChain: quote.requiredChain,
      requiredRecipient: quote.requiredRecipient,
    }
  }

  const verified = await facilitatorVerifyPayment(env, {
    tx_hash: txHash,
    required_price: quote.requiredPrice,
    required_chain: quote.requiredChain,
    required_recipient: quote.requiredRecipient,
    decision_id: decisionId,
  })

  if (!verified.ok) {
    log(emit, `[agent] /v1/billing/redeem -> ${verified.error}`)
    return {
      status: 'error',
      quoteId: quote.quoteId,
      decisionId,
      paymentTxHash: txHash,
      error: verified.error,
    }
  }

  log(emit, `[agent] /v1/billing/redeem -> ok (${verified.receipt.paid_price} on chain ${verified.receipt.paid_chain})`)
  const proceedToken = makeProceedToken({ decisionId, quoteId: quote.quoteId, txHash, status: creOutcome.status, issuedAt: Date.now() })
  log(emit, `[agent] /v1/governor/redeem -> proceed token issued (${proceedToken.slice(0, 18)}...)`)
  log(emit, `[agent] Tenderly explorer -> ${getTenderlyExplorerUrl(env)}/${txHash}`)

  return {
    status: 'paid',
    quoteId: quote.quoteId,
    decisionId,
    paymentTxHash: txHash,
    requiredPrice: quote.requiredPrice,
    requiredChain: quote.requiredChain,
    requiredRecipient: quote.requiredRecipient,
    proceedToken,
    receipt: verified.receipt,
  }
}