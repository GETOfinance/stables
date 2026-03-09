import { randomBytes } from 'node:crypto'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function normalizeHex0x(input) {
  const value = String(input || '').trim().toLowerCase()
  if (!value) return ''
  return value.startsWith('0x') ? value : `0x${value}`
}

export function normalizeAddress(input) {
  const value = normalizeHex0x(input)
  return /^0x[0-9a-f]{40}$/.test(value) ? value : ''
}

export function addressToTopic(address) {
  const value = normalizeAddress(address)
  return value ? `0x${value.slice(2).padStart(64, '0')}` : ''
}

export function parseUsdcToUnits(price) {
  const match = String(price || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*USDC$/i)
  if (!match) return null
  const [whole, fraction = ''] = match[1].split('.')
  const paddedFraction = (fraction + '000000').slice(0, 6)
  if (!/^[0-9]+$/.test(whole) || !/^[0-9]{6}$/.test(paddedFraction)) return null
  return BigInt(whole) * 1_000_000n + BigInt(paddedFraction)
}

export function formatUsdcUnits(units) {
  const sign = units < 0n ? '-' : ''
  const value = units < 0n ? -units : units
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${sign}${whole}${fraction ? `.${fraction}` : ''} USDC`
}

export function makeDecisionId() {
  return `dec_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`
}

export function makeQuoteId() {
  return makeDecisionId().replace(/^dec_/, 'q_')
}

export function makeProceedToken(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function shortenAddress(address) {
  return address && address.length >= 10 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address || 'unknown'
}

export function nowIso() {
  return new Date().toISOString()
}