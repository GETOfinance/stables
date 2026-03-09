type ExchangeRateResponse = {
  result?: string
  base_code?: string
  conversion_rates?: Record<string, number>
  rates?: Record<string, number>
  [key: string]: unknown
}

type ExchangeRateResult = {
  targetCurrency: string
  baseCurrency: string
  rate: number
}

export function decodeExchangeRateResponse(body: Uint8Array, baseCurrency: string, currencyCode: string): ExchangeRateResult {
  const bodyText = new TextDecoder().decode(body)
  const parsed = JSON.parse(bodyText) as ExchangeRateResponse
  const rates = extractRates(parsed, baseCurrency)
  const normalizedCurrencyCode = currencyCode.toUpperCase()
  const rate =
    rates[currencyCode] ??
    rates[currencyCode.toLowerCase()] ??
    rates[normalizedCurrencyCode] ??
    (normalizedCurrencyCode === 'USDC' ? rates.USD ?? rates.usd : undefined)

  if (rate === undefined) {
    throw new Error(`Missing conversion rate for ${currencyCode}`)
  }

  return {
    targetCurrency: currencyCode,
    baseCurrency,
    rate,
  }
}

function extractRates(parsed: ExchangeRateResponse, baseCurrency: string) {
  if (parsed.conversion_rates) return parsed.conversion_rates
  if (parsed.rates) return parsed.rates

  const nestedRates = parsed[baseCurrency.toLowerCase()]
  if (nestedRates && typeof nestedRates === 'object') return nestedRates as Record<string, number>

  throw new Error('Missing exchange-rate payload in response body')
}