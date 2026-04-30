// frontend/src/wagmi.ts
import { http } from 'wagmi';
import { sepolia, hardhat } from 'wagmi/chains';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';

const projectId = import.meta.env.VITE_PROJECT_ID;

if (!projectId) {
  throw new Error("Project ID is undefined. Please check your .env file.");
}

export const config = getDefaultConfig({
  appName: 'Batch Auction Thesis',
  projectId: projectId,
  chains: [hardhat, sepolia],
  transports: {
    [hardhat.id]: http('http://127.0.0.1:8545'),
    [sepolia.id]: http(import.meta.env.VITE_SEPOLIA_RPC_URL),
  },
});