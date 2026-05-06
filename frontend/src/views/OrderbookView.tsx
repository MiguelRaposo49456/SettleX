import { useMemo, useState } from 'react';
import { decodeEventLog, encodePacked, isAddress, keccak256, parseUnits } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { FUNGIBLE_ORDERBOOK_CONTRACT, LENDING_POOL_CONTRACT } from '../constants/contracts';
import validateTokenOnchain, { type TokenMetadata } from '../hooks/useTokenValidation';

const ORDER_SIDE_OPTIONS = [
  { value: 0, label: 'Buy' },
  { value: 1, label: 'Sell' },
] as const;

function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`) as `0x${string}`;
}

function formatAddressLabel(metadata: TokenMetadata | null, input: string, isValid: boolean) {
  if (!input) return '';
  if (!isValid) return '⚠ Invalid address';
  if (metadata) return `✓ ${metadata.symbol} — ${metadata.name} (${metadata.decimals} decimals)`;
  return 'Fetching token info...';
}

function OrderbookView() {
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
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [lastCommitHash, setLastCommitHash] = useState<`0x${string}` | null>(null);
  const [lastRevealHash, setLastRevealHash] = useState<`0x${string}` | null>(null);

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
  ) => {
    if (!publicClient) return;
    try {
        const meta = await validateTokenOnchain(publicClient, tokenAddress);
        setter(meta);
    } catch {
        setter(null);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Order submission failed';
      setFeedback(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cm-panel">
      <header className="cm-header">
        <h2>Fungible Orderbook</h2>
        <p>Submit an order with commit-reveal and reveal it one block later.</p>
      </header>

      <div className="cm-block">
        <h3>Submit Order</h3>
        <label htmlFor="token-in">Token In</label>
        <input
            id="token-in"
            placeholder="0x..."
            value={tokenInInput}
            onChange={(event) => { setTokenInInput(event.target.value.trim()); setTokenInMetadata(null); }}
            onBlur={() => { if (validTokenIn) validateSingleToken(validTokenIn, setTokenInMetadata); }}
        />
        <p className="cm-hint">{formatAddressLabel(tokenInMetadata, tokenInInput, !!validTokenIn)}</p>

        <label htmlFor="token-out">Token Out</label>
        <input
            id="token-out"
            placeholder="0x..."
            value={tokenOutInput}
            onChange={(event) => { setTokenOutInput(event.target.value.trim()); setTokenOutMetadata(null); }}
            onBlur={() => { if (validTokenOut) validateSingleToken(validTokenOut, setTokenOutMetadata); }}
        />
        <p className="cm-hint">{formatAddressLabel(tokenOutMetadata, tokenOutInput, !!validTokenOut)}</p>
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

export default OrderbookView;