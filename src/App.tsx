import { useEffect, useMemo, useState } from 'react'
import {
  CRE_PROJECT_SUMMARY,
  INITIAL_TERMINAL_LINES,
  SIMULATION_USER_ADDRESS,
  type ActivityItem,
  currencies,
  formatAmount,
  formatDifference,
  simulateCreOperation,
} from './creSimulation'
import { runLiveCreOperation } from './creBridgeClient'
import {
  WORLD_ID_KYC_THRESHOLD_USD,
  createDemoWorldIdPayload,
  estimateUsdValue,
  parseWorldIdForm,
  requiresWorldIdKyc,
  validateWorldIdPayload,
  type KycMode,
  type WorldIdPayload,
} from './worldId'

type Mode = 'mint' | 'burn'
type Theme = 'dark' | 'light'

const TERMINAL_HISTORY_LIMIT = 18

const TENDERLY_NETWORK = {
  name: 'Tenderly Eth Mainnet',
  rpcUrl: 'https://virtual.mainnet.eu.rpc.tenderly.co/e9db97d6-ae88-45ff-8cc5-79e399163e8e',
  chainId: 9991,
  currencySymbol: 'ETH',
  blockExplorer: 'https://dashboard.tenderly.co/explorer/vnet/e9db97d6-ae88-45ff-8cc5-79e399163e8e/transactions',
}

const TENDERLY_CHAIN_ID_HEX = `0x${TENDERLY_NETWORK.chainId.toString(16)}`

const TENDERLY_ADD_CHAIN_PARAMS = {
  chainId: TENDERLY_CHAIN_ID_HEX,
  chainName: TENDERLY_NETWORK.name,
  nativeCurrency: {
    name: 'Ether',
    symbol: TENDERLY_NETWORK.currencySymbol,
    decimals: 18,
  },
  rpcUrls: [TENDERLY_NETWORK.rpcUrl],
  blockExplorerUrls: [TENDERLY_NETWORK.blockExplorer],
}

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>
  on?: (eventName: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (eventName: string, listener: (...args: unknown[]) => void) => void
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
  }
}

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 7.5A2.5 2.5 0 0 1 7 5h9.5a1 1 0 1 1 0 2H7a.5.5 0 0 0 0 1h10.5A2.5 2.5 0 0 1 20 10.5v6A2.5 2.5 0 0 1 17.5 19h-10A2.5 2.5 0 0 1 5 16.5v-7" />
      <path d="M15.5 13.5h3" />
      <circle cx="15.5" cy="13.5" r=".8" fill="currentColor" stroke="none" />
    </svg>
  )
}

function DirectionIcon({ mode }: { mode: Mode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d={mode === 'mint' ? 'M12 16V8m0 0-3 3m3-3 3 3' : 'M12 8v8m0 0-3-3m3 3 3-3'} />
    </svg>
  )
}

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === 'dark') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 15.2A7.5 7.5 0 0 1 8.8 4a8 8 0 1 0 11.2 11.2Z" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
    </svg>
  )
}

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function parseChainId(chainIdValue: unknown) {
  if (typeof chainIdValue === 'string') {
    return chainIdValue.startsWith('0x') ? Number.parseInt(chainIdValue, 16) : Number.parseInt(chainIdValue, 10)
  }

  if (typeof chainIdValue === 'number') {
    return chainIdValue
  }

  return null
}

function parseAccounts(accountsValue: unknown) {
  return Array.isArray(accountsValue)
    ? accountsValue.filter((account): account is string => typeof account === 'string')
    : []
}

async function readAccounts(provider: EthereumProvider) {
  return parseAccounts(await provider.request({ method: 'eth_accounts' }))
}

async function readChainId(provider: EthereumProvider) {
  return parseChainId(await provider.request({ method: 'eth_chainId' }))
}

function getProviderErrorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
    ? error.code
    : undefined
}

async function switchToTenderlyNetwork(provider: EthereumProvider) {
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: TENDERLY_CHAIN_ID_HEX }],
  })
}

