import { getAllowStubTx, getTenderlyRpcUrl, getTenderlyUsdcAddress } from './config.mjs'
import { addressToTopic, formatUsdcUnits, normalizeAddress, normalizeHex0x, nowIso, parseUsdcToUnits } from './utils.mjs'

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function normalizeChain(input) {
  const value = String(input || '').trim().toLowerCase()
  if (!value) return ''
  return ['tenderly', '9991', 'tenderly-9991', 'eth mainnet', 'ethereum'].includes(value) ? '9991' : ''
}

async function rpcCall(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) throw new Error(`rpc_http_error status=${response.status}`)
  const body = await response.json().catch(() => null)
  if (!body || body.result === undefined) throw new Error(body?.error?.message || 'rpc_missing_result')
  return body.result
}

export async function facilitatorVerifyPayment(env, req) {
  const txHash = normalizeHex0x(req.tx_hash)
  if (!txHash) return { ok: false, status: 400, error: 'invalid_tx_hash' }

  const chain = normalizeChain(req.required_chain)
  if (!chain) return { ok: false, status: 422, error: 'unsupported_chain' }

  const recipient = normalizeAddress(req.required_recipient)
  if (!recipient) return { ok: false, status: 400, error: 'invalid_required_recipient' }

  const requiredUnits = parseUsdcToUnits(req.required_price)
  if (requiredUnits === null) return { ok: false, status: 400, error: 'invalid_required_price' }

  if (getAllowStubTx(env) && txHash.startsWith('0xstub')) {
    return { ok: true, receipt: { tx_hash: txHash, paid_price: req.required_price, paid_chain: chain, paid_at: nowIso() } }
  }

  const rpcUrl = getTenderlyRpcUrl(env)
  if (!rpcUrl) return { ok: false, status: 501, error: 'rpc_not_configured' }

  const receipt = await rpcCall(rpcUrl, 'eth_getTransactionReceipt', [txHash]).catch(() => null)
  if (!receipt) return { ok: false, status: 404, error: 'tx_not_found' }
  if (String(receipt.status || '').toLowerCase() !== '0x1') return { ok: false, status: 422, error: 'tx_failed' }

  const usdcAddress = getTenderlyUsdcAddress(env)
  const toTopic = addressToTopic(recipient)
  let paidUnits = 0n

  for (const log of receipt.logs || []) {
    if (normalizeAddress(log.address) !== usdcAddress) continue
    if (normalizeHex0x(log.topics?.[0] || '') !== TRANSFER_TOPIC0) continue
    if (normalizeHex0x(log.topics?.[2] || '') !== toTopic) continue
    try {
      paidUnits += BigInt(normalizeHex0x(log.data))
    } catch {}
  }

  if (paidUnits < requiredUnits) return { ok: false, status: 402, error: 'underpaid' }

  let paidAt = nowIso()
  if (receipt.blockHash) {
    const block = await rpcCall(rpcUrl, 'eth_getBlockByHash', [receipt.blockHash, false]).catch(() => null)
    const timestampHex = String(block?.timestamp || '')
    if (/^0x[0-9a-f]+$/i.test(timestampHex)) {
      paidAt = new Date(Number.parseInt(timestampHex, 16) * 1000).toISOString()
    }
  }

  return {
    ok: true,
    receipt: {
      tx_hash: txHash,
      paid_price: formatUsdcUnits(paidUnits),
      paid_chain: chain,
      paid_at: paidAt,
    },
  }
}