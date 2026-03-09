import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createPublicClient, decodeEventLog, http as viemHttp, parseAbi, stringToHex } from 'viem'

import { runAgentFlow } from '../../agent/flow.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const creBinary = process.env.CRE_BIN_PATH || '/home/user/.cre/bin/cre'
const host = process.env.CRE_BRIDGE_HOST || '127.0.0.1'
const port = Number(process.env.CRE_BRIDGE_PORT || 8787)
const rpcUrl = process.env.CRE_LOCAL_RPC_URL || 'https://virtual.mainnet.eu.rpc.tenderly.co/e9db97d6-ae88-45ff-8cc5-79e399163e8e'
const defaultPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const defaultExchangeRateApiKey = 'DUMMY_KEY_FOR_HTTP_TRIGGER'
const config = JSON.parse(await readFile(resolve(__dirname, 'config.local.json'), 'utf8'))
const contractAddress = config.evms[0].stablecoinManagerAddress
const publicClient = createPublicClient({ transport: viemHttp(rpcUrl) })
const contractAbi = parseAbi([
  'event OperationRequested(bytes32 indexed operationId, address indexed user, bytes32 indexed currencyCode, uint8 operationType, uint256 amount, uint256 oracleRate)',
  'event OperationRecorded(bytes32 indexed operationId, address indexed user, bytes32 indexed currencyCode, uint8 operationType, uint256 amount, uint256 apiRate, uint256 oracleRate, uint16 differenceBps, uint256 resultingBalance)',
  'event OperationRejected(bytes32 indexed operationId, address indexed user, bytes32 indexed currencyCode, uint8 operationType, uint256 amount, uint256 apiRate, uint256 oracleRate, uint16 differenceBps)',
  'function getHolding(address user, bytes32 currencyCode) view returns (uint256)',
  'function getPendingOperation(bytes32 operationId) view returns (address user, bytes32 currencyCode, uint8 operationType, uint8 kycMode, uint256 amount, uint256 oracleRate, bool kycRequired, bool offchainKycVerified, bool processed, uint8 rejectionReason)',
])

http.createServer((request, response) => {
  void handleRequest(request, response)
}).listen(port, host, () => {
  console.log(`CRE bridge listening on http://${host}:${port}`)
})

async function handleRequest(request, response) {
  setCorsHeaders(response)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, contractAddress, workflowName: 'stablecoin-workflow-local' }))
    return
  }

  if (request.method !== 'POST' || request.url !== '/api/cre/run') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }

  const body = await readJsonBody(request)
  const normalizedInput = parseCreRequest(body)
  if (!normalizedInput.ok) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(normalizedInput.error)
    return
  }
  const creInput = normalizedInput.value

  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })

  const state = { child: null, closed: false }
  request.on('close', () => {
    state.closed = true
    state.child?.kill('SIGTERM')
  })

  const envFilePath = await writeEnvFile()

  try {
    sendEvent(response, { type: 'log', line: `[bridge] Connected to CRE bridge on ${host}:${port}` })
    sendEvent(response, { type: 'log', line: `[bridge] Workflow RPC ${rpcUrl}` })
    sendEvent(response, { type: 'log', line: `[bridge] StablecoinManager ${contractAddress}` })

    if (!process.env.EXCHANGERATE_API_KEY_VAR) {
      sendEvent(response, { type: 'log', line: '[bridge] EXCHANGERATE_API_KEY_VAR is not set; using a dummy key so the finalize stage can still stream its failure.' })
    }

    const httpStartBlock = await publicClient.getBlockNumber()
    const httpStage = await runSimulation([
      'workflow', 'simulate', './my-workflow', '--project-root', '.', '--target', 'local-settings', '--non-interactive', '--trigger-index', '0', '--http-payload',
      JSON.stringify({
        user: creInput.user,
        currencyCode: creInput.currencyCode,
        operationType: creInput.mode,
        amount: creInput.amount,
        oracleRate: creInput.oracleRate,
        kycMode: creInput.kycMode,
        worldId: creInput.worldId,
      }),
      '--broadcast', '-e', envFilePath,
    ], response, state)

    if (state.closed) return
    if (!httpStage.txHash && httpStage.exitCode === 0) {
      httpStage.txHash = await findRequestTransactionHash(httpStartBlock + 1n, creInput.user, creInput.currencyCode)
    }
    if (httpStage.exitCode !== 0 || !httpStage.txHash) {
      sendEvent(response, { type: 'result', status: 'error', errorMessage: httpStage.errorMessage || 'HTTP-trigger CRE simulation failed before a transaction hash was produced.' })
      response.end()
      return
    }

    sendEvent(response, { type: 'log', line: `[bridge] HTTP stage complete -> ${httpStage.txHash}` })
    sendEvent(response, { type: 'log', line: '[bridge] Launching log-trigger finalize simulation...' })

    const logStartBlock = await publicClient.getBlockNumber()
    const logStage = await runSimulation([
      'workflow', 'simulate', './my-workflow', '--project-root', '.', '--target', 'local-settings', '--non-interactive', '--trigger-index', '1', '--evm-tx-hash', httpStage.txHash,
      '--evm-event-index', '0', '--broadcast', '-e', envFilePath,
    ], response, state)

    if (state.closed) return
    if (logStage.exitCode !== 0) {
      sendEvent(response, { type: 'result', status: 'error', errorMessage: logStage.errorMessage || 'Finalize-stage CRE simulation failed before completion.' })
      response.end()
      return
    }

    const creOutcome = await resolveOutcome(logStartBlock + 1n, creInput.user, creInput.currencyCode)
    let agent = undefined
    try {
      agent = await runAgentFlow({
        creInput,
        creOutcome,
        emit: (line) => sendEvent(response, { type: 'log', line }),
      })
    } catch (error) {
      agent = { status: 'error', error: error instanceof Error ? error.message : 'Unexpected agent flow error.' }
      sendEvent(response, { type: 'log', line: `[agent] ${agent.error}` })
    }

    sendEvent(response, { type: 'result', ...creOutcome, agent })
    response.end()
  } catch (error) {
    sendEvent(response, { type: 'result', status: 'error', errorMessage: error instanceof Error ? error.message : 'Unexpected CRE bridge error.' })
    response.end()
  } finally {
    await rm(envFilePath, { force: true })
  }
}

async function runSimulation(args, response, state) {
  sendEvent(response, { type: 'log', line: `$ ${creBinary} ${args.join(' ')}` })
  const child = spawn(creBinary, args, { cwd: projectRoot, env: process.env })
  state.child = child
  const result = { exitCode: 1, txHash: null, errorMessage: '' }
  const forward = (streamName, line) => {
    const formatted = formatProcessLine(streamName, line, result)
    if (formatted) sendEvent(response, { type: 'log', line: formatted })
  }
  readline.createInterface({ input: child.stdout }).on('line', (line) => forward('stdout', line))
  readline.createInterface({ input: child.stderr }).on('line', (line) => forward('stderr', line))
  result.exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', (code) => resolveExit(code ?? 1))
  })
  state.child = null
  return result
}

function formatProcessLine(streamName, rawLine, result) {
  const line = rawLine.trim()
  if (!line) return null
  if (streamName === 'stdout') {
    const userLogIndex = line.indexOf('[USER LOG]')
    return userLogIndex >= 0 ? line.slice(userLogIndex + '[USER LOG]'.length).trim() : line
  }
  if (!line.startsWith('{')) return line
  try {
    const parsed = JSON.parse(line)
    if (parsed.msg === 'EVM Chain WriteReport Started') return '[engine] EVM Chain WriteReport Started'
    if (parsed.msg === 'EVM Chain WriteReport Successful') {
      result.txHash = parsed.txHash ?? result.txHash
      return `[engine] EVM Chain WriteReport Successful -> ${parsed.txHash}`
    }
    if (parsed.msg === 'Workflow execution starting ...') return `[engine] Workflow execution starting (trigger ${parsed.triggerIndex})`
    if (parsed.msg === 'All triggers registered successfully') return '[engine] Workflow triggers registered'
    if (parsed.msg === 'Workflow execution finished successfully') return '[engine] Workflow execution finished successfully'
    if (parsed.msg === 'Workflow execution failed') {
      result.errorMessage = parsed.error || 'Workflow execution failed.'
      return `[engine] Workflow execution failed: ${result.errorMessage}`
    }
    if (parsed.msg === 'Loaded secrets from ../secrets.yaml') return '[engine] Loaded secrets mapping from stablecoin/secrets.yaml'
    return null
  } catch {
    return line
  }
}

async function findRequestTransactionHash(fromBlock, user, currencyCode) {
  const requestLog = await findLatestMatchingLog(['OperationRequested'], fromBlock, user, currencyCode)
  return requestLog?.transactionHash ?? null
}

async function resolveOutcome(fromBlock, user, currencyCode) {
  const outcomeLog = await findLatestMatchingLog(['OperationRecorded', 'OperationRejected'], fromBlock, user, currencyCode)
  if (!outcomeLog) throw new Error('No OperationRecorded/OperationRejected event found for the finalize stage.')
  if (outcomeLog.decoded.eventName === 'OperationRecorded') {
    return { status: 'recorded', differenceBps: Number(outcomeLog.decoded.args.differenceBps), nextBalance: Number(outcomeLog.decoded.args.resultingBalance) }
  }

  const holding = await publicClient.readContract({
    address: contractAddress,
    abi: contractAbi,
    functionName: 'getHolding',
    args: [user, stringToHex(currencyCode, { size: 32 })],
  })
  const pendingOperation = await publicClient.readContract({
    address: contractAddress,
    abi: contractAbi,
    functionName: 'getPendingOperation',
    args: [outcomeLog.decoded.args.operationId],
  })
  const rejectionReasonCode = Number(pendingOperation[9])
  const rejectionReason = rejectionReasonCode === 2 ? 'kyc' : rejectionReasonCode === 1 ? 'rate' : undefined

  return {
    status: 'rejected',
    differenceBps: Number(outcomeLog.decoded.args.differenceBps),
    nextBalance: Number(holding),
    rejectionReason,
    rejectionMessage:
      rejectionReason === 'kyc'
        ? 'World ID KYC verification failed.'
        : rejectionReason === 'rate'
          ? 'Rate guard rejected the write.'
          : 'Operation was rejected.',
  }
}

function parseCreRequest(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Missing CRE payload body.' }
  }

  const { user, currencyCode, mode, amount, oracleRate, kycMode, worldId } = body
  if (typeof user !== 'string' || !user || typeof currencyCode !== 'string' || !currencyCode || typeof mode !== 'string') {
    return { ok: false, error: 'Missing required CRE payload fields.' }
  }
  if (mode !== 'mint' && mode !== 'burn') {
    return { ok: false, error: 'Operation mode must be mint or burn.' }
  }
  if (kycMode !== 'on-chain' && kycMode !== 'off-chain') {
    return { ok: false, error: 'KYC mode must be on-chain or off-chain.' }
  }

  let normalizedAmount
  let normalizedOracleRate
  try {
    normalizedAmount = toPositiveBigIntString(amount)
    normalizedOracleRate = toPositiveBigIntString(oracleRate)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid amount or oracle rate.' }
  }

  const kycRequired = requiresWorldIdKyc(normalizedAmount, normalizedOracleRate)
  const normalizedWorldId = normalizeWorldId(worldId, kycRequired)
  if (!normalizedWorldId.ok) {
    return normalizedWorldId
  }

  return {
    ok: true,
    value: {
      user,
      currencyCode,
      mode,
      kycMode,
      amount: normalizedAmount,
      oracleRate: normalizedOracleRate,
      worldId: normalizedWorldId.value,
    },
  }
}

function requiresWorldIdKyc(amount, oracleRate) {
  return BigInt(amount) * 1_000_000n > BigInt(oracleRate) * 100n
}

function normalizeWorldId(worldId, required) {
  if (!required && (worldId == null || worldId === false)) {
    return { ok: true, value: undefined }
  }
  if (!worldId || typeof worldId !== 'object') {
    return required
      ? { ok: false, error: 'World ID proof is required for requests above $100 in USD value.' }
      : { ok: true, value: undefined }
  }

  const { root, nullifierHash, proof } = worldId
  if (!Array.isArray(proof) || proof.length !== 8) {
    return { ok: false, error: 'World ID proof must contain exactly 8 uint256 values.' }
  }

  try {
    return {
      ok: true,
      value: {
        root: toPositiveBigIntString(root),
        nullifierHash: toPositiveBigIntString(nullifierHash),
        proof: proof.map((value) => toPositiveBigIntString(value)),
      },
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid World ID payload.' }
  }
}

function toPositiveBigIntString(value) {
  const parsed = BigInt(value)
  if (parsed <= 0n) {
    throw new Error('CRE bridge expects positive integer amount, oracle rate, and World ID fields.')
  }
  return parsed.toString()
}

async function findLatestMatchingLog(eventNames, fromBlock, user, currencyCode) {
  const expectedCurrencyCode = stringToHex(currencyCode, { size: 32 }).toLowerCase()
  const logs = await publicClient.getLogs({ address: contractAddress, fromBlock, toBlock: 'latest' })
  for (const log of [...logs].reverse()) {
    try {
      const decoded = decodeEventLog({ abi: contractAbi, data: log.data, topics: log.topics })
      if (!eventNames.includes(decoded.eventName)) continue
      if (decoded.args.user?.toLowerCase() !== user.toLowerCase()) continue
      if (decoded.args.currencyCode?.toLowerCase() !== expectedCurrencyCode) continue
      return { transactionHash: log.transactionHash, decoded }
    } catch {}
  }
  return null
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function writeEnvFile() {
  const tmpDir = resolve(projectRoot, '.tmp')
  await mkdir(tmpDir, { recursive: true })
  const envFilePath = resolve(tmpDir, `cre-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}.env`)
  const lines = [
    `CRE_ETH_PRIVATE_KEY=${process.env.CRE_ETH_PRIVATE_KEY || defaultPrivateKey}`,
    `EXCHANGERATE_API_KEY_VAR=${process.env.EXCHANGERATE_API_KEY_VAR || defaultExchangeRateApiKey}`,
  ]
  await writeFile(envFilePath, `${lines.join('\n')}\n`, 'utf8')
  return envFilePath
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

function sendEvent(response, payload) {
  if (!response.writableEnded) response.write(`${JSON.stringify(payload)}\n`)
}