import type { Mode } from './creSimulation'
import type { KycMode, WorldIdPayload } from './worldId'

const CRE_BRIDGE_URL = (import.meta.env.VITE_CRE_BRIDGE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')

export type LiveAgentResult =
  | {
      status: 'paid'
      quoteId: string
      decisionId: string
      paymentTxHash: string
      requiredPrice: string
      requiredChain: string
      requiredRecipient: string
      proceedToken: string
      receipt: {
        tx_hash: string
        paid_price: string
        paid_chain: string
        paid_at: string
      }
    }
  | {
      status: 'pending'
      quoteId: string
      decisionId: string
      requiredPrice: string
      requiredChain: string
      requiredRecipient: string
    }
  | {
      status: 'error'
      quoteId?: string
      decisionId?: string
      paymentTxHash?: string
      error: string
    }

type StreamEvent =
  | { type: 'log'; line: string }
  | {
      type: 'result'
      status: 'recorded' | 'rejected'
      differenceBps: number
      nextBalance: number
      rejectionReason?: 'rate' | 'kyc'
      rejectionMessage?: string
      agent?: LiveAgentResult
    }
  | { type: 'result'; status: 'error'; errorMessage: string; agent?: LiveAgentResult }

export type LiveCreResult = Extract<StreamEvent, { type: 'result' }>

type LiveCreInput = {
  user: string
  mode: Mode
  kycMode: KycMode
  currencyCode: string
  amount: number
  oracleRate: number
  worldId?: WorldIdPayload
}

type RunLiveCreOptions = {
  onLine?: (line: string) => void
}

export async function runLiveCreOperation(input: LiveCreInput, options: RunLiveCreOptions = {}): Promise<LiveCreResult> {
  const response = await fetch(`${CRE_BRIDGE_URL}/api/cre/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Live CRE bridge returned ${response.status}.`)
  }

  if (!response.body) {
    throw new Error('Live CRE bridge did not return a readable stream.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResult: LiveCreResult | null = null

  const flushBuffer = () => {
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) {
        continue
      }

      const event = JSON.parse(line) as StreamEvent

      if (event.type === 'log') {
        options.onLine?.(event.line)
      } else {
        finalResult = event
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      buffer += decoder.decode()
      flushBuffer()
      break
    }

    buffer += decoder.decode(value, { stream: true })
    flushBuffer()
  }

  if (!finalResult) {
    throw new Error('Live CRE bridge closed without sending a final result.')
  }

  return finalResult
}