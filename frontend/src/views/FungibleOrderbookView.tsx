import { useEffect, useMemo, useState } from 'react';
import { decodeEventLog, encodePacked, isAddress, keccak256, parseUnits } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { FUNGIBLE_ORDERBOOK_CONTRACT, LENDING_POOL_CONTRACT } from '../constants/contracts.js';
import validateTokenOnchain, { type TokenMetadata } from '../hooks/useTokenValidation.js';

const ORDER_SIDE_OPTIONS = [
  { value: 0, label: 'Buy' },
  { value: 1, label: 'Sell' },
] as const;

function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`) as `0x${string}`;
}

function formatAddressLabel(metadata: TokenMetadata | null, input: string, isValid: boolean, fetchError = false) {
  if (!input) return '';
  if (!isValid) return '⚠ Invalid address';
  if (fetchError) return '⚠ Not a valid ERC20 token';
  if (metadata) return `✓ ${metadata.symbol} — ${metadata.name} (${metadata.decimals} decimals)`;
  return 'Address looks valid. Click away to validate token metadata.';
}

type OrderRecord = {
  orderId: bigint;
  client: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amount: bigint;
  price: bigint;
  side: number;
  partialAllowed: boolean;
  status: number;
  block: bigint;
};

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatAmount(value: bigint, decimals: number) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;

  if (fraction === 0n) {
    return `${negative ? '-' : ''}${whole.toString()}`;
  }

  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}.${fractionText}`;
}

function FungibleOrderbookView() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [tokenInInput, setTokenInInput] = useState('');
  const [tokenOutInput, setTokenOutInput] = useState('');
  const [amountInInput, setAmountInInput] = useState('');
  const [amountOutInput, setAmountOutInput] = useState('');
  const [side, setSide] = useState<number>(0);
  const [partialAllowed, setPartialAllowed] = useState(true);
  const [tokenInMetadata, setTokenInMetadata] = useState<TokenMetadata | null>(null);
  const [tokenOutMetadata, setTokenOutMetadata] = useState<TokenMetadata | null>(null);
  const [tokenInError, setTokenInError] = useState(false);
  const [tokenOutError, setTokenOutError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [lastCommitHash, setLastCommitHash] = useState<`0x${string}` | null>(null);
  const [lastRevealHash, setLastRevealHash] = useState<`0x${string}` | null>(null);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [tokenMetadataByAddress, setTokenMetadataByAddress] = useState<Record<string, TokenMetadata | null>>({});
  const [pendingCancel, setPendingCancel] = useState<bigint | null>(null);
  const [pendingTake, setPendingTake] = useState<bigint | null>(null);

  const validTokenIn = useMemo(
    () => (isAddress(tokenInInput) ? (tokenInInput as `0x${string}`) : undefined),
    [tokenInInput],
  );

  const validTokenOut = useMemo(
    () => (isAddress(tokenOutInput) ? (tokenOutInput as `0x${string}`) : undefined),
    [tokenOutInput],
  );

  const canSubmit = Boolean(
    address &&
    validTokenIn &&
    validTokenOut &&
    amountInInput.trim() &&
    amountOutInput.trim() &&
    !busy,
  );

  const validateSingleToken = async (
    tokenAddress: `0x${string}`,
    setter: (meta: TokenMetadata | null) => void,
    setError: (err: boolean) => void,
  ) => {
    if (!publicClient) return;
    setError(false);
    try {
        const meta = await validateTokenOnchain(publicClient, tokenAddress);
        setter(meta);
    } catch {
        setter(null);
        setError(true);
    }
  };

  const mineOneBlockIfPossible = async (targetBlock: bigint) => {
    if (!publicClient) return;

    try {
      await (publicClient as unknown as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }).request({
        method: 'evm_mine',
        params: [],
      });
      return;
    } catch {
      // Fall back to polling when the chain does not expose evm_mine.
    }

    const timeoutAt = Date.now() + 30_000;
    while (Date.now() < timeoutAt) {
      const currentBlock = await publicClient.getBlockNumber();
      if (currentBlock > targetBlock) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error('Timed out waiting for the next block.');
  };

  const validateTokens = async () => {
    if (!publicClient) throw new Error('Public client not available.');
    if (!validTokenIn) throw new Error('Enter a valid tokenIn address.');
    if (!validTokenOut) throw new Error('Enter a valid tokenOut address.');

    const [tokenIn, tokenOut] = await Promise.all([
      validateTokenOnchain(publicClient, validTokenIn),
      validateTokenOnchain(publicClient, validTokenOut),
    ]);

    setTokenInMetadata(tokenIn);
    setTokenOutMetadata(tokenOut);

    return { tokenIn, tokenOut };
  };

  const refreshOrders = async () => {
    if (!publicClient) return;

    try {
      setOrdersLoading(true);
      const latestBlock = await publicClient.getBlockNumber();
      const logs = await publicClient.getLogs({
        address: FUNGIBLE_ORDERBOOK_CONTRACT.address,
        event: {
          type: 'event',
          name: 'OrderPlaced',
          inputs: [
            { indexed: true, name: 'orderId', type: 'uint256' },
            { indexed: true, name: 'client', type: 'address' },
            { indexed: true, name: 'pairId', type: 'bytes32' },
            { indexed: false, name: 'tokenIn', type: 'address' },
            { indexed: false, name: 'tokenOut', type: 'address' },
            { indexed: false, name: 'price', type: 'uint256' },
            { indexed: false, name: 'amount', type: 'uint256' },
            { indexed: false, name: 'side', type: 'uint8' },
            { indexed: false, name: 'partialAllowed', type: 'bool' },
          ],
        },
        fromBlock: 0n,
        toBlock: latestBlock,
      });

      const nextOrders: OrderRecord[] = [];

      for (const log of logs) {
        const decoded = decodeEventLog({
          abi: FUNGIBLE_ORDERBOOK_CONTRACT.abi,
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName !== 'OrderPlaced') continue;

        const args = decoded.args as { orderId?: bigint } | undefined;
        const orderId = args?.orderId;
        if (orderId === undefined) continue;
        const order = await publicClient.readContract({
          ...FUNGIBLE_ORDERBOOK_CONTRACT,
          functionName: 'getOrder',
          args: [orderId],
        }) as {
          id: bigint;
          client: `0x${string}`;
          tokenIn: `0x${string}`;
          tokenOut: `0x${string}`;
          amount: bigint;
          price: bigint;
          side: bigint;
          partialAllowed: boolean;
          status: bigint;
          block: bigint;
        };

        nextOrders.push({
          orderId: order.id,
          client: order.client,
          tokenIn: order.tokenIn,
          tokenOut: order.tokenOut,
          amount: order.amount,
          price: order.price,
          side: Number(order.side),
          partialAllowed: order.partialAllowed,
          status: Number(order.status),
          block: order.block,
        });
      }

      nextOrders.sort((a, b) => Number(b.orderId - a.orderId));
      setOrders(nextOrders);

      const uniqueAddresses = Array.from(
        new Set(nextOrders.flatMap((order) => [order.tokenIn.toLowerCase(), order.tokenOut.toLowerCase()])),
      ) as `0x${string}`[];

      const metadataEntries = await Promise.all(
        uniqueAddresses.map(async (tokenAddress) => {
          try {
            const metadata = await validateTokenOnchain(publicClient, tokenAddress);
            return [tokenAddress.toLowerCase(), metadata] as const;
          } catch {
            return [tokenAddress.toLowerCase(), null] as const;
          }
        }),
      );

      setTokenMetadataByAddress(Object.fromEntries(metadataEntries));
    } catch (error) {
      console.warn('Failed to load orderbook orders', error);
      setOrders([]);
    } finally {
      setOrdersLoading(false);
    }
  };

  useEffect(() => {
    void refreshOrders();
  }, [publicClient, lastRevealHash]);

  useEffect(() => {
    const handler = () => void refreshOrders();
    window.addEventListener('settlementCompleted', handler);
    return () => window.removeEventListener('settlementCompleted', handler);
  }, []);

  const submitOrder = async () => {
    if (!address) {
      setFeedback('Connect your wallet first.');
      return;
    }

    if (!canSubmit) {
      setFeedback('Fill in tokenIn, tokenOut, amountIn, amountOut, and side.');
      return;
    }

    let amountIn: bigint;
    let amountOut: bigint;
    let tokenIn: TokenMetadata;
    let tokenOut: TokenMetadata;

    try {
      setBusy(true);
      setFeedback('Validating tokens...');
      ({ tokenIn, tokenOut } = await validateTokens());

      amountIn = parseUnits(amountInInput, tokenIn.decimals);
      amountOut = parseUnits(amountOutInput, tokenOut.decimals);

      if (amountIn <= 0n || amountOut <= 0n) {
        throw new Error('Amounts must be greater than zero.');
      }

      const salt = generateSalt();
      // Resolve aToken addresses if the underlying token is registered in the lending pool
      let usedTokenIn = validTokenIn as `0x${string}`;
      let usedTokenOut = validTokenOut as `0x${string}`;
      try {
        if (publicClient) {
          const aIn = (await publicClient.readContract({
            address: LENDING_POOL_CONTRACT.address,
            abi: LENDING_POOL_CONTRACT.abi,
            functionName: 'getAToken',
            args: [validTokenIn],
          })) as `0x${string}`;
          if (aIn && aIn !== '0x0000000000000000000000000000000000000000') usedTokenIn = aIn;

          const aOut = (await publicClient.readContract({
            address: LENDING_POOL_CONTRACT.address,
            abi: LENDING_POOL_CONTRACT.abi,
            functionName: 'getAToken',
            args: [validTokenOut],
          })) as `0x${string}`;
          if (aOut && aOut !== '0x0000000000000000000000000000000000000000') usedTokenOut = aOut;
        }
      } catch (err) {
        // If resolution fails, continue with the provided addresses
        console.warn('Failed to resolve aToken addresses, using supplied token addresses', err);
      }

      const commitHash = keccak256(
        encodePacked(
          ['address', 'address', 'address', 'uint256', 'uint256', 'uint8', 'bool', 'bytes32'],
          [address as `0x${string}`, usedTokenIn, usedTokenOut, amountIn, amountOut, side, partialAllowed, salt],
        ),
      );

      setFeedback('Submitting commit...');
      const commitTxHash = await writeContractAsync({
        ...FUNGIBLE_ORDERBOOK_CONTRACT,
        functionName: 'commit',
        args: [commitHash, 0],
      });

      if (!publicClient) {
        throw new Error('No public client available to track the commit transaction.');
      }

      const commitReceipt = await publicClient.waitForTransactionReceipt({ hash: commitTxHash });
      const committedEvent = commitReceipt.logs
        .map((log) => {
          try {
            return decodeEventLog({ abi: FUNGIBLE_ORDERBOOK_CONTRACT.abi, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .find((event) => event?.eventName === 'Committed');

      const commitId = committedEvent?.args && 'commitId' in committedEvent.args
        ? (committedEvent.args.commitId as bigint)
        : undefined;

      if (commitId === undefined) {
        throw new Error('Commit transaction succeeded but the commitId event was not found.');
      }

      setLastCommitHash(commitTxHash);
      setFeedback('Waiting one block before reveal...');
      await mineOneBlockIfPossible(commitReceipt.blockNumber ?? 0n);

      setFeedback('Revealing order...');
      const revealTxHash = await writeContractAsync({
        ...FUNGIBLE_ORDERBOOK_CONTRACT,
        functionName: 'revealOrder',
        args: [
          commitId,
          usedTokenIn,
          usedTokenOut,
          amountIn,
          amountOut,
          side,
          partialAllowed,
          salt,
        ],
      });

      await publicClient.waitForTransactionReceipt({ hash: revealTxHash });

      setLastRevealHash(revealTxHash);
      setFeedback('Order submitted successfully.');
      setAmountInInput('');
      setAmountOutInput('');
      await refreshOrders();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Order submission failed';
      setFeedback(message);
    } finally {
      setBusy(false);
    }
  };

  const cancelOrder = async (orderId: bigint) => {
    if (!address) {
      setFeedback('Connect your wallet first.');
      setPendingCancel(null);
      return;
    }

    try {
      setBusy(true);
      setFeedback(`Sending cancel for order #${orderId.toString()}...`);
      const txHash = await writeContractAsync({
        ...FUNGIBLE_ORDERBOOK_CONTRACT,
        functionName: 'cancelOrder',
        args: [orderId],
      });

      if (!publicClient) throw new Error('No public client available to track transaction.');
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      setFeedback(`Order #${orderId.toString()} cancelled.`);
      // Refresh orders to reflect cancellation
      await refreshOrders();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cancel failed';
      setFeedback(message);
    } finally {
      setBusy(false);
      setPendingCancel(null);
    }
  };

  const takeOrder = async (orderId: bigint, takerAmount: bigint) => {
    if (!address) {
      setFeedback('Connect your wallet first.');
      setPendingTake(null);
      return;
    }

    try {
      setBusy(true);
      const salt = generateSalt();

      const commitHash = keccak256(
        encodePacked(
          ['address', 'uint256', 'uint256', 'bytes32'],
          [address as `0x${string}`, orderId, takerAmount, salt],
        ),
      );

      setFeedback('Submitting take commit...');
      const commitTxHash = await writeContractAsync({
        ...FUNGIBLE_ORDERBOOK_CONTRACT,
        functionName: 'commit',
        args: [commitHash, 1],
      });

      if (!publicClient) throw new Error('No public client available to track transaction.');
      const commitReceipt = await publicClient.waitForTransactionReceipt({ hash: commitTxHash });

      const committedEvent = commitReceipt.logs
        .map((log) => {
          try {
            return decodeEventLog({ abi: FUNGIBLE_ORDERBOOK_CONTRACT.abi, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .find((event) => event?.eventName === 'Committed');

      const commitId = committedEvent?.args && 'commitId' in committedEvent.args
        ? (committedEvent.args.commitId as bigint)
        : undefined;

      if (commitId === undefined) throw new Error('Commit transaction succeeded but commitId was not found.');

      setFeedback('Waiting one block before revealing take...');
      await mineOneBlockIfPossible(commitReceipt.blockNumber ?? 0n);

      setFeedback('Revealing take...');
      const revealTxHash = await writeContractAsync({
        ...FUNGIBLE_ORDERBOOK_CONTRACT,
        functionName: 'revealTake',
        args: [commitId, orderId, takerAmount, salt],
      });

      await publicClient.waitForTransactionReceipt({ hash: revealTxHash });

      setFeedback('Take submitted successfully.');
      await refreshOrders();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Take failed';
      setFeedback(message);
    } finally {
      setBusy(false);
      setPendingTake(null);
    }
  };

  return (
    <section className="cm-panel">
      <header className="cm-header">
        <h2>Fungible Orderbook</h2>
        <p>Submit an order with commit-reveal and reveal it one block later.</p>
      </header>

      <div className="cm-block">
        <h3>Orderbook</h3>
        {ordersLoading ? (
          <p className="cm-hint">Loading orders...</p>
        ) : orders.length === 0 ? (
          <p className="cm-hint">No orders submitted yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {orders.filter((order) => order.status !== 0).map((order) => {
              const tokenInMeta = tokenMetadataByAddress[order.tokenIn.toLowerCase()] ?? null;
              const tokenOutMeta = tokenMetadataByAddress[order.tokenOut.toLowerCase()] ?? null;
              const normalizedIsTokenIn = order.tokenIn.toLowerCase() < order.tokenOut.toLowerCase();
              const amountIn = normalizedIsTokenIn
                ? order.amount
                : order.side === 0
                  ? (order.amount * 1_000000000000000000n) / order.price
                  : (order.amount * order.price) / 1_000000000000000000n;
              const amountOut = normalizedIsTokenIn
                ? order.side === 0
                  ? (order.amount * order.price) / 1_000000000000000000n
                  : (order.amount * 1_000000000000000000n) / order.price
                : order.amount;

              return (
                <div key={order.orderId.toString()} style={{ padding: 12, border: '1px solid rgba(15, 23, 42, 0.08)', borderRadius: 12 }}>
                  <strong>Order #{order.orderId.toString()}</strong>
                  <p className="cm-hint">
                    Token In: {tokenInMeta ? `${tokenInMeta.symbol} — ${tokenInMeta.name}` : shortAddress(order.tokenIn)} ({order.tokenIn})
                  </p>
                  <p className="cm-hint">
                    Token Out: {tokenOutMeta ? `${tokenOutMeta.symbol} — ${tokenOutMeta.name}` : shortAddress(order.tokenOut)} ({order.tokenOut})
                  </p>
                  <p className="cm-hint">Side: {ORDER_SIDE_OPTIONS.find((option) => option.value === order.side)?.label ?? order.side}</p>
                  <p className="cm-hint">Amount In: {tokenInMeta ? formatAmount(amountIn, tokenInMeta.decimals) : amountIn.toString()}</p>
                  <p className="cm-hint">Amount Out: {tokenOutMeta ? formatAmount(amountOut, tokenOutMeta.decimals) : amountOut.toString()}</p>
                  <p className="cm-hint">Partial fills: {order.partialAllowed ? 'Yes' : 'No'}</p>
                  <p className="cm-hint">Status: {order.status === 2 ? 'Active' : order.status === 1 ? 'Matched' : 'Inactive'}</p>
                  <p className="cm-hint">Client: {shortAddress(order.client)}</p>
                  {address && address.toLowerCase() === order.client.toLowerCase() && order.status === 2 ? (
                    <div style={{ marginTop: 8 }}>
                      {pendingCancel === order.orderId ? (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => void cancelOrder(order.orderId)}
                            disabled={busy}
                          >
                            Confirm Cancel
                          </button>
                          <button
                            onClick={() => setPendingCancel(null)}
                            disabled={busy}
                          >
                            Abort
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setPendingCancel(order.orderId)}
                          disabled={busy}
                        >
                          Cancel Order
                        </button>
                      )}
                    </div>
                  ) : null}
                  {address && address.toLowerCase() !== order.client.toLowerCase() && order.status === 2 ? (
                    <div style={{ marginTop: 8 }}>
                      {pendingTake === order.orderId ? (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => void takeOrder(order.orderId, order.amount)}
                            disabled={busy}
                          >
                            Confirm Take
                          </button>
                          <button
                            onClick={() => setPendingTake(null)}
                            disabled={busy}
                          >
                            Abort
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setPendingTake(order.orderId)}
                          disabled={busy}
                        >
                          Take Order
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="cm-block">
        <h3>Submit Order</h3>
        <label htmlFor="token-in">Token In</label>
        <input
            id="token-in"
            placeholder="0x..."
            value={tokenInInput}
            onChange={(event) => { setTokenInInput(event.target.value.trim()); setTokenInMetadata(null); setTokenInError(false); }}
            onBlur={() => { if (validTokenIn) validateSingleToken(validTokenIn, setTokenInMetadata, setTokenInError); }}
        />
        <p className="cm-hint">{formatAddressLabel(tokenInMetadata, tokenInInput, !!validTokenIn, tokenInError)}</p>

        <label htmlFor="token-out">Token Out</label>
        <input
            id="token-out"
            placeholder="0x..."
            value={tokenOutInput}
            onChange={(event) => { setTokenOutInput(event.target.value.trim()); setTokenOutMetadata(null); setTokenOutError(false); }}
            onBlur={() => { if (validTokenOut) validateSingleToken(validTokenOut, setTokenOutMetadata, setTokenOutError); }}
        />
        <p className="cm-hint">{formatAddressLabel(tokenOutMetadata, tokenOutInput, !!validTokenOut, tokenOutError)}</p>
        <label htmlFor="amount-in">Amount In</label>
        <input
          id="amount-in"
          type="number"
          placeholder="0.0"
          value={amountInInput}
          onChange={(event) => setAmountInInput(event.target.value)}
          min="0"
          step="0.01"
        />

        <label htmlFor="amount-out">Amount Out</label>
        <input
          id="amount-out"
          type="number"
          placeholder="0.0"
          value={amountOutInput}
          onChange={(event) => setAmountOutInput(event.target.value)}
          min="0"
          step="0.01"
        />

        <label htmlFor="order-side">Side</label>
        <select id="order-side" value={side} onChange={(event) => setSide(Number(event.target.value))}>
          {ORDER_SIDE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            type="checkbox"
            checked={partialAllowed}
            onChange={(event) => setPartialAllowed(event.target.checked)}
          />
          Partial fills allowed
        </label>

        <div className="cm-actions-row">
          <button onClick={submitOrder} disabled={!canSubmit}>
            Submit Order
          </button>
        </div>

        <p className="cm-hint">
          The frontend will commit your order hash, wait for the next block, then reveal the full order.
        </p>
      </div>

      {lastCommitHash ? (
        <div className="cm-tx-box">
          <p className="cm-hint">Last commit hash</p>
          <p className="cm-tx-hash">{lastCommitHash}</p>
        </div>
      ) : null}

      {lastRevealHash ? (
        <div className="cm-tx-box">
          <p className="cm-hint">Last reveal hash</p>
          <p className="cm-tx-hash">{lastRevealHash}</p>
        </div>
      ) : null}

      {feedback ? <p className="cm-feedback">{feedback}</p> : null}

    </section>
  );
}

export default FungibleOrderbookView;