import type { PublicClient } from 'viem';

const ERC721_READ_ABI = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    name: 'supportsInterface',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ type: 'bool' }],
  },
];

export type NFTCollectionMetadata = {
  address: `0x${string}`;
  name: string;
  symbol: string;
};

export async function validateNftCollectionOnchain(
  publicClient: PublicClient | undefined,
  address: `0x${string}`,
): Promise<NFTCollectionMetadata> {
  if (!publicClient) throw new Error('Public client not available');

  try {
    const name = (await publicClient.readContract({ address, abi: ERC721_READ_ABI as any, functionName: 'name' })) as string;
    const symbol = (await publicClient.readContract({ address, abi: ERC721_READ_ABI as any, functionName: 'symbol' })) as string;

    let supportsErc721 = true;
    try {
      supportsErc721 = (await publicClient.readContract({
        address,
        abi: ERC721_READ_ABI as any,
        functionName: 'supportsInterface',
        args: ['0x80ac58cd'],
      })) as boolean;
    } catch {
      // Some collections do not expose ERC165 cleanly; name/symbol are enough for a pragmatic validation.
    }

    if (!supportsErc721) {
      throw new Error('NFT validation failed: contract does not support ERC721');
    }

    return { address, name, symbol };
  } catch {
    throw new Error('NFT validation failed: not a valid ERC721 collection or call reverted');
  }
}

export default validateNftCollectionOnchain;