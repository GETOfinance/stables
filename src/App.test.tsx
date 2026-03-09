import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

afterEach(() => {
  window.ethereum = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function getSidebarSection(title: string) {
  const heading = screen.getByRole('heading', { name: title })
  return heading.closest('.sidebar-section') as HTMLElement
}

describe('App CRE holdings flow', () => {
  it('renders a KYC dropdown with on-chain and off-chain options', async () => {
    const user = userEvent.setup()
    render(<App />)

    const kycSelect = screen.getByLabelText('KYC')
    expect(kycSelect).toBeTruthy()
    expect((kycSelect as HTMLSelectElement).value).toBe('on-chain')

    await user.selectOptions(kycSelect, 'off-chain')
    expect((kycSelect as HTMLSelectElement).value).toBe('off-chain')
    expect(screen.getByRole('option', { name: 'On-chain' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Off-chain' })).toBeTruthy()
  })

  it('records a successful mint into holdings, activity, totals, and terminal output when the bridge is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByLabelText('Amount (USDC)'), '10')
    await user.click(screen.getByRole('button', { name: 'Mint Stablecoin via CRE' }))

    const holdingsSection = getSidebarSection('Your Holdings (on-chain)')
    expect(within(holdingsSection).getByText('USDC')).toBeTruthy()
    expect(within(holdingsSection).getByText('10')).toBeTruthy()

    const activitySection = getSidebarSection('Recent Activity')
    expect(within(activitySection).getByText('Recorded mint 10 USDC')).toBeTruthy()

    expect(screen.getByText('Total Minted (local)').nextElementSibling?.textContent).toBe('10')
    expect(await screen.findByText(/OperationRecorded -> new balance 10 USDC/)).toBeTruthy()
    expect(screen.getByText('CRE SIM')).toBeTruthy()
  })

  it('switches or adds the Tenderly network automatically during wallet connection', async () => {
    let currentChainId = '0x1'
    const walletAddress = '0x1234567890123456789012345678901234567890'
    const request = vi.fn(async ({ method }: { method: string; params?: unknown[] | object }) => {
      switch (method) {
        case 'eth_accounts':
          return []
        case 'eth_requestAccounts':
          return [walletAddress]
        case 'eth_chainId':
          return currentChainId
        case 'wallet_switchEthereumChain': {
          if (currentChainId !== '0x2707') {
            const error = new Error('Unrecognized chain') as Error & { code?: number }
            error.code = 4902
            throw error
          }

          return null
        }
        case 'wallet_addEthereumChain':
          currentChainId = '0x2707'
          return null
        default:
          return null
      }
    })

    window.ethereum = {
      request,
      on: vi.fn(),
      removeListener: vi.fn(),
    }

    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Connect MetaMask wallet' }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x2707' }],
      })
    })

    expect(request).toHaveBeenCalledWith({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: '0x2707',
          chainName: 'Tenderly Eth Mainnet',
          nativeCurrency: {
            name: 'Ether',
            symbol: 'ETH',
            decimals: 18,
          },
          rpcUrls: ['https://virtual.mainnet.eu.rpc.tenderly.co/e9db97d6-ae88-45ff-8cc5-79e399163e8e'],
          blockExplorerUrls: ['https://dashboard.tenderly.co/explorer/vnet/e9db97d6-ae88-45ff-8cc5-79e399163e8e/transactions'],
        },
      ],
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: `Connected wallet ${walletAddress}` })).toBeTruthy()
    })

    expect(screen.queryByText('Unsupported network')).toBeNull()
  })

  it('requires a World ID proof for requests above $100 and blocks submit when the proof is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByLabelText('Amount (USDC)'), '101')

    expect(screen.getByText('World ID required for this request')).toBeTruthy()
    expect(screen.getByLabelText('World ID Root')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Mint Stablecoin via CRE' }))

    expect(screen.getByText('World ID root and nullifier hash are required for requests above $100.')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records a successful high-value mint with a demo World ID proof when the bridge is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByLabelText('Amount (USDC)'), '101')
    await user.click(screen.getByRole('button', { name: 'Use demo World ID proof' }))
    await user.click(screen.getByRole('button', { name: 'Mint Stablecoin via CRE' }))

    const holdingsSection = getSidebarSection('Your Holdings (on-chain)')
    await waitFor(() => {
      expect(within(holdingsSection).getByText('USDC')).toBeTruthy()
      expect(within(holdingsSection).getByText('101')).toBeTruthy()
    })

    expect(screen.getByText('CRE SIM')).toBeTruthy()
    expect(await screen.findByText('[kyc] World ID proof accepted')).toBeTruthy()
  })

  it('streams live CRE terminal output and syncs the resulting holding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()
              const events = [
                { type: 'log', line: '[bridge] Launching HTTP trigger simulation...' },
                { type: 'log', line: '[HTTP] Operation: MINT 101 USDC' },
                { type: 'log', line: '[EVM] StablecoinManager finalized operation' },
                { type: 'log', line: '[agent] /v1/governor/check -> 402 friction required for consumed CRE workflow (dec_demo)' },
                { type: 'result', status: 'recorded', differenceBps: 180, nextBalance: 101 },
              ]

              for (const event of events) {
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
              }

              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<App />)

    await user.type(screen.getByLabelText('Amount (USDC)'), '101')
    await user.selectOptions(screen.getByLabelText('KYC'), 'off-chain')
    await user.click(screen.getByRole('button', { name: 'Use demo World ID proof' }))
    await user.click(screen.getByRole('button', { name: 'Mint Stablecoin via CRE' }))

    expect(await screen.findByText('[HTTP] Operation: MINT 101 USDC')).toBeTruthy()
    expect(screen.getByText(/402 friction required/)).toBeTruthy()
    expect(screen.getByText('CRE LIVE')).toBeTruthy()

    const [, requestInit] = fetchMock.mock.calls[0]
    const livePayload = JSON.parse((requestInit as RequestInit).body as string)
    expect(livePayload.kycMode).toBe('off-chain')
    expect(livePayload.worldId.root).toBeTruthy()
    expect(livePayload.worldId.proof).toHaveLength(8)

    const holdingsSection = getSidebarSection('Your Holdings (on-chain)')
    await waitFor(() => {
      expect(within(holdingsSection).getByText('USDC')).toBeTruthy()
      expect(within(holdingsSection).getByText('101')).toBeTruthy()
    })

    const activitySection = getSidebarSection('Recent Activity')
    expect(within(activitySection).getByText('Recorded mint 101 USDC')).toBeTruthy()
    expect(screen.getByText('Total Minted (local)').nextElementSibling?.textContent).toBe('101')
  })

  it('blocks a burn that exceeds current holdings before submitting a simulated CRE write', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Burn' }))
    await user.type(screen.getByLabelText('Amount (USDC)'), '5')
    await user.click(screen.getByRole('button', { name: 'Burn Stablecoin via CRE' }))

    expect(screen.getByText('Burn amount exceeds your current USDC holding.')).toBeTruthy()
    expect(screen.getByText('$ local-guard blocked burn 5 USDC')).toBeTruthy()

    const holdingsSection = getSidebarSection('Your Holdings (on-chain)')
    expect(within(holdingsSection).getByText('No recorded stablecoin holdings yet.')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})