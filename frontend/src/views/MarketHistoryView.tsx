import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { type ActivityLogEntry, loadComplianceActivityLogs } from '../utils/complianceActivityLog';

type AudienceMode = 'client' | 'regulator';

type MarketHistoryViewProps = {
  isRegulatorAllowed: boolean;
};

type OrderContext = {
  tokenIn?: string;
  tokenOut?: string;
  client?: string;
  amount?: string;
  price?: string;
  side?: string;
  partialAllowed?: boolean;
};

type ListingContext = {
  collection?: string;
  tokenId?: string;
  seller?: string;
  buyer?: string;
};

type MarketHistoryRow = {
  id: string;
  timeLabel: string;
  eventLabel: string;
  marketLabel: string;
  amountLabel: string;
  detailLabel: string;
  actorLabel: string;
  sourceLabel: string;
  referenceLabel: string;
  blockLabel: string;
  txLabel: string;
};

function shortAddress(value?: string) {
  if (!value) return '—';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function shortHash(value?: string) {
  if (!value) return '—';
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function getStringArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function getBigIntArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value);
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function getBooleanArg(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function formatBigInt(value?: bigint) {
  if (value === undefined) return '—';
  return value.toString();
}

function formatTimestamp(value?: bigint) {
  if (!value) return '—';
  return new Date(Number(value) * 1000).toLocaleString();
}

function describeSide(side?: string) {
  if (side === '0') return 'Buy';
  if (side === '1') return 'Sell';
  return side ? `Side ${side}` : '—';
}

function buildOrderIndex(activityLogs: ActivityLogEntry[]) {
  const orderIndex = new Map<string, OrderContext>();

  for (const entry of activityLogs) {
    if (entry.source !== 'Fungible Orderbook' || entry.eventName !== 'OrderPlaced') continue;

    const orderId = getBigIntArg(entry.args, 'orderId');
    if (orderId === undefined) continue;

    orderIndex.set(orderId.toString(), {
      tokenIn: getStringArg(entry.args, 'tokenIn'),
      tokenOut: getStringArg(entry.args, 'tokenOut'),
      client: getStringArg(entry.args, 'client'),
      amount: getBigIntArg(entry.args, 'amount')?.toString(),
      price: getBigIntArg(entry.args, 'price')?.toString(),
      side: getBigIntArg(entry.args, 'side')?.toString(),
      partialAllowed: getBooleanArg(entry.args, 'partialAllowed'),
    });
  }

  return orderIndex;
}

function buildListingIndex(activityLogs: ActivityLogEntry[]) {
  const listingIndex = new Map<string, ListingContext>();

  for (const entry of activityLogs) {
    if (entry.source !== 'NFT Orderbook' || entry.eventName !== 'NFTListed') continue;

    const listingId = getBigIntArg(entry.args, 'listingId');
    if (listingId === undefined) continue;

    listingIndex.set(listingId.toString(), {
      collection: getStringArg(entry.args, 'collection'),
      tokenId: getBigIntArg(entry.args, 'tokenId')?.toString(),
      seller: getStringArg(entry.args, 'seller'),
    });
  }

  return listingIndex;
}

function resolveOrderContext(
  orderIndex: Map<string, OrderContext>,
  orderId?: bigint,
) {
  if (orderId === undefined) {
    return undefined;
  }

  return orderIndex.get(orderId.toString());
}

function resolveListingContext(
  listingIndex: Map<string, ListingContext>,
  listingId?: bigint,
) {
  if (listingId === undefined) {
    return undefined;
  }

  return listingIndex.get(listingId.toString());
}

function buildMarketHistoryRow(
  entry: ActivityLogEntry,
  orderIndex: Map<string, OrderContext>,
  listingIndex: Map<string, ListingContext>,
): MarketHistoryRow {
  const blockLabel = entry.blockNumber.toString();
  const txLabel = shortHash(entry.txHash);
  const timeLabel = formatTimestamp(entry.blockTimestamp);

  let marketLabel = '—';
  let amountLabel = '—';
  let detailLabel = entry.summary;
  let actorLabel = '—';
  let referenceLabel = '—';

  switch (entry.source) {
    case 'Fungible Orderbook': {
      const orderId = getBigIntArg(entry.args, 'orderId');
      const orderContext = resolveOrderContext(orderIndex, orderId);
      const makerOrderId = getBigIntArg(entry.args, 'makerOrderId');
      const takerOrderId = getBigIntArg(entry.args, 'takerOrderId');
      const makerContext = resolveOrderContext(orderIndex, makerOrderId);
      const takerContext = resolveOrderContext(orderIndex, takerOrderId);

      if (entry.eventName === 'OrderPlaced' && orderContext) {
        marketLabel = `${shortAddress(orderContext.tokenIn)} → ${shortAddress(orderContext.tokenOut)}`;
        amountLabel = `${orderContext.amount ?? '—'}${orderContext.price ? ` @ ${orderContext.price}` : ''}`;
        actorLabel = shortAddress(orderContext.client);
        referenceLabel = `Order #${formatBigInt(orderId)}`;
        detailLabel = `Side: ${describeSide(orderContext.side)} • Partial ${orderContext.partialAllowed ? 'yes' : 'no'}`;
      } else if (entry.eventName === 'OrderMatched') {
        const pairContext = makerContext ?? takerContext;
        marketLabel = pairContext ? `${shortAddress(pairContext.tokenIn)} → ${shortAddress(pairContext.tokenOut)}` : `Order #${formatBigInt(makerOrderId)} / #${formatBigInt(takerOrderId)}`;
        referenceLabel = `Match #${formatBigInt(makerOrderId)} / #${formatBigInt(takerOrderId)}`;
        detailLabel = 'Matched maker and taker orders';
      } else if (entry.eventName === 'OrderPartiallyFilled') {
        marketLabel = orderContext ? `${shortAddress(orderContext.tokenIn)} → ${shortAddress(orderContext.tokenOut)}` : `Order #${formatBigInt(orderId)}`;
        amountLabel = formatBigInt(getBigIntArg(entry.args, 'matchedAmount'));
        referenceLabel = `Order #${formatBigInt(orderId)}`;
        detailLabel = 'Partial fill';
      } else if (entry.eventName === 'OrderCancelled' || entry.eventName === 'OrderReinstated') {
        marketLabel = orderContext ? `${shortAddress(orderContext.tokenIn)} → ${shortAddress(orderContext.tokenOut)}` : `Order #${formatBigInt(orderId)}`;
        actorLabel = shortAddress(orderContext?.client);
        referenceLabel = `Order #${formatBigInt(orderId)}`;
      } else if (entry.eventName === 'Committed' || entry.eventName === 'CommitExpired') {
        actorLabel = shortAddress(getStringArg(entry.args, 'client'));
        referenceLabel = `Commit #${formatBigInt(getBigIntArg(entry.args, 'commitId'))}`;
      } else if (entry.eventName === 'MakerBlacklisted') {
        actorLabel = shortAddress(getStringArg(entry.args, 'maker'));
        referenceLabel = `Order #${formatBigInt(orderId)}`;
      } else if (entry.eventName === 'TokenBlacklisted') {
        referenceLabel = 'Trading token';
      } else if (orderContext) {
        marketLabel = `${shortAddress(orderContext.tokenIn)} → ${shortAddress(orderContext.tokenOut)}`;
        actorLabel = shortAddress(orderContext.client);
        referenceLabel = `Order #${formatBigInt(orderId)}`;
      }

      break;
    }
    case 'Settlement Engine': {
      const makerOrderId = getBigIntArg(entry.args, 'makerOrderId');
      const takerOrderId = getBigIntArg(entry.args, 'takerOrderId');
      const listingId = getBigIntArg(entry.args, 'listingId');
      const offerId = getBigIntArg(entry.args, 'offerId');
      const batchId = getBigIntArg(entry.args, 'batchId');
      const executedAmount = getBigIntArg(entry.args, 'executedAmount');
      const makerContext = resolveOrderContext(orderIndex, makerOrderId);
      const listingContext = resolveListingContext(listingIndex, listingId);
      const nftCollection = getStringArg(entry.args, 'collection') ?? listingContext?.collection;
      const nftTokenId = getBigIntArg(entry.args, 'tokenId')?.toString() ?? listingContext?.tokenId;

      if (entry.eventName === 'TradeQueued' || entry.eventName === 'TradeExecuted') {
        const pairContext = makerContext ?? resolveOrderContext(orderIndex, takerOrderId);
        marketLabel = pairContext ? `${shortAddress(pairContext.tokenIn)} → ${shortAddress(pairContext.tokenOut)}` : `Order #${formatBigInt(makerOrderId)} / #${formatBigInt(takerOrderId)}`;
        amountLabel = formatBigInt(executedAmount);
        referenceLabel = `Orders #${formatBigInt(makerOrderId)} / #${formatBigInt(takerOrderId)}`;
        detailLabel = entry.eventName === 'TradeQueued' ? `Queued in batch #${formatBigInt(batchId)}` : 'Executed by settlement engine';
      } else if (entry.eventName === 'NFTTradeQueued' || entry.eventName === 'NFTTradeFailed' || entry.eventName === 'NFTTradeExecuted') {
        marketLabel = nftCollection ? `${shortAddress(nftCollection)} #${nftTokenId ?? '—'}` : `Listing #${formatBigInt(listingId)}`;
        amountLabel = `Listing #${formatBigInt(listingId)} / Offer #${formatBigInt(offerId)}`;
        referenceLabel = `Batch #${formatBigInt(batchId)}`;
        detailLabel = entry.eventName === 'NFTTradeQueued' ? 'Queued for settlement' : entry.eventName === 'NFTTradeFailed' ? 'Trade failed' : 'Executed NFT trade';
      } else if (entry.eventName === 'BatchSettled' || entry.eventName === 'BatchOpened') {
        marketLabel = `Batch #${formatBigInt(batchId)}`;
        referenceLabel = `Trades ${formatBigInt(getBigIntArg(entry.args, 'tradesSettled'))} / NFT ${formatBigInt(getBigIntArg(entry.args, 'nftTradesSettled'))}`;
      } else if (entry.eventName === 'UserBlacklisted') {
        actorLabel = shortAddress(getStringArg(entry.args, 'user'));
        referenceLabel = `Batch #${formatBigInt(batchId)}`;
      } else if (entry.eventName === 'OrderInactive' || entry.eventName === 'BothOrdersInactive') {
        referenceLabel = entry.eventName === 'OrderInactive'
          ? `Order #${formatBigInt(getBigIntArg(entry.args, 'orderId'))}`
          : `Orders #${formatBigInt(getBigIntArg(entry.args, 'makerOrderId'))} / #${formatBigInt(getBigIntArg(entry.args, 'takerOrderId'))}`;
      } else if (entry.eventName === 'SettlementWindowUpdated') {
        referenceLabel = `New window: ${formatBigInt(getBigIntArg(entry.args, 'newWindow'))}`;
      } else if (entry.eventName === 'MaxBatchSizeUpdated') {
        referenceLabel = `New size: ${formatBigInt(getBigIntArg(entry.args, 'newSize'))}`;
      }

      break;
    }
    case 'NFT Orderbook': {
      const listingId = getBigIntArg(entry.args, 'listingId');
      const offerId = getBigIntArg(entry.args, 'offerId');
      const listingContext = resolveListingContext(listingIndex, listingId);
      const collection = getStringArg(entry.args, 'collection') ?? listingContext?.collection;
      const tokenId = getBigIntArg(entry.args, 'tokenId')?.toString() ?? listingContext?.tokenId;

      marketLabel = collection ? `${shortAddress(collection)} #${tokenId ?? '—'}` : `Listing #${formatBigInt(listingId)}`;
      referenceLabel = entry.eventName === 'NFTListed'
        ? `Listing #${formatBigInt(listingId)}`
        : `Offer #${formatBigInt(offerId)}`;

      if (entry.eventName === 'NFTListed') {
        actorLabel = shortAddress(getStringArg(entry.args, 'seller'));
        detailLabel = 'Listing created';
      } else if (entry.eventName === 'NFTOfferMade') {
        actorLabel = shortAddress(getStringArg(entry.args, 'buyer'));
        detailLabel = 'Offer created';
      } else if (entry.eventName === 'NFTListingCancelled') {
        actorLabel = shortAddress(getStringArg(entry.args, 'seller'));
        detailLabel = 'Listing cancelled';
      } else if (entry.eventName === 'NFTOfferCancelled') {
        actorLabel = shortAddress(getStringArg(entry.args, 'buyer'));
        detailLabel = 'Offer cancelled';
      } else if (entry.eventName === 'NFTTradeMatched') {
        detailLabel = 'Listing and offer matched';
      }

      break;
    }
    case 'Custodian': {
      const token = getStringArg(entry.args, 'token');
      const amount = getBigIntArg(entry.args, 'amount');
      const client = getStringArg(entry.args, 'client');
      const user = getStringArg(entry.args, 'user');
      const tokenId = getBigIntArg(entry.args, 'tokenId');
      const from = getStringArg(entry.args, 'from');
      const to = getStringArg(entry.args, 'to');

      marketLabel = token ? shortAddress(token) : tokenId ? `NFT #${tokenId.toString()}` : '—';
      actorLabel = shortAddress(client ?? user ?? from ?? to);
      amountLabel = amount !== undefined ? formatBigInt(amount) : formatBigInt(tokenId);

      if (entry.eventName === 'InternalTransfer' || entry.eventName === 'NFTInternalTransfer') {
        detailLabel = `${shortAddress(from)} → ${shortAddress(to)}`;
      } else if (entry.eventName === 'WithdrawalQueued' || entry.eventName === 'WithdrawalProcessed') {
        detailLabel = getBooleanArg(entry.args, 'receiveETH') ? 'Receive as ETH' : 'Standard withdrawal';
      }

      break;
    }
    case 'Lending Pool': {
      const token = getStringArg(entry.args, 'token');
      const amount = getBigIntArg(entry.args, 'amount');
      const user = getStringArg(entry.args, 'user');

      marketLabel = token ? shortAddress(token) : '—';
      amountLabel = formatBigInt(amount);
      actorLabel = shortAddress(user);
      break;
    }
    case 'Compliance Manager': {
      const token = getStringArg(entry.args, 'token');
      const user = getStringArg(entry.args, 'user');
      const account = getStringArg(entry.args, 'account');
      const role = getStringArg(entry.args, 'role');

      marketLabel = token ? shortAddress(token) : user ? shortAddress(user) : account ? shortAddress(account) : 'System';
      actorLabel = shortAddress(user ?? account);
      referenceLabel = role ? shortHash(role) : referenceLabel;

      break;
    }
    default:
      break;
  }

  return {
    id: entry.id,
    timeLabel,
    eventLabel: entry.eventName,
    marketLabel,
    amountLabel,
    detailLabel,
    actorLabel,
    sourceLabel: entry.source,
    referenceLabel,
    blockLabel,
    txLabel,
  };
}

function MarketHistoryView({ isRegulatorAllowed }: MarketHistoryViewProps) {
  const publicClient = usePublicClient();
  const [audienceMode, setAudienceMode] = useState<AudienceMode>('client');
  const [activityLogs, setActivityLogs] = useState<ActivityLogEntry[]>([]);
  const [activityLogsLoading, setActivityLogsLoading] = useState(false);

  useEffect(() => {
    if (!isRegulatorAllowed && audienceMode !== 'client') {
      setAudienceMode('client');
    }
  }, [audienceMode, isRegulatorAllowed]);

  const refreshActivityLogs = useCallback(async () => {
    if (!publicClient) return;

    setActivityLogsLoading(true);
    try {
      const nextLogs = await loadComplianceActivityLogs(publicClient);
      setActivityLogs(nextLogs);
    } catch (error) {
      console.warn('Failed to refresh market history', error);
    } finally {
      setActivityLogsLoading(false);
    }
  }, [publicClient]);

  useEffect(() => {
    void refreshActivityLogs();
    const interval = setInterval(() => void refreshActivityLogs(), 60000);
    return () => clearInterval(interval);
  }, [refreshActivityLogs]);

  const orderIndex = useMemo(() => buildOrderIndex(activityLogs), [activityLogs]);
  const listingIndex = useMemo(() => buildListingIndex(activityLogs), [activityLogs]);

  const rows = useMemo(
    () => activityLogs.map((entry) => buildMarketHistoryRow(entry, orderIndex, listingIndex)),
    [activityLogs, orderIndex, listingIndex],
  );

  const stats = useMemo(() => {
    const tradeCount = activityLogs.filter((entry) =>
      (entry.source === 'Fungible Orderbook' && ['OrderPlaced', 'OrderMatched', 'OrderPartiallyFilled'].includes(entry.eventName)) ||
      (entry.source === 'Settlement Engine' && ['TradeQueued', 'TradeExecuted'].includes(entry.eventName)) ||
      (entry.source === 'NFT Orderbook' && ['NFTListed', 'NFTOfferMade', 'NFTTradeMatched'].includes(entry.eventName)) ||
      (entry.source === 'Settlement Engine' && ['NFTTradeQueued', 'NFTTradeExecuted'].includes(entry.eventName)),
    ).length;

    const regulatorEvents = activityLogs.filter((entry) => entry.source === 'Compliance Manager').length;
    const latestRow = rows[0];

    return {
      total: activityLogs.length,
      trades: tradeCount,
      regulatorEvents,
      latestBlock: latestRow?.blockLabel ?? '—',
    };
  }, [activityLogs, rows]);

  return (
    <section className="mh-panel">
      <div className="section-summary">
        <div>
          <p className="eyebrow">Market history</p>
          <h2>Trade history for clients, full trace for regulators</h2>
          <p>
            The default view keeps the feed readable for clients. Switch to regulator mode to inspect actor,
            contract, block, and transaction details for every recorded event.
          </p>
        </div>
        <div className="status-pill">{activityLogsLoading ? 'Refreshing history' : 'Live history'}</div>
      </div>

      <div className="cm-status-grid mh-stats-grid">
        <div className="cm-status-card">
          <span>Total events</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="cm-status-card">
          <span>Trade-related events</span>
          <strong>{stats.trades}</strong>
        </div>
        <div className="cm-status-card">
          <span>Compliance events</span>
          <strong>{stats.regulatorEvents}</strong>
        </div>
        <div className="cm-status-card">
          <span>Latest block</span>
          <strong>{stats.latestBlock}</strong>
        </div>
      </div>

      <div className="market-history-toolbar">
        {isRegulatorAllowed ? (
          <div className="segment-control" role="tablist" aria-label="Market history audience">
            <button
              type="button"
              className={audienceMode === 'client' ? 'active' : ''}
              onClick={() => setAudienceMode('client')}
              aria-pressed={audienceMode === 'client'}
            >
              Client view
            </button>
            <button
              type="button"
              className={audienceMode === 'regulator' ? 'active' : ''}
              onClick={() => setAudienceMode('regulator')}
              aria-pressed={audienceMode === 'regulator'}
            >
              Regulator view
            </button>
          </div>
        ) : (
          <div className="segment-control" aria-label="Market history audience">
            <button type="button" className="active" aria-pressed="true" disabled>
              Client view
            </button>
          </div>
        )}

        <div className="cm-actions-row">
          <button type="button" onClick={() => void refreshActivityLogs()} disabled={activityLogsLoading}>
            {activityLogsLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <p className="mh-note">
        Client view highlights what moved in the market. Regulator view includes the full audit trail.
      </p>

      <div className="mh-table-wrap">
        {rows.length === 0 ? (
          <p className="cm-log-empty">No market activity has been recorded yet.</p>
        ) : audienceMode === 'client' ? (
          <table className="mh-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Market / asset</th>
                <th>Event</th>
                <th>Amount / price</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.timeLabel}</td>
                  <td>{row.marketLabel}</td>
                  <td>{row.eventLabel}</td>
                  <td>{row.amountLabel}</td>
                  <td>{row.detailLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="mh-table mh-table-regulator">
            <thead>
              <tr>
                <th>Time</th>
                <th>Market / asset</th>
                <th>Event</th>
                <th>Amount / price</th>
                <th>Actor</th>
                <th>Source</th>
                <th>Block</th>
                <th>TX</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.timeLabel}</td>
                  <td>{row.marketLabel}</td>
                  <td>{row.eventLabel}</td>
                  <td>
                    <div>{row.amountLabel}</div>
                    <div className="mh-cell-detail">{row.detailLabel}</div>
                  </td>
                  <td>{row.actorLabel}</td>
                  <td>{row.sourceLabel}</td>
                  <td>{row.blockLabel}</td>
                  <td className="cm-tx-hash">{row.txLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export default MarketHistoryView;
