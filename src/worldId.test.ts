import { describe, expect, it } from 'vitest'

import {
  WORLD_ID_KYC_THRESHOLD_USD,
  createDemoWorldIdPayload,
  parseWorldIdForm,
  requiresWorldIdKyc,
  validateWorldIdPayload,
} from './worldId'

const walletAddress = '0x1234567890123456789012345678901234567890'

describe('worldId helpers', () => {
  it('does not require World ID exactly at the $100 threshold', () => {
    expect(requiresWorldIdKyc(WORLD_ID_KYC_THRESHOLD_USD, 1)).toBe(false)

    const result = validateWorldIdPayload({
      user: walletAddress,
      currencyCode: 'USD',
      mode: 'mint',
      amount: WORLD_ID_KYC_THRESHOLD_USD,
      oracleRate: 1,
      kycMode: 'on-chain',
    })

    expect(result).toEqual({ valid: true })
  })

  it('parses comma and whitespace separated World ID proof values', () => {
    const demoPayload = createDemoWorldIdPayload({
      user: walletAddress,
      currencyCode: 'USD',
      mode: 'mint',
      amount: 101,
      oracleRate: 1,
      kycMode: 'off-chain',
    })

    const parsed = parseWorldIdForm({
      root: ` ${demoPayload.root} `,
      nullifierHash: ` ${demoPayload.nullifierHash} `,
      proof: `${demoPayload.proof.slice(0, 4).join(', ')}\n${demoPayload.proof.slice(4).join(' ')}`,
    })

    expect(parsed).toEqual({ payload: demoPayload })
  })

  it('accepts a matching demo payload for requests above the threshold', () => {
    const worldId = createDemoWorldIdPayload({
      user: walletAddress,
      currencyCode: 'USD',
      mode: 'mint',
      amount: 101,
      oracleRate: 1,
      kycMode: 'off-chain',
    })

    const result = validateWorldIdPayload({
      user: walletAddress,
      currencyCode: 'USD',
      mode: 'mint',
      amount: 101,
      oracleRate: 1,
      kycMode: 'off-chain',
      worldId,
    })

    expect(result).toEqual({ valid: true, normalized: worldId })
  })

  it('rejects a tampered proof for requests above the threshold', () => {
    const worldId = createDemoWorldIdPayload({
      user: walletAddress,
      currencyCode: 'USD',
      mode: 'mint',
      amount: 101,
      oracleRate: 1,
      kycMode: 'off-chain',
    })

    const tamperedProof = [...worldId.proof]
    tamperedProof[0] = (BigInt(tamperedProof[0]) + 1n).toString()

    const result = validateWorldIdPayload({
      user: walletAddress,
      currencyCode: 'USD',
      mode: 'mint',
      amount: 101,
      oracleRate: 1,
      kycMode: 'off-chain',
      worldId: { ...worldId, proof: tamperedProof },
    })

    expect(result.valid).toBe(false)
    expect(result.error).toContain('does not match')
  })
})