import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getTenderlyChainId, getTenderlyExplorerUrl, getTenderlyRpcUrl, getTenderlyUsdcAddress } from './config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function loadViem() {
  const viemUrl = pathToFileURL(resolve(__dirname, '../stablecoin/my-workflow/node_modules/viem/_esm/index.js')).href
  const accountsUrl = pathToFileURL(resolve(__dirname, '../stablecoin/my-workflow/node_modules/viem/_esm/accounts/index.js')).href
  const [viem, accounts] = await Promise.all([import(viemUrl), import(accountsUrl)])
  return { ...viem, ...accounts }
}

export async function submitTenderlyUsdcPayment(env, { recipient, requiredUnits, emit }) {
  const privateKey = String(env.STABLES_TENDERLY_PRIVATE_KEY || env.TENDERLY_PRIVATE_KEY || '').trim()
  if (!privateKey) throw new Error('Tenderly private key is not configured. Set STABLES_TENDERLY_PRIVATE_KEY in your environment.')

  const { createPublicClient, createWalletClient, http, privateKeyToAccount, parseAbi } = await loadViem()
  const rpcUrl = getTenderlyRpcUrl(env)
  const chain = {
    id: getTenderlyChainId(env),
    name: 'Tenderly Eth Mainnet',
    network: 'tenderly-eth-mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }
  const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`)
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const abi = parseAbi(['function transfer(address to, uint256 value) returns (bool)'])

  emit?.(`[agent] Tenderly submit -> transfer ${Number(requiredUnits) / 1_000_000} USDC from ${account.address}`)
  const hash = await walletClient.writeContract({
    address: getTenderlyUsdcAddress(env),
    abi,
    functionName: 'transfer',
    args: [recipient, requiredUnits],
    account,
    chain,
  })

  await publicClient.waitForTransactionReceipt({ hash })
  const explorer = getTenderlyExplorerUrl(env)
  emit?.(`[agent] Tenderly receipt -> ${explorer}/${hash}`)
  return hash
}