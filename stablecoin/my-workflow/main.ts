import { cre, getNetwork, Runner } from '@chainlink/cre-sdk'
import { keccak256, toHex } from 'viem'
import { onHttpTrigger } from './httpCallback'
import { onLogTrigger } from './logCallback'
import { isTestnetChain } from './network.mjs'

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

const OPERATION_REQUESTED_SIGNATURE =
  'OperationRequested(bytes32,address,bytes32,uint8,uint256,uint256)'

const initWorkflow = (config: Config) => {
  const httpCapability = new cre.capabilities.HTTPCapability()
  const httpTrigger = httpCapability.trigger({})

  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: config.evms[0].chainSelectorName,
    isTestnet: isTestnetChain(config.evms[0].chainSelectorName),
  })

  if (!network) {
    throw new Error(`Network not found: ${config.evms[0].chainSelectorName}`)
  }

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)
  const eventHash = keccak256(toHex(OPERATION_REQUESTED_SIGNATURE))

  return [
    cre.handler(httpTrigger, onHttpTrigger),
    cre.handler(
      evmClient.logTrigger({
        addresses: [config.evms[0].stablecoinManagerAddress],
        topics: [{ values: [eventHash] }],
        confidence: 'CONFIDENCE_LEVEL_FINALIZED',
      }),
      onLogTrigger,
    ),
  ]
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}

main()