import {
  cre,
  decodeJson,
  getNetwork,
  hexToBase64,
  TxStatus,
  type HTTPPayload,
  type Runtime,
} from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters, stringToHex } from 'viem'
import { isTestnetChain } from './network.mjs'

type WorldIdPayload = {
  root: string | number
  nullifierHash: string | number
  proof: Array<string | number>
}

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

type OperationPayload = {
  user: `0x${string}`
  currencyCode: string
  operationType: 'mint' | 'burn'
  amount: string | number
  oracleRate: string | number
  kycMode: 'on-chain' | 'off-chain'
  worldId?: WorldIdPayload | null
}

const CREATE_OPERATION_PARAMS = parseAbiParameters(
  'address user, bytes32 currencyCode, uint8 operationType, uint256 amount, uint256 oracleRate, uint8 kycMode, uint256 worldIdRoot, uint256 worldIdNullifierHash, uint256[8] worldIdProof',
)

export function onHttpTrigger(runtime: Runtime<Config>, payload: HTTPPayload): string {
  runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  runtime.log('CRE Workflow: HTTP Trigger - Create Stablecoin Operation')
  runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  if (!payload.input || payload.input.length === 0) {
    throw new Error('Empty request payload')
  }

  const input = decodeJson(payload.input) as OperationPayload
  const evmConfig = runtime.config.evms[0]

  if (!evmConfig.supportedCurrencies.includes(input.currencyCode)) {
    throw new Error(`Unsupported currency: ${input.currencyCode}`)
  }

  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: evmConfig.chainSelectorName,
    isTestnet: isTestnetChain(evmConfig.chainSelectorName),
  })

  if (!network) {
    throw new Error(`Unknown chain: ${evmConfig.chainSelectorName}`)
  }

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)
  const worldIdRoot = input.worldId?.root ?? '0'
  const worldIdNullifierHash = input.worldId?.nullifierHash ?? '0'
  const worldIdProof = normalizeProof(input.worldId?.proof)
  const reportData = encodeAbiParameters(CREATE_OPERATION_PARAMS, [
    input.user,
    stringToHex(input.currencyCode, { size: 32 }),
    input.operationType === 'mint' ? 0 : 1,
    BigInt(input.amount),
    BigInt(input.oracleRate),
    input.kycMode === 'on-chain' ? 0 : 1,
    BigInt(worldIdRoot),
    BigInt(worldIdNullifierHash),
    worldIdProof,
  ])

  runtime.log(`[HTTP] User: ${input.user}`)
  runtime.log(`[HTTP] Operation: ${input.operationType.toUpperCase()} ${input.amount} ${input.currencyCode}`)
  runtime.log(`[HTTP] Oracle rate: ${input.oracleRate}`)
  runtime.log(`[HTTP] KYC mode: ${input.kycMode}`)

  const report = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: 'evm',
      signingAlgo: 'ecdsa',
      hashingAlgo: 'keccak256',
    })
    .result()

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.stablecoinManagerAddress,
      report,
      gasConfig: { gasLimit: evmConfig.gasLimit },
    })
    .result()

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Transaction failed: ${writeResult.txStatus}`)
  }

  runtime.log('[HTTP] Operation request written to StablecoinManager')
  runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  return 'Operation request submitted'
}

function normalizeProof(proof?: Array<string | number>) {
  const values = [...(proof ?? [])]
  while (values.length < 8) {
    values.push('0')
  }

  return values.slice(0, 8).map((value) => BigInt(value)) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
}
