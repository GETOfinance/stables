import { describe, expect, it } from 'vitest'
import { CRE_PROJECT_SUMMARY, formatDifference, simulateCreOperation } from './creSimulation'
import { createDemoWorldIdPayload } from './worldId'

describe('simulateCreOperation', () => {
  it('records a mint when the API/oracle difference is below 10%', () => {
    const result = simulateCreOperation({
      walletAddress: '0x1234567890123456789012345678901234567890',
      mode: 'mint',
      kycMode: 'on-chain',
      currencyCode: 'USDC',
      amount: 25,
      oracleRate: 1,
      currentBalance: 10,
    })

    expect(result.accepted).toBe(true)
    expect(result.differenceBps).toBeLessThan(CRE_PROJECT_SUMMARY.rateToleranceBps)
    expect(result.nextBalance).toBe(35)
    expect(result.activity.status).toBe('recorded')
    expect(result.terminalLines[result.terminalLines.length - 1]).toContain('OperationRecorded')
  })

  it('rejects an operation when the difference reaches 10% or more', () => {
    const result = simulateCreOperation({
      mode: 'burn',
      kycMode: 'off-chain',
      currencyCode: 'JPY',
      amount: 5,
      oracleRate: 149,
      currentBalance: 40,
    })

    expect(result.accepted).toBe(false)
    expect(result.differenceBps).toBeGreaterThanOrEqual(CRE_PROJECT_SUMMARY.rateToleranceBps)
    expect(result.nextBalance).toBe(40)
    expect(result.activity.status).toBe('rejected')
    expect(result.activity.subtitle).toContain(formatDifference(result.differenceBps))
    expect(result.terminalLines[result.terminalLines.length - 1]).toContain('OperationRejected')
  })

  it('does not require World ID at or below the $100 threshold', () => {
    const result = simulateCreOperation({
      walletAddress: '0x1234567890123456789012345678901234567890',
      mode: 'mint',
      kycMode: 'on-chain',
      currencyCode: 'USDC',
      amount: 100,
      oracleRate: 1,
      currentBalance: 0,
    })

    expect(result.accepted).toBe(true)
    expect(result.rejectionReason).toBeUndefined()
    expect(result.terminalLines).toContain('[kyc] Request value is within the $100 threshold -> World ID not required')
  })

  it('rejects requests above $100 when the World ID payload is missing', () => {
    const result = simulateCreOperation({
      walletAddress: '0x1234567890123456789012345678901234567890',
      mode: 'mint',
      kycMode: 'off-chain',
      currencyCode: 'USDC',
      amount: 101,
      oracleRate: 1,
      currentBalance: 0,
    })

    expect(result.accepted).toBe(false)
    expect(result.rejectionReason).toBe('kyc')
    expect(result.rejectionMessage).toContain('World ID proof is required')
  })

  it('accepts requests above $100 when a valid demo World ID payload is provided', () => {
    const walletAddress = '0x1234567890123456789012345678901234567890'
    const worldId = createDemoWorldIdPayload({
      user: walletAddress,
      currencyCode: 'USDC',
      mode: 'mint',
      amount: 101,
      oracleRate: 1,
      kycMode: 'off-chain',
    })

    const result = simulateCreOperation({
      walletAddress,
      mode: 'mint',
      kycMode: 'off-chain',
      currencyCode: 'USDC',
      amount: 101,
      oracleRate: 1,
      currentBalance: 0,
      worldId,
    })

    expect(result.accepted).toBe(true)
    expect(result.rejectionReason).toBeUndefined()
    expect(result.terminalLines).toContain('[kyc] World ID proof accepted')
  })
})