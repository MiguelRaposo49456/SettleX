import { useState, useEffect } from 'react';
import { useBlockNumber, useWriteContract, useAccount, usePublicClient } from 'wagmi';
import { keccak256, encodePacked, decodeEventLog } from 'viem';
import NFTOrderbookABI from '../abis/NFTOrderbook.json';

const NFT_ORDERBOOK_ADDR = import.meta.env.VITE_NFT_ORDERBOOK_ADDRESS as `0x${string}`;

export function useNFTMarket() {
  const { address } = useAccount();
  const { data: blockNumber } = useBlockNumber();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  
  const [pendingNFTAction, setPendingNFTAction] = useState<any>(null);
  const [status, setStatus] = useState<'idle' | 'committing' | 'waiting' | 'revealing'>('idle');

  useEffect(() => {
    if (pendingNFTAction && blockNumber && BigInt(blockNumber) > BigInt(pendingNFTAction.commitBlock)) {
      autoReveal();
    }
  }, [blockNumber]);

  const autoReveal = async () => {
    if (!pendingNFTAction || !address) return;
    setStatus('revealing');
    try {
      const isList = pendingNFTAction.type === 'list';
      
      await writeContractAsync({
        address: NFT_ORDERBOOK_ADDR,
        abi: NFTOrderbookABI.abi,
        functionName: isList ? 'revealNFTList' : 'revealNFTOffer',
        args: [
          pendingNFTAction.commitId,
          pendingNFTAction.collection,
          pendingNFTAction.tokenId,
          pendingNFTAction.assetType,
          pendingNFTAction.paymentToken,
          pendingNFTAction.paymentAmount,
          pendingNFTAction.paymentTokenId,
          pendingNFTAction.salt
        ],
      });
      setPendingNFTAction(null);
      setStatus('idle');
    } catch (e) {
      console.error("NFT Reveal failed:", e);
      setStatus('idle');
    }
  };

  const createNFTAction = async (type: 'list' | 'offer', params: any) => {
    if (!address) return;
    setStatus('committing');
    
    const salt = keccak256(encodePacked(['string'], [Math.random().toString()]));
    const commitType = type === 'list' ? 0 : 1; // 0: NFTList, 1: NFTOffer

    const commitHash = keccak256(encodePacked(
      ['address', 'address', 'uint256', 'uint8', 'address', 'uint256', 'uint256', 'bytes32'],
      [address, params.collection, params.tokenId, params.assetType, params.paymentToken, params.paymentAmount, params.paymentTokenId, salt]
    ));

    try {
      const hash = await writeContractAsync({
        address: NFT_ORDERBOOK_ADDR,
        abi: NFTOrderbookABI.abi,
        functionName: 'commit',
        args: [commitHash, commitType],
      });

      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const log = receipt.logs.find((l) => l.address.toLowerCase() === NFT_ORDERBOOK_ADDR.toLowerCase());
        if (!log) throw new Error("Event log not found");

        const event = decodeEventLog({
          abi: NFTOrderbookABI.abi,
          eventName: 'Committed',
          data: log.data,
          topics: log.topics,
        });

        const commitId = (event.args as any).commitId;

        setPendingNFTAction({
          ...params,
          type,
          commitId,
          salt,
          commitBlock: blockNumber
        });
        setStatus('waiting');
      }
    } catch (e) {
      console.error("NFT Commit failed:", e);
      setStatus('idle');
    }
  };

  return { createNFTAction, status, currentBlock: blockNumber };
}