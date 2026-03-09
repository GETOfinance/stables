import {
  bytesToHex,
  cre,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  TxStatus,
  type EVMLog,
  type Runtime,
} from '@chainlink/cre-sdk'
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  hexToString,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
} from 'viem'
import { fetchExchangeRate } from './exchangerate'
import { isTestnetChain } from './network.mjs'
import { decodeKycMode, validateWorldIdPayload } from './worldId'

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

const EVENT_ABI = parseAbi([
  'event OperationRequested(bytes32 indexed operationId, address indexed user, bytes32 indexed currencyCode, uint8 operationType, uint256 amount, uint256 oracleRate)',
])

const CONTRACT_ABI = parseAbi([
  'function getPendingOperation(bytes32 operationId) view returns (address user, bytes32 currencyCode, uint8 operationType, uint8 kycMode, uint256 amount, uint256 oracleRate, bool kycRequired, bool offchainKycVerified, bool processed, uint8 rejectionReason)',
  'function getPendingWorldId(bytes32 operationId) view returns (uint256 root, uint256 nullifierHash, uint256[8] proof)',
])

const FINALIZE_OPERATION_PARAMS = parseAbiParameters('bytes32 operationId, uint256 apiRate, bool offchainKycVerified')

export function onLogTrigger(runtime: Runtime<Config>, log: EVMLog): string {
  runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  runtime.log('CRE Workflow: Log Trigger - Finalize Stablecoin Operation')
  runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const topics = log.topics.map((topic) => bytesToHex(topic)) as [`0x${string}`, ...`0x${string}`[]]
  const decodedLog = decodeEventLog({ abi: EVENT_ABI, topics, data: bytesToHex(log.data) })

  const operationId = decodedLog.args.operationId as `0x${string}`
  const currencyCodeBytes = decodedLog.args.currencyCode as `0x${string}`
  const currencyCode = hexToString(currencyCodeBytes, { size: 32 })
  const operationType = Number(decodedLog.args.operationType) === 0 ? 'mint' : 'burn'
  const amount = decodedLog.args.amount as bigint
  const oracleRate = decodedLog.args.oracleRate as bigint
  const evmConfig = runtime.config.evms[0]

  runtime.log(`[LOG] Operation id: ${operationId}`)
  runtime.log(`[LOG] Requested ${operationType.toUpperCase()} ${amount} ${currencyCode}`)
  runtime.log(`[LOG] Oracle rate: ${oracleRate}`)

  const rateResponse = fetchExchangeRate(runtime, currencyCode)
  const apiRate = BigInt(Math.round(rateResponse.rate * 1_000_000))
  const differenceBps = calculateDifferenceBps(Number(oracleRate), Number(apiRate))

  runtime.log(`[API] Exchangerate API rate: ${apiRate}`)
  runtime.log(`[CHECK] Difference: ${(differenceBps / 100).toFixed(2)}%`)
  runtime.log(
    differenceBps < runtime.config.rateToleranceBps
      ? '[CHECK] Difference within threshold; recording operation.'
      : '[CHECK] Difference above threshold; contract will reject recording.',
  )

  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: evmConfig.chainSelectorName,
    isTestnet: isTestnetChain(evmConfig.chainSelectorName),
  })

  if (!network) {
    throw new Error(`Unknown chain: ${evmConfig.chainSelectorName}`)
  }

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)
  const pendingOperationCall = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: evmConfig.stablecoinManagerAddress as Address,
        data: encodeFunctionData({ abi: CONTRACT_ABI, functionName: 'getPendingOperation', args: [operationId] }),
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()

  const pendingOperation = decodeFunctionResult({
    abi: CONTRACT_ABI,
    functionName: 'getPendingOperation',
    data: bytesToHex(pendingOperationCall.data),
  }) as unknown as readonly [Address, `0x${string}`, number, number, bigint, bigint, boolean, boolean, boolean, number]

  const kycModeRaw = pendingOperation[3]
  const kycRequired = pendingOperation[6]

  const kycMode = decodeKycMode(kycModeRaw)
  let offchainKycVerified = false

  if (kycRequired) {
    runtime.log(`[KYC] World ID required for this request -> ${kycMode}`)

    if (kycMode === 'off-chain') {
      const pendingWorldIdCall = evmClient
        .callContract(runtime, {
          call: encodeCallMsg({
            from: zeroAddress,
            to: evmConfig.stablecoinManagerAddress as Address,
            data: encodeFunctionData({ abi: CONTRACT_ABI, functionName: 'getPendingWorldId', args: [operationId] }),
          }),
          blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
        })
        .result()

      const pendingWorldId = decodeFunctionResult({
        abi: CONTRACT_ABI,
        functionName: 'getPendingWorldId',
        data: bytesToHex(pendingWorldIdCall.data),
      }) as unknown as readonly [bigint, bigint, readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]]

      const root = pendingWorldId[0]
      const nullifierHash = pendingWorldId[1]
      const proof = [...pendingWorldId[2]]

      const validation = validateWorldIdPayload({
        user: decodedLog.args.user as Address,
        currencyCode: currencyCodeBytes,
        mode: operationType,
        amount,
        oracleRate,
        kycMode,
        worldId: { root, nullifierHash, proof },
      })

      offchainKycVerified = validation.valid
      runtime.log(offchainKycVerified ? '[KYC] Off-chain World ID verification passed.' : `[KYC] ${validation.error}`)
    } else {
      runtime.log('[KYC] On-chain World ID verification will be performed during finalize.')
    }
  } else {
    runtime.log('[KYC] Request value is within the threshold; World ID proof not required.')
  }

  const settlementData = encodeAbiParameters(FINALIZE_OPERATION_PARAMS, [operationId, apiRate, offchainKycVerified])
  const prefixedReport = (`0x01${settlementData.slice(2)}`) as `0x${string}`

  const report = runtime
    .report({
      encodedPayload: hexToBase64(prefixedReport),
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

  runtime.log('[EVM] StablecoinManager finalized operation')
  runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  return `Finalized ${operationId}`
}

function calculateDifferenceBps(oracleRate: number, apiRate: number) {
  return Math.round((Math.abs(apiRate - oracleRate) / oracleRate) * 10_000)
}