async function ensureTenderlyNetwork(provider: EthereumProvider) {
  const currentChainId = await readChainId(provider)

  if (currentChainId === TENDERLY_NETWORK.chainId) {
    return currentChainId
  }

  try {
    await switchToTenderlyNetwork(provider)
  } catch (error) {
    if (getProviderErrorCode(error) !== 4902) {
      throw error
    }

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [TENDERLY_ADD_CHAIN_PARAMS],
    })
    await switchToTenderlyNetwork(provider)
  }

  return readChainId(provider)
}

export default function App() {
  const [mode, setMode] = useState<Mode>('mint')
  const [kycMode, setKycMode] = useState<KycMode>('on-chain')
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') {
      return 'dark'
    }

    return window.localStorage.getItem('stablecoins-theme') === 'light' ? 'light' : 'dark'
  })
  const [currencyCode, setCurrencyCode] = useState<string>('USDC')
  const [amount, setAmount] = useState<string>('')
  const [walletAddress, setWalletAddress] = useState<string>('')
  const [walletError, setWalletError] = useState<string>('')
  const [isConnecting, setIsConnecting] = useState<boolean>(false)
  const [chainId, setChainId] = useState<number | null>(null)
  const [copiedAddress, setCopiedAddress] = useState<boolean>(false)
  const [walletUiReset, setWalletUiReset] = useState<boolean>(false)
  const [operationError, setOperationError] = useState<string>('')
  const [holdings, setHoldings] = useState<Record<string, number>>({})
  const [recentActivity, setRecentActivity] = useState<ActivityItem[]>([])
  const [terminalLines, setTerminalLines] = useState<string[]>(INITIAL_TERMINAL_LINES)
  const [sessionMinted, setSessionMinted] = useState<number>(0)
  const [sessionBurned, setSessionBurned] = useState<number>(0)
  const [isRunningOperation, setIsRunningOperation] = useState<boolean>(false)
  const [terminalMode, setTerminalMode] = useState<'live' | 'simulation'>('simulation')
  const [worldIdRoot, setWorldIdRoot] = useState<string>('')
  const [worldIdNullifierHash, setWorldIdNullifierHash] = useState<string>('')
  const [worldIdProof, setWorldIdProof] = useState<string>('')

  const activeCurrency = useMemo(
    () => currencies.find((currency) => currency.code === currencyCode) ?? currencies[0],
    [currencyCode],
  )
  const currentHolding = holdings[currencyCode] ?? 0
  const holdingEntries = useMemo(
    () => Object.entries(holdings).filter(([, balance]) => balance > 0).sort((a, b) => b[1] - a[1]),
    [holdings],
  )

  const walletLabel = useMemo(() => {
    if (isConnecting) {
      return 'Connecting...'
    }

    return walletAddress ? shortenAddress(walletAddress) : 'Connect Wallet'
  }, [isConnecting, walletAddress])

  const isSupportedNetwork = chainId === TENDERLY_NETWORK.chainId
  const networkLabel = TENDERLY_NETWORK.name
  const parsedAmountValue = Number(amount)
  const estimatedUsdValue = useMemo(
    () => estimateUsdValue(parsedAmountValue, activeCurrency.rate),
    [activeCurrency.rate, parsedAmountValue],
  )
  const worldIdRequired = useMemo(
    () => requiresWorldIdKyc(parsedAmountValue, activeCurrency.rate),
    [activeCurrency.rate, parsedAmountValue],
  )

  const walletNote = useMemo(() => {
    if (walletError) {
      return walletError
    }

    if (walletAddress) {
      return `${TENDERLY_NETWORK.name} · Chain ID ${TENDERLY_NETWORK.chainId} · ${TENDERLY_NETWORK.currencySymbol} · ${walletAddress}`
    }

    if (walletUiReset) {
      return 'Wallet UI reset. Connect Wallet to reconnect.'
    }

    return `Supported network: ${TENDERLY_NETWORK.name} · RPC ${TENDERLY_NETWORK.rpcUrl} · Chain ID ${TENDERLY_NETWORK.chainId} · ${TENDERLY_NETWORK.currencySymbol}`
  }, [walletAddress, walletError, walletUiReset])

  const syncWalletState = async (provider: EthereumProvider, accountsOverride?: string[]) => {
    const accounts = accountsOverride ?? (await readAccounts(provider))
    const nextWalletAddress = accounts[0] ?? ''

    setWalletAddress(nextWalletAddress)

    if (!nextWalletAddress) {
      setChainId(null)
      setWalletError('')
      return
    }

    const currentChainId = await readChainId(provider)
    setChainId(currentChainId)

    if (currentChainId === TENDERLY_NETWORK.chainId) {
      setWalletError('')
      return
    }

    const nextChainId = await ensureTenderlyNetwork(provider)
    setChainId(nextChainId)
    setWalletError(nextChainId === TENDERLY_NETWORK.chainId ? '' : `MetaMask is still not on ${TENDERLY_NETWORK.name}.`)
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('stablecoins-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!copiedAddress) {
      return
    }

    const timeoutId = window.setTimeout(() => setCopiedAddress(false), 1800)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [copiedAddress])

  useEffect(() => {
    const provider = window.ethereum

    if (!provider || walletUiReset) {
      return
    }

    const syncWallet = async () => {
      try {
        await syncWalletState(provider)
      } catch (error) {
        const message = error instanceof Error ? error.message : `Unable to sync the ${TENDERLY_NETWORK.name} wallet state.`
        setWalletError(message)
      }
    }

    const handleAccountsChanged = (...args: unknown[]) => {
      void syncWalletState(provider, parseAccounts(args[0])).catch((error) => {
        const message = error instanceof Error ? error.message : `Unable to sync the ${TENDERLY_NETWORK.name} wallet state.`
        setWalletError(message)
      })
    }

    const handleChainChanged = (...args: unknown[]) => {
      const [chainValue] = args
      const nextChainId = parseChainId(chainValue)

      setChainId(nextChainId)
      setWalletError('')

      if (nextChainId !== TENDERLY_NETWORK.chainId) {
        void syncWallet()
      }
    }

    void syncWallet()
    provider.on?.('accountsChanged', handleAccountsChanged)
    provider.on?.('chainChanged', handleChainChanged)

    return () => {
      provider.removeListener?.('accountsChanged', handleAccountsChanged)
      provider.removeListener?.('chainChanged', handleChainChanged)
    }
  }, [walletUiReset])

  const connectWallet = async () => {
    const provider = window.ethereum

    if (!provider) {
      setWalletError('MetaMask is not available in this browser.')
      return
    }

    setIsConnecting(true)
    setWalletError('')
    setWalletUiReset(false)

    try {
      const accounts = parseAccounts(await provider.request({ method: 'eth_requestAccounts' }))

      if (!accounts[0]) {
        setWalletError('No wallet account returned by MetaMask.')
        setWalletAddress('')
        setChainId(null)
        return
      }

      await syncWalletState(provider, accounts)
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unable to connect MetaMask to ${TENDERLY_NETWORK.name}.`
      setWalletError(message)
    } finally {
      setIsConnecting(false)
    }
  }

  const resetWalletUi = () => {
    setWalletAddress('')
    setChainId(null)
    setCopiedAddress(false)
    setWalletError('')
    setWalletUiReset(true)
  }

  const copyWalletAddress = async () => {
    if (!walletAddress) {
      return
    }

    if (!navigator.clipboard?.writeText) {
      setWalletError('Clipboard access is not available in this browser.')
      return
    }

    try {
      await navigator.clipboard.writeText(walletAddress)
      setCopiedAddress(true)
      setWalletError('')
    } catch {
      setWalletError('Unable to copy wallet address.')
    }
  }

  const appendTerminalLines = (lines: string[]) => {
    setTerminalLines((currentLines) => [...currentLines, ...lines].slice(-TERMINAL_HISTORY_LIMIT))
  }

  const buildActivityItem = (
    status: ActivityItem['status'],
    currentMode: Mode,
    value: number,
    code: string,
    actor: string,
    differenceBps: number,
    currentKycMode: KycMode,
    rejectionReason?: 'rate' | 'kyc',
  ): ActivityItem => ({
    id: `${Date.now()}-${code}-${currentMode}-${status}`,
    title: `${status === 'recorded' ? 'Recorded' : 'Rejected'} ${currentMode} ${formatAmount(value)} ${code}`,
    subtitle:
      status === 'recorded'
        ? `StablecoinManager updated for ${shortenAddress(actor)} · Δ ${formatDifference(differenceBps)}`
        : rejectionReason === 'kyc'
          ? `World ID KYC blocked write for ${shortenAddress(actor)} · ${currentKycMode}`
          : `Rate guard blocked write for ${shortenAddress(actor)} · Δ ${formatDifference(differenceBps)}`,
    status,
  })

  const buildSubmissionWorldId = (actor: string, parsedAmount: number): WorldIdPayload | undefined | null => {
    if (!requiresWorldIdKyc(parsedAmount, activeCurrency.rate)) {
      return undefined
    }

    const parsedWorldId = parseWorldIdForm({
      root: worldIdRoot,
      nullifierHash: worldIdNullifierHash,
      proof: worldIdProof,
    })

    if (!parsedWorldId.payload) {
      setOperationError(parsedWorldId.error || 'World ID proof is required for this request.')
      return null
    }

    const validation = validateWorldIdPayload({
      user: actor,
      currencyCode: activeCurrency.code,
      mode,
      amount: parsedAmount,
      oracleRate: activeCurrency.rate,
      kycMode,
      worldId: parsedWorldId.payload,
    })

    if (!validation.valid || !validation.normalized) {
      setOperationError(validation.error || 'World ID proof is invalid for this request.')
      return null
    }

    return validation.normalized
  }

  const applyDemoWorldIdProof = () => {
    const actor = walletAddress || SIMULATION_USER_ADDRESS
    const parsedAmount = Number(amount)

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || !Number.isInteger(parsedAmount)) {
      setOperationError('Enter a positive whole-number amount before generating a demo World ID proof.')
      return
    }

    const payload = createDemoWorldIdPayload({
      user: actor,
      currencyCode: activeCurrency.code,
      mode,
      amount: parsedAmount,
      oracleRate: activeCurrency.rate,
      kycMode,
    })

    setWorldIdRoot(payload.root)
    setWorldIdNullifierHash(payload.nullifierHash)
    setWorldIdProof(payload.proof.join(', '))
    setOperationError('')
  }

  const applySimulationResult = (parsedAmount: number, worldId?: WorldIdPayload) => {
    const result = simulateCreOperation({
      walletAddress,
      mode,
      kycMode,
      currencyCode: activeCurrency.code,
      amount: parsedAmount,
      oracleRate: activeCurrency.rate,
      currentBalance: currentHolding,
      worldId,
    })

    setTerminalMode('simulation')

    if (result.accepted) {
      setHoldings((current) => ({
        ...current,
        [activeCurrency.code]: result.nextBalance,
      }))

      if (mode === 'mint') {
        setSessionMinted((current) => current + parsedAmount)
      } else {
        setSessionBurned((current) => current + parsedAmount)
      }
    }

    setRecentActivity((current) => [result.activity, ...current].slice(0, 6))
    appendTerminalLines(result.terminalLines)
    setOperationError(
      result.accepted
        ? ''
        : result.rejectionReason === 'kyc'
          ? result.rejectionMessage || 'World ID KYC rejected this request.'
          : `Rate difference ${formatDifference(result.differenceBps)} exceeded the < 10% rule, so the operation was rejected.`,
    )
  }

  const handleStablecoinAction = async () => {
    const parsedAmount = Number(amount)
    const actor = walletAddress || SIMULATION_USER_ADDRESS

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setOperationError('Enter a valid positive amount before submitting a CRE stablecoin operation.')
      return
    }

    if (!Number.isInteger(parsedAmount)) {
      setOperationError('Enter a positive whole-number amount before submitting a CRE stablecoin operation.')
      return
    }

    if (mode === 'burn' && parsedAmount > currentHolding) {
      setOperationError(`Burn amount exceeds your current ${activeCurrency.code} holding.`)
      setTerminalLines((currentLines) => [
        ...currentLines,
        `$ local-guard blocked burn ${formatAmount(parsedAmount)} ${activeCurrency.code}`,
        `[balance] Available ${formatAmount(currentHolding)} ${activeCurrency.code} for ${walletAddress || 'demo operator'}`,
      ].slice(-TERMINAL_HISTORY_LIMIT))
      return
    }

    const submissionWorldId = buildSubmissionWorldId(actor, parsedAmount)
    if (submissionWorldId === null) {
      return
    }

    setAmount('')
    setOperationError('')
    setIsRunningOperation(true)
    setTerminalMode('live')
    appendTerminalLines([
      `$ live cre -> ${mode.toUpperCase()} ${formatAmount(parsedAmount)} ${activeCurrency.code} for ${shortenAddress(actor)}`,
      worldIdRequired
        ? `[kyc] Sending ${kycMode} World ID proof for >$${WORLD_ID_KYC_THRESHOLD_USD} request`
        : `[kyc] Request value is within $${WORLD_ID_KYC_THRESHOLD_USD}; World ID proof not required`,
    ])

    try {
      const result = await runLiveCreOperation(
        {
          user: actor,
          mode,
          kycMode,
          currencyCode: activeCurrency.code,
          amount: parsedAmount,
          oracleRate: Math.round(activeCurrency.rate * 1_000_000),
          worldId: submissionWorldId,
        },
        {
          onLine: (line) => {
            setTerminalLines((currentLines) => [...currentLines, line].slice(-TERMINAL_HISTORY_LIMIT))
          },
        },
      )

      if (result.status === 'error') {
        setOperationError(result.errorMessage)
        return
      }

      setHoldings((current) => ({
        ...current,
        [activeCurrency.code]: result.nextBalance,
      }))

      if (result.status === 'recorded') {
        if (mode === 'mint') {
          setSessionMinted((current) => current + parsedAmount)
        } else {
          setSessionBurned((current) => current + parsedAmount)
        }
      }

      const activity = buildActivityItem(
        result.status,
        mode,
        parsedAmount,
        activeCurrency.code,
        actor,
        result.differenceBps,
        kycMode,
        result.status === 'rejected' ? result.rejectionReason : undefined,
      )
      setRecentActivity((current) => [activity, ...current].slice(0, 6))
      setOperationError(
        result.status === 'recorded'
          ? ''
          : result.rejectionReason === 'kyc'
            ? result.rejectionMessage || 'World ID KYC rejected this request.'
            : `Rate difference ${formatDifference(result.differenceBps)} exceeded the < 10% rule, so the operation was rejected.`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to reach the live local CRE bridge.'
      appendTerminalLines([
        '[bridge] Live local CRE bridge unavailable; falling back to browser simulation.',
        `[bridge] ${message}`,
      ])
      applySimulationResult(parsedAmount, submissionWorldId)
    } finally {
      setIsRunningOperation(false)
    }
  }

  return (
    <main className="app-shell">
      <header className="page-header">
        <section className="hero-copy">
          <h1>StableCoins</h1>
          <p>Mint and burn stablecoins using basin on API and Oracle prices for human and AI Agent use cases.</p>

          <div className="hero-kyc" aria-label="KYC mode selector">
            <label htmlFor="kyc-mode">KYC</label>
            <div className="select-wrap hero-kyc-select">
              <select id="kyc-mode" value={kycMode} onChange={(event) => setKycMode(event.target.value as KycMode)}>
                <option value="on-chain">On-chain</option>
                <option value="off-chain">Off-chain</option>
              </select>
              <span className="select-caret">▾</span>
            </div>
          </div>
        </section>

        <div className="page-actions">
          <div className="header-controls">
            <button
              type="button"
              className={walletAddress ? 'wallet-toggle connected' : 'wallet-toggle'}
              onClick={connectWallet}
              disabled={isConnecting}
              aria-label={walletAddress ? `Connected wallet ${walletAddress}` : 'Connect MetaMask wallet'}
              title={walletAddress ? walletAddress : 'Connect MetaMask wallet'}
            >
              <WalletIcon />
              <span>{walletLabel}</span>
              <span className={walletAddress ? 'wallet-pill connected' : 'wallet-pill'}>
                {walletAddress ? 'Connected' : 'MetaMask'}
              </span>
            </button>

            {walletAddress && (
              <div className="wallet-meta">
                <span
                  className={isSupportedNetwork ? 'network-badge' : 'network-badge network-badge-warning'}
                  title={`Network Name: ${TENDERLY_NETWORK.name} | RPC URL: ${TENDERLY_NETWORK.rpcUrl} | Chain ID: ${TENDERLY_NETWORK.chainId} | Currency Symbol: ${TENDERLY_NETWORK.currencySymbol} | Block Explorer: ${TENDERLY_NETWORK.blockExplorer}`}
                >
                  {networkLabel}
                </span>
                <button type="button" className="wallet-action" onClick={copyWalletAddress}>
                  {copiedAddress ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="wallet-action wallet-action-muted"
                  onClick={resetWalletUi}
                  title="Clears the local wallet UI state. To fully disconnect, use MetaMask."
                >
                  Reset
                </button>
              </div>
            )}

            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark'))}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              <ThemeIcon theme={theme} />
              <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
          </div>

          <p className="header-note">{walletNote}</p>
        </div>
      </header>

      <section className="content-grid">
        <div className="panel action-panel">
          <div className="panel-top">
            <div className="title-wrap">
              <div className="icon-wrap">
                <WalletIcon />
              </div>
              <div>
                <h2>Mint Stablecoin</h2>
                <p>CRE compares Exchangerate API and oracle prices before recording mint/burn activity</p>
              </div>
            </div>

            <div className="mode-toggle" role="tablist" aria-label="Mint or burn stablecoin">
              {(['mint', 'burn'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={mode === item ? 'mode-button active' : 'mode-button'}
                  onClick={() => setMode(item)}
                >
                  <DirectionIcon mode={item} />
                  {item === 'mint' ? 'Mint' : 'Burn'}
                </button>
              ))}
            </div>
          </div>

          <div className="field-group">
            <label htmlFor="currency">Currency</label>
            <div className="select-wrap">
              <select id="currency" value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)}>
                {currencies.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} - {currency.name}
                  </option>
                ))}
              </select>
              <span className="select-caret">▾</span>
            </div>
            <span className="field-hint">Oracle: 1 stablecoin ≈ {activeCurrency.rate.toLocaleString()} {activeCurrency.code}</span>
          </div>

          <div className="field-group">
            <label htmlFor="amount">Amount ({activeCurrency.code})</label>
            <input
              id="amount"
              type="text"
              inputMode="decimal"
              placeholder={`Enter amount in ${activeCurrency.code}`}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <span className="field-hint">Whole-number units only. Estimated USD value: ${estimatedUsdValue.toFixed(2)}</span>
          </div>

          <div className={worldIdRequired ? 'kyc-callout kyc-callout-required' : 'kyc-callout'}>
            <strong>{worldIdRequired ? 'World ID required for this request' : 'World ID not required for this request'}</strong>
            <p>
              Requests above ${WORLD_ID_KYC_THRESHOLD_USD} USD equivalent require a World ID proof. Verification is currently set to{' '}
              <span>{kycMode}</span>.
            </p>
          </div>

          {worldIdRequired && (
            <div className="worldid-panel">
              <div className="worldid-panel-header">
                <div>
                  <h3>World ID proof</h3>
                  <p>Enter the demo proof fields below, or generate a bound proof for this wallet, amount, currency, and KYC mode.</p>
                </div>
                <button type="button" className="wallet-action wallet-action-primary" onClick={applyDemoWorldIdProof}>
                  Use demo World ID proof
                </button>
              </div>

              <div className="field-group worldid-field-group">
                <label htmlFor="world-id-root">World ID Root</label>
                <input
                  id="world-id-root"
                  type="text"
                  inputMode="numeric"
                  placeholder="Enter World ID root"
                  value={worldIdRoot}
                  onChange={(event) => setWorldIdRoot(event.target.value)}
                />
              </div>

              <div className="field-group worldid-field-group">
                <label htmlFor="world-id-nullifier">World ID Nullifier Hash</label>
                <input
                  id="world-id-nullifier"
                  type="text"
                  inputMode="numeric"
                  placeholder="Enter World ID nullifier hash"
                  value={worldIdNullifierHash}
                  onChange={(event) => setWorldIdNullifierHash(event.target.value)}
                />
              </div>

              <div className="field-group worldid-field-group">
                <label htmlFor="world-id-proof">World ID Proof</label>
                <input
                  id="world-id-proof"
                  type="text"
                  placeholder="Comma-separated 8-value uint256 proof"
                  value={worldIdProof}
                  onChange={(event) => setWorldIdProof(event.target.value)}
                />
                <span className="field-hint">Proof must contain exactly 8 comma-separated uint256 values.</span>
              </div>
            </div>
          )}

          <div className="cre-summary">
            <div className="cre-summary-row">
              <span className="terminal-status">CRE</span>
              <strong>{CRE_PROJECT_SUMMARY.contractName}</strong>
            </div>
            <ul className="cre-summary-list">
              <li>Workflow: {CRE_PROJECT_SUMMARY.workflowName}</li>
              <li>Forwarder: {CRE_PROJECT_SUMMARY.forwarderAddress}</li>
              <li>Rule: record only when API / oracle Δ is below 10%</li>
              <li>KYC: World ID required above ${WORLD_ID_KYC_THRESHOLD_USD} USD · {kycMode}</li>
              <li>User: {walletAddress ? shortenAddress(walletAddress) : shortenAddress(SIMULATION_USER_ADDRESS)} {walletAddress ? '(connected)' : '(demo simulation)'}</li>
            </ul>
          </div>

          {operationError && <p className="form-error">{operationError}</p>}

          <button type="button" className="primary-button" onClick={() => void handleStablecoinAction()} disabled={isRunningOperation}>
            {isRunningOperation ? 'Running live CRE...' : mode === 'mint' ? 'Mint Stablecoin via CRE' : 'Burn Stablecoin via CRE'}
          </button>
        </div>

        <aside className="panel side-panel">
          <div className="sidebar-section">
            <h2>Your Holdings (on-chain)</h2>
            {holdingEntries.length > 0 ? (
              holdingEntries.map(([code, balance]) => (
                <div className="holding-row" key={code}>
                  <span>{code}</span>
                  <strong>{formatAmount(balance)}</strong>
                </div>
              ))
            ) : (
              <p className="empty-state">No recorded stablecoin holdings yet.</p>
            )}
          </div>

          <div className="sidebar-section activity-section">
            <h3>Recent Activity</h3>
            {recentActivity.length > 0 ? (
              <div className="activity-list">
                {recentActivity.map((item) => (
                  <article className="activity-item" key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.subtitle}</p>
                    </div>
                    <span className={item.status === 'recorded' ? 'activity-badge' : 'activity-badge activity-badge-rejected'}>
                      {item.status === 'recorded' ? 'Recorded' : 'Rejected'}
                    </span>
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-state">No CRE activity yet.</p>
            )}
          </div>
        </aside>
      </section>

      <section className="panel totals-panel">
        <h2>Mint/Burn Totals (Session)</h2>
        <div className="totals-grid">
          <article className="total-card">
            <span>Total Minted (local)</span>
            <strong>{formatAmount(sessionMinted)}</strong>
          </article>
          <article className="total-card">
            <span>Total Burned (local)</span>
            <strong>{formatAmount(sessionBurned)}</strong>
          </article>
        </div>

        <div className="terminal-activity">
          <h3>Terminal Activity</h3>
          <div className="terminal-card terminal-card-stack">
            <span className="terminal-status">{terminalMode === 'live' ? 'CRE LIVE' : 'CRE SIM'}</span>
            <div className="terminal-log">
              {terminalLines.map((line, index) => (
                <p key={`${line}-${index}`}>{line}</p>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}