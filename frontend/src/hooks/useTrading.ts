import { useState, useEffect } from 'react';
import { useBlockNumber, useWriteContract, useAccount, usePublicClient } from 'wagmi';
import { keccak256, encodePacked, parseUnits, decodeEventLog } from 'viem';
import FungibleOrderbookABI from '../abis/FungibleOrderbook.json';
import ERC20ABI from '../abis/MockERC20.json';

const ORDERBOOK_ADDR = import.meta.env.VITE_FUNGIBLE_ORDERBOOK_ADDRESS as `0x${string}`;
const CUSTODIAN_ADDR = import.meta.env.VITE_CUSTODIAN_ADDRESS as `0x${string}`;

export function useTrading() {
  const { address } = useAccount();
  const { data: blockNumber } = useBlockNumber();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  
  const [pendingOrder, setPendingOrder] = useState<any>(null);
  const [status, setStatus] = useState<'idle' | 'approving' | 'committing' | 'waiting' | 'revealing'>('idle');
  const [orders, setOrders] = useState<any[]>([]);

  useEffect(() => {
    if (pendingOrder && blockNumber && BigInt(blockNumber) > BigInt(pendingOrder.commitBlock)) {
      autoReveal();
    }
  }, [blockNumber]);

  const autoReveal = async () => {
    if (!pendingOrder || !address) return;
    setStatus('revealing');
    try {
      if (pendingOrder.type === 'order') {
        await writeContractAsync({
          address: ORDERBOOK_ADDR,
          abi: FungibleOrderbookABI.abi,
          functionName: 'revealOrder',
          args: [
            pendingOrder.commitId,
            pendingOrder.tokenIn,
            pendingOrder.tokenOut,
            pendingOrder.amountIn,
            pendingOrder.amountOut,
            pendingOrder.side,
            pendingOrder.partial,
            pendingOrder.salt
          ],
        });
      } else if (pendingOrder.type === 'take') {
        await writeContractAsync({
          address: ORDERBOOK_ADDR,
          abi: FungibleOrderbookABI.abi,
          functionName: 'revealTake',
          args: [
            pendingOrder.commitId,
            pendingOrder.makerOrderId,
            pendingOrder.takerAmount,
            pendingOrder.salt
          ],
        });
      }
      setPendingOrder(null);
      setStatus('idle');
    } catch (e) {
      console.error("Reveal failed:", e);
      setStatus('idle');
    }
  };

  const createOrder = async (
    tokenIn: { address: string, decimals: number }, 
    tokenOut: { address: string, decimals: number }, 
    amountIn: string, 
    amountOut: string, 
    side: number,
    partialAllowed: boolean = true
  ) => {
    if (!address || !publicClient) return;

    try {
      const parsedAmountIn = parseUnits(amountIn, tokenIn.decimals);
      const parsedAmountOut = parseUnits(amountOut, tokenOut.decimals);

      // 1. ERC20 Approval Step (Only if not native ETH)
      if (tokenOut.address.toLowerCase() !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
        setStatus('approving');
        await writeContractAsync({
          address: tokenOut.address as `0x${string}`,
          abi: ERC20ABI.abi,
          functionName: 'approve',
          args: [CUSTODIAN_ADDR, parsedAmountOut],
        });
      }

      setStatus('committing');
      const salt = keccak256(encodePacked(['string'], [Math.random().toString()]));
      const partial = partialAllowed;

      const commitHash = keccak256(encodePacked(
        ['address', 'address', 'address', 'uint256', 'uint256', 'uint8', 'bool', 'bytes32'],
        [address, tokenIn.address as `0x${string}`, tokenOut.address as `0x${string}`, parsedAmountIn, parsedAmountOut, side, partial, salt]
      ));

      const hash = await writeContractAsync({
        address: ORDERBOOK_ADDR,
        abi: FungibleOrderbookABI.abi,
        functionName: 'commit',
        args: [commitHash, 0],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const log = receipt.logs.find((l) => l.address.toLowerCase() === ORDERBOOK_ADDR.toLowerCase());
      const event = decodeEventLog({
        abi: FungibleOrderbookABI.abi,
        eventName: 'Committed',
        data: log!.data,
        topics: log!.topics,
      });

      setPendingOrder({
        type: 'order',
        commitId: (event.args as any).commitId,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: parsedAmountIn,
        amountOut: parsedAmountOut,
        side,
        partial,
        salt,
        commitBlock: blockNumber
      });
      setStatus('waiting');
    } catch (e) {
      console.error("Order flow failed:", e);
      setStatus('idle');
    }
  };

  // Create a taker commit + auto reveal flow to take a maker order
  const createTake = async (
    makerOrderId: bigint,
    takerAmountRaw: string
  ) => {
    if (!address || !publicClient) return;

    try {
      setStatus('committing');
      const takerAmount = BigInt(takerAmountRaw);
      const salt = keccak256(encodePacked(['string'], [Math.random().toString()]));

      // compute take hash: (address, makerOrderId, takerAmount, salt)
      const commitHash = keccak256(encodePacked(
        ['address', 'uint256', 'uint256', 'bytes32'],
        [address, makerOrderId, takerAmount, salt]
      ));

      const hash = await writeContractAsync({
        address: ORDERBOOK_ADDR,
        abi: FungibleOrderbookABI.abi,
        functionName: 'commit',
        args: [commitHash, 1],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const log = receipt.logs.find((l) => l.address.toLowerCase() === ORDERBOOK_ADDR.toLowerCase());
      const event = decodeEventLog({ abi: FungibleOrderbookABI.abi, eventName: 'Committed', data: log!.data, topics: log!.topics });

      setPendingOrder({
        type: 'take',
        commitId: (event.args as any).commitId,
        makerOrderId,
        takerAmount,
        salt,
        commitBlock: blockNumber
      });
      setStatus('waiting');
    } catch (e) {
      console.error('Take flow failed:', e);
      setStatus('idle');
    }
  };

  // Fetch recent OrderPlaced events and decode into a lightweight list
  const fetchRecentOrders = async () => {
    if (!publicClient) return;
    try {
      const logs = await publicClient.getLogs({ address: ORDERBOOK_ADDR });
      const decoded: any[] = [];
      for (const l of logs) {
        try {
          const ev = decodeEventLog({ abi: FungibleOrderbookABI.abi, data: l.data, topics: l.topics, eventName: 'OrderPlaced' as any });
          decoded.push(ev.args);
        } catch (e) {
          // ignore non-matching logs
        }
      }
      setOrders(decoded.slice(-50).reverse());
    } catch (e) {
      console.error('fetchRecentOrders failed', e);
    }
  };

  return { createOrder, createTake, fetchRecentOrders, orders, status, currentBlock: blockNumber };
}