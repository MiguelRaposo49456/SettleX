import { http, createConfig } from 'wagmi'
import { sepolia, hardhat } from 'wagmi/chains'

export const config = createConfig({
  chains: [sepolia, hardhat],
  transports: {
    // This allows you to switch between local and testnet without changing code
    [sepolia.id]: http(import.meta.env.VITE_SEPOLIA_RPC_URL),
    [hardhat.id]: http(), 
  },
})