import { describe, expect, it } from 'vitest'

import { getX402Recipient } from './config.mjs'
import { runAgentFlow } from './flow.mjs'
import { buildWorkflowQuote } from './pricing.mjs'

describe('buildWorkflowQuote', () => {
  it('creates a fixed 1 USDC workflow quote on Tenderly chain 9991', () => {
    const quote = buildWorkflowQuote({ amount: 25, oracleRate: 1_000_000, currencyCode: 'USDC' }, {})

    expect(quote.requiredPrice).toBe('1 USDC')
    expect(quote.requiredChain).toBe('9991')
    expect(quote.requiredRecipient).toBe('0xfae70639b30ab9b59a579fca17f3d4bd1e57a379')
    expect(quote.creValueUsd).toBe(25)
  })

  it('does not reuse the Tenderly sender wallet as the default x402 recipient', () => {
    const recipient = getX402Recipient({
      TENDERLY_WALLET_ADDRESS: '0xa69E56AF77C36A139e88cABb5D7e4498CDE46D44',
    })

    expect(recipient).toBe('0xfae70639b30ab9b59a579fca17f3d4bd1e57a379')
  })
})

describe('runAgentFlow', () => {
  const creInput = { amount: 101, oracleRate: 1_000_000, currencyCode: 'USDC' }
  const creOutcome = { status: 'recorded', differenceBps: 180, nextBalance: 101 }

  it('returns pending when no Tenderly private key or prepaid tx hash is configured', async () => {
    const lines = []

    const result = await runAgentFlow({
      creInput,
      creOutcome,
      env: {},
      emit: (line) => lines.push(line),
    })

    expect(result.status).toBe('pending')
    expect(result.requiredPrice).toBe('1 USDC')
    expect(lines.some((line) => line.includes('/v1/governor/check -> 402 friction required'))).toBe(true)
  })

  it('accepts a stub x402 payment hash and issues a proceed token', async () => {
    const lines = []

    const result = await runAgentFlow({
      creInput,
      creOutcome,
      env: {
        STABLES_X402_TX_HASH: '0xstub-demo-payment',
        STABLES_AGENT_ALLOW_STUB_TX: 'true',
      },
      emit: (line) => lines.push(line),
    })

    expect(result.status).toBe('paid')
    expect(result.paymentTxHash).toBe('0xstub-demo-payment')
    expect(result.receipt.paid_price).toBe('1 USDC')
    expect(typeof result.proceedToken).toBe('string')
    expect(lines.some((line) => line.includes('/v1/billing/redeem -> ok'))).toBe(true)
    expect(lines.some((line) => line.includes('/v1/governor/redeem -> proceed token issued'))).toBe(true)
  })
})