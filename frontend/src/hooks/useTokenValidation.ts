import type { PublicClient } from 'viem';

const ERC20_READ_ABI = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

export type TokenMetadata = {
  address: `0x${string}`;
  name: string;
  symbol: string;
  decimals: number;
};

export async function validateTokenOnchain(publicClient: PublicClient | undefined, address: `0x${string}`): Promise<TokenMetadata> {
  if (!publicClient) throw new Error('Public client not available');
  try {
    const name = (await publicClient.readContract({ address, abi: ERC20_READ_ABI as any, functionName: 'name' })) as string;
    const symbol = (await publicClient.readContract({ address, abi: ERC20_READ_ABI as any, functionName: 'symbol' })) as string;
    const decimals = (await publicClient.readContract({ address, abi: ERC20_READ_ABI as any, functionName: 'decimals' })) as number;
    return { address, name, symbol, decimals };
  } catch (err) {
    throw new Error('Token validation failed: not a valid ERC20 or call reverted');
  }
}

export default validateTokenOnchain;
