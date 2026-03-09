export function isTestnetChain(chainSelectorName) {
  const value = String(chainSelectorName || '').toLowerCase()
  return value.includes('testnet') || value.includes('sepolia') || value.includes('goerli')
}