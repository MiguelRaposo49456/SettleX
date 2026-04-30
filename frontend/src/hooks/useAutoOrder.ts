import { useBlockNumber, useWriteContract } from 'wagmi';
import { useState, useEffect } from 'react';
import { keccak256, encodePacked } from 'viem';
import FungibleOrderbookABI from '../abis/FungibleOrderbook.json';

export function useAutoOrder() {
  const { data: blockNumber } = useBlockNumber();
  const { writeContractAsync } = useWriteContract();
  const [pendingReveal, setPendingReveal] = useState<any>(null);

  // Watch for block changes to trigger reveal
  useEffect(() => {
    if (pendingReveal && blockNumber && BigInt(blockNumber) > BigInt(pendingReveal.commitBlock)) {
      handleReveal();
    }
  }, [blockNumber]);

  const placeOrder = async (params: any) => {
    const salt = keccak256(encodePacked(['string'], [Math.random().toString()]));
    const commitHash = keccak256(encodePacked(
      ['address', 'address', 'address', 'uint256', 'uint256', 'uint8', 'bool', 'bytes32'],
      [params.client, params.tokenIn, params.tokenOut, params.amountIn, params.amountOut, params.side, params.partial, salt]
    ));

    // Phase 1: Commit
    await writeContractAsync({
      address: import.meta.env.VITE_FUNGIBLE_ORDERBOOK_ADDRESS,
      abi: FungibleOrderbookABI.abi,
      functionName: 'commit',
      args: [commitHash, 0],
    });

    setPendingReveal({ ...params, salt, commitBlock: blockNumber });
  };

  const handleReveal = async () => {
    // Phase 2: Reveal
    await writeContractAsync({
      address: import.meta.env.VITE_FUNGIBLE_ORDERBOOK_ADDRESS,
      abi: FungibleOrderbookABI.abi,
      functionName: 'revealOrder',
      args: [
        pendingReveal.commitId,
        pendingReveal.tokenIn,
        pendingReveal.tokenOut,
        pendingReveal.amountIn,
        pendingReveal.amountOut,
        pendingReveal.side,
        pendingReveal.partial,
        pendingReveal.salt
      ],
    });
    setPendingReveal(null);
  };

  return { placeOrder, isWaiting: !!pendingReveal };
}