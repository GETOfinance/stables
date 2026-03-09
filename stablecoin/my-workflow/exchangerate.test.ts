import { describe, expect, it } from 'vitest'
import { decodeExchangeRateResponse } from './exchangeRateParsing'

describe('decodeExchangeRateResponse', () => {
  it('uses USD when USDC is missing from exchangerate-api payloads', () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        result: 'success',
        base_code: 'USD',
        conversion_rates: { USD: 1, EUR: 0.92 },
      }),
    )

    expect(decodeExchangeRateResponse(body, 'USD', 'USDC')).toEqual({
      targetCurrency: 'USDC',
      baseCurrency: 'USD',
      rate: 1,
    })
  })

  it('still uses a direct USDC rate when one is present', () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        usd: { usdc: 0.9994, eur: 0.92 },
      }),
    )

    expect(decodeExchangeRateResponse(body, 'USD', 'USDC')).toEqual({
      targetCurrency: 'USDC',
      baseCurrency: 'USD',
      rate: 0.9994,
    })
  })
})