import {
  consensusIdenticalAggregation,
  cre,
  ok,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk'
import { decodeExchangeRateResponse as parseExchangeRateResponse } from './exchangeRateParsing'

type Config = {
  baseCurrency: string
  rateToleranceBps: number
  evms: Array<{
    stablecoinManagerAddress: string
    chainSelectorName: string
    gasLimit: string
    supportedCurrencies: string[]
  }>
}

type ExchangeRateResult = {
  targetCurrency: string
  baseCurrency: string
  rate: number
}

const DUMMY_EXCHANGERATE_API_KEY = 'DUMMY_KEY_FOR_HTTP_TRIGGER'

export function fetchExchangeRate(runtime: Runtime<Config>, currencyCode: string): ExchangeRateResult {
  const apiKey = runtime.getSecret({ id: 'EXCHANGERATE_API_KEY' }).result().value.trim()
  const usingFallback = !hasConfiguredExchangeRateApiKey(apiKey)
  runtime.log(
    usingFallback
      ? `[API] No Exchangerate API key configured; using public fallback for ${runtime.config.baseCurrency}/${currencyCode}...`
      : `[API] Fetching ${runtime.config.baseCurrency}/${currencyCode} from Exchangerate API...`,
  )

  const client = new cre.capabilities.HTTPClient()
  const response = client
    .sendRequest(runtime, buildExchangeRateRequest(currencyCode, apiKey), consensusIdenticalAggregation())(
      runtime.config,
    )
    .result()

  return parseExchangeRateResponse(response.body, runtime.config.baseCurrency, currencyCode) as ExchangeRateResult
}

const buildExchangeRateRequest =
  (currencyCode: string, apiKey: string) =>
  (sendRequester: HTTPSendRequester, config: Config) => {
    const url = hasConfiguredExchangeRateApiKey(apiKey)
      ? `https://v6.exchangerate-api.com/v6/${apiKey}/latest/${config.baseCurrency}`
      : `https://latest.currency-api.pages.dev/v1/currencies/${config.baseCurrency.toLowerCase()}.json`

    const response = sendRequester
      .sendRequest({
        url,
        method: 'GET',
        headers: { Accept: 'application/json' },
        cacheSettings: { store: true, maxAge: '60s' },
      })
      .result()

    if (!ok(response)) {
      const bodyText = new TextDecoder().decode(response.body)
      throw new Error(`Exchangerate API error: ${response.statusCode} - ${bodyText}`)
    }

    return response
  }

function hasConfiguredExchangeRateApiKey(apiKey: string) {
  return Boolean(apiKey && apiKey !== DUMMY_EXCHANGERATE_API_KEY)
}

export function decodeExchangeRateResponse(body: Uint8Array, baseCurrency: string, currencyCode: string): ExchangeRateResult {
  return parseExchangeRateResponse(body, baseCurrency, currencyCode) as ExchangeRateResult
}
