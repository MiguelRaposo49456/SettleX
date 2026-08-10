import { decodeEventLog, formatEther } from 'viem';
import { COMPLIANCE_MANAGER_CONTRACT, CUSTODIAN_CONTRACT, FUNGIBLE_ORDERBOOK_CONTRACT, LENDING_POOL_CONTRACT, NFT_ORDERBOOK_CONTRACT, SETTLEMENT_ENGINE_CONTRACT } from '../constants/contracts';
import ComplianceManagerABI from '../abis/ComplianceManager.json';
import CustodianABI from '../abis/Custodian.json';
import FungibleOrderbookABI from '../abis/FungibleOrderbook.json';
import MockLendingPoolABI from '../abis/MockLendingPool.json';
import NFTOrderbookABI from '../abis/NFTOrderbook.json';
import SettlementEngineABI from '../abis/SettlementEngine.json';

export type ActivityLogSource =
  | 'Compliance Manager'
  | 'Custodian'
  | 'Lending Pool'
  | 'Fungible Orderbook'
  | 'NFT Orderbook'
  | 'Settlement Engine';

export type ActivityLogEntry = {
  id: string;
  source: ActivityLogSource;
  eventName: string;
  summary: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  blockTimestamp?: bigint;
  logIndex: number;
  txHash?: `0x${string}`;
};

const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CHUNK_SIZE = 49_000n;

function shortAddress(address?: string) {
  if (!address) return '-';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatAmount(amount?: bigint) {
  if (amount === undefined) return '-';
  return amount.toString();
}

function formatEthAmount(amount?: bigint) {
  if (amount === undefined) return '-';
  return formatEther(amount);
}

function getActivitySummary(source: ActivityLogSource, eventName: string, args: Record<string, unknown>) {
  switch (source) {
    case 'Compliance Manager':
      switch (eventName) {
        case 'Paused':
          return 'System paused';
        case 'Unpaused':
          return 'System unpaused';
        case 'TokenBlacklisted':
          return `Token blacklisted ${shortAddress(args.token as string | undefined)}`;
        case 'TokenUnblacklisted':
          return `Token restored ${shortAddress(args.token as string | undefined)}`;
        case 'UserStatusUpdated':
          return `User ${shortAddress(args.user as string | undefined)} status updated`;
        case 'RoleGranted':
          return `Role granted to ${shortAddress(args.account as string | undefined)}`;
        case 'RoleRevoked':
          return `Role revoked from ${shortAddress(args.account as string | undefined)}`;
        default:
          return eventName;
      }
    case 'Custodian':
      switch (eventName) {
        case 'Deposited':
          return `${shortAddress(args.client as string | undefined)} deposited ${
            (args.token as string | undefined)?.toLowerCase() === ETH_SENTINEL.toLowerCase()
              ? `${formatEthAmount(args.amount as bigint | undefined)} ETH`
              : `${formatAmount(args.amount as bigint | undefined)} units`
          } into the vault`;
        case 'Withdrawn':
          return `${shortAddress(args.client as string | undefined)} withdrew ${
            (args.token as string | undefined)?.toLowerCase() === ETH_SENTINEL.toLowerCase()
              ? `${formatEthAmount(args.amount as bigint | undefined)} ETH`
              : `${formatAmount(args.amount as bigint | undefined)} units`
          }`;
        case 'FundsLocked':
          return `${shortAddress(args.client as string | undefined)} locked ${formatAmount(args.amount as bigint | undefined)} units`;
        case 'FundsUnlocked':
          return `${shortAddress(args.client as string | undefined)} unlocked ${formatAmount(args.amount as bigint | undefined)} units`;
        case 'NFTDeposited':
          return `${shortAddress(args.client as string | undefined)} deposited NFT ${formatAmount(args.tokenId as bigint | undefined)}`;
        case 'NFTWithdrawn':
          return `${shortAddress(args.client as string | undefined)} withdrew NFT ${formatAmount(args.tokenId as bigint | undefined)}`;
        case 'NFTLocked':
          return `NFT ${formatAmount(args.tokenId as bigint | undefined)} locked for ${shortAddress(args.client as string | undefined)}`;
        case 'NFTUnlocked':
          return `NFT ${formatAmount(args.tokenId as bigint | undefined)} unlocked for ${shortAddress(args.client as string | undefined)}`;
        case 'InternalTransfer':
          return `${shortAddress(args.from as string | undefined)} -> ${shortAddress(args.to as string | undefined)} internal transfer`;
        case 'NFTInternalTransfer':
          return `${shortAddress(args.from as string | undefined)} -> ${shortAddress(args.to as string | undefined)} NFT transfer ${formatAmount(args.tokenId as bigint | undefined)}`;
        case 'WithdrawalQueued':
          return `${shortAddress(args.client as string | undefined)} queued withdrawal ${formatAmount(args.amount as bigint | undefined)}${Boolean(args.receiveETH) ? ' as ETH' : ''}`;
        case 'WithdrawalProcessed':
          return `${shortAddress(args.client as string | undefined)} processed withdrawal ${formatAmount(args.amount as bigint | undefined)}${Boolean(args.receiveETH) ? ' as ETH' : ''}`;
        case 'Initialized':
          return 'Custodian initialized';
        default:
          return eventName;
      }
    case 'Lending Pool':
      switch (eventName) {
        case 'PoolAdded':
          return `Pool added for ${shortAddress(args.token as string | undefined)}`;
        case 'Supplied':
          return `${shortAddress(args.user as string | undefined)} supplied ${formatAmount(args.amount as bigint | undefined)} units`;
        case 'Withdrawn':
          return `${shortAddress(args.user as string | undefined)} withdrew ${formatAmount(args.amount as bigint | undefined)} units`;
        case 'YieldSimulated':
          return `Yield simulated for ${shortAddress(args.token as string | undefined)}`;
        default:
          return eventName;
      }
    case 'Fungible Orderbook':
      switch (eventName) {
        case 'OrderPlaced':
          return `Order ${formatAmount(args.orderId as bigint | undefined)} placed by ${shortAddress(args.client as string | undefined)}`;
        case 'OrderCancelled':
          return `Order ${formatAmount(args.orderId as bigint | undefined)} cancelled`;
        case 'OrderMatched':
          return `Orders ${formatAmount(args.makerOrderId as bigint | undefined)} and ${formatAmount(args.takerOrderId as bigint | undefined)} matched`;
        case 'OrderPartiallyFilled':
          return `Order ${formatAmount(args.orderId as bigint | undefined)} partially filled`;
        case 'Committed':
          return `Commit ${formatAmount(args.commitId as bigint | undefined)} submitted`;
        case 'CommitExpired':
          return `Commit ${formatAmount(args.commitId as bigint | undefined)} expired`;
        case 'MakerBlacklisted':
          return `Maker ${shortAddress(args.maker as string | undefined)} blacklisted`;
        case 'TokenBlacklisted':
          return 'Trading token blacklisted';
        case 'OrderReinstated':
          return `Order ${formatAmount(args.orderId as bigint | undefined)} reinstated`;
        default:
          return eventName;
      }
    case 'NFT Orderbook':
      switch (eventName) {
        case 'NFTListed':
          return `Listing ${formatAmount(args.listingId as bigint | undefined)} created by ${shortAddress(args.seller as string | undefined)}`;
        case 'NFTOfferMade':
          return `Offer ${formatAmount(args.offerId as bigint | undefined)} created by ${shortAddress(args.buyer as string | undefined)}`;
        case 'NFTListingCancelled':
          return `Listing ${formatAmount(args.listingId as bigint | undefined)} cancelled`;
        case 'NFTOfferCancelled':
          return `Offer ${formatAmount(args.offerId as bigint | undefined)} cancelled`;
        case 'NFTTradeMatched':
          return `NFT trade matched for listing ${formatAmount(args.listingId as bigint | undefined)}`;
        case 'Committed':
          return `Commit ${formatAmount(args.commitId as bigint | undefined)} submitted`;
        case 'CommitExpired':
          return `Commit ${formatAmount(args.commitId as bigint | undefined)} expired`;
        default:
          return eventName;
      }
    case 'Settlement Engine':
      switch (eventName) {
        case 'TradeExecuted':
          return `Trade executed for orders ${formatAmount(args.makerOrderId as bigint | undefined)} / ${formatAmount(args.takerOrderId as bigint | undefined)}`;
        case 'TradeQueued':
          return `Trade queued in batch ${formatAmount(args.batchId as bigint | undefined)}`;
        case 'NFTTradeQueued':
          return `NFT trade queued in batch ${formatAmount(args.batchId as bigint | undefined)}`;
        case 'BatchSettled':
          return `Batch ${formatAmount(args.batchId as bigint | undefined)} settled`;
        case 'BatchOpened':
          return `Batch ${formatAmount(args.batchId as bigint | undefined)} opened`;
        case 'TradeFailed':
          return `Trade failed in batch ${formatAmount(args.batchId as bigint | undefined)}`;
        case 'NFTTradeFailed':
          return `NFT trade failed in batch ${formatAmount(args.batchId as bigint | undefined)}`;
        case 'TokenBlacklisted':
          return 'Settlement blocked by blacklisted token';
        case 'UserBlacklisted':
          return `User ${shortAddress(args.user as string | undefined)} blacklisted during settlement`;
        case 'OrderInactive':
          return `Order ${formatAmount(args.orderId as bigint | undefined)} inactive`;
        case 'BothOrdersInactive':
          return `Orders ${formatAmount(args.makerOrderId as bigint | undefined)} / ${formatAmount(args.takerOrderId as bigint | undefined)} inactive`;
        case 'SettlementWindowUpdated':
          return `Settlement window updated to ${formatAmount(args.newWindow as bigint | undefined)} seconds`;
        case 'MaxBatchSizeUpdated':
          return `Batch size updated to ${formatAmount(args.newSize as bigint | undefined)}`;
        case 'NFTTradeExecuted':
          return `NFT trade executed for listing ${formatAmount(args.listingId as bigint | undefined)}`;
        default:
          return eventName;
      }
    default:
      return eventName;
  }
}

export async function loadComplianceActivityLogs(publicClient: any) {
  const latestBlock = await publicClient.getBlockNumber();
  const fromBlock = latestBlock > CHUNK_SIZE ? latestBlock - CHUNK_SIZE : 0n;

  const [complianceLogs, custodianLogs, lendingLogs, fungibleLogs, nftLogs, settlementLogs] = await Promise.all([
    publicClient.getLogs({ address: COMPLIANCE_MANAGER_CONTRACT.address, fromBlock, toBlock: latestBlock }),
    publicClient.getLogs({ address: CUSTODIAN_CONTRACT.address, fromBlock, toBlock: latestBlock }),
    publicClient.getLogs({ address: LENDING_POOL_CONTRACT.address, fromBlock, toBlock: latestBlock }),
    publicClient.getLogs({ address: FUNGIBLE_ORDERBOOK_CONTRACT.address, fromBlock, toBlock: latestBlock }),
    publicClient.getLogs({ address: NFT_ORDERBOOK_CONTRACT.address, fromBlock, toBlock: latestBlock }),
    publicClient.getLogs({ address: SETTLEMENT_ENGINE_CONTRACT.address, fromBlock, toBlock: latestBlock }),
  ]);

  const sources = [
    { source: 'Compliance Manager' as const, logs: complianceLogs, abi: ComplianceManagerABI.abi },
    { source: 'Custodian' as const, logs: custodianLogs, abi: CustodianABI.abi },
    { source: 'Lending Pool' as const, logs: lendingLogs, abi: MockLendingPoolABI.abi },
    { source: 'Fungible Orderbook' as const, logs: fungibleLogs, abi: FungibleOrderbookABI.abi },
    { source: 'NFT Orderbook' as const, logs: nftLogs, abi: NFTOrderbookABI.abi },
    { source: 'Settlement Engine' as const, logs: settlementLogs, abi: SettlementEngineABI.abi },
  ];

  const nextLogs: ActivityLogEntry[] = [];

  for (const { source, logs, abi } of sources) {
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi,
          data: log.data,
          topics: log.topics,
        });

        const args = (decoded.args ?? {}) as Record<string, unknown>;
        nextLogs.push({
          id: `${log.transactionHash ?? '0x0'}-${log.logIndex?.toString() ?? '0'}`,
          source,
          eventName: String(decoded.eventName),
          summary: getActivitySummary(source, String(decoded.eventName), args),
          args,
          blockNumber: log.blockNumber ?? 0n,
          logIndex: Number(log.logIndex ?? 0n),
          txHash: log.transactionHash,
        });
      } catch {
        continue;
      }
    }
  }

  nextLogs.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) return Number(right.blockNumber - left.blockNumber);
    return right.logIndex - left.logIndex;
  });

  const recentLogs = nextLogs.slice(0, 250);
  const uniqueBlockNumbers = [...new Set(recentLogs.map((entry) => entry.blockNumber.toString()))];
  const blockTimestamps = new Map<string, bigint>();

  await Promise.all(
    uniqueBlockNumbers.map(async (blockNumber) => {
      try {
        const block = await publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
        blockTimestamps.set(blockNumber, block.timestamp);
      } catch {
        blockTimestamps.set(blockNumber, 0n);
      }
    }),
  );

  return recentLogs.map((entry) => ({
    ...entry,
    blockTimestamp: blockTimestamps.get(entry.blockNumber.toString()),
  }));
}
