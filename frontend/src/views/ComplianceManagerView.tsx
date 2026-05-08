import { useCallback, useEffect, useMemo, useState } from 'react';
import { isAddress, parseUnits } from 'viem';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { usePublicClient } from 'wagmi';
import { COMPLIANCE_MANAGER_CONTRACT, LENDING_POOL_CONTRACT, SETTLEMENT_ENGINE_CONTRACT } from '../constants/contracts';
import ATokenABI from '../abis/AToken.json';
import MockERC20 from '../abis/MockERC20.json';

const USER_STATUS_OPTIONS = [
  { value: 0, label: 'Allowed' },
  { value: 1, label: 'Blacklisted With Withdrawal' },
  { value: 2, label: 'Blacklisted' },
] as const;

function ComplianceManagerView() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [tokenAddressInput, setTokenAddressInput] = useState('');
  const [userAddressInput, setUserAddressInput] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<number>(0);
  const [busyAction, setBusyAction] = useState<string>('idle');
  const [feedback, setFeedback] = useState<string>('');
  const [lastTxHash, setLastTxHash] = useState<`0x${string}` | null>(null);
  const [lastTxStatus, setLastTxStatus] = useState<'idle' | 'pending' | 'confirmed' | 'failed'>('idle');
  const [lastTxBlock, setLastTxBlock] = useState<bigint | null>(null);
  const [selectedPoolToken, setSelectedPoolToken] = useState<`0x${string}` | ''>('');
  const [liquidityAmount, setLiquidityAmount] = useState('');
  const [selectedYieldPoolToken, setSelectedYieldPoolToken] = useState<`0x${string}` | ''>('');
  const [yieldSeconds, setYieldSeconds] = useState('');
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(null);
  const [tokenAllowance, setTokenAllowance] = useState<bigint | null>(null);
  const [poolTokenDisplayNames, setPoolTokenDisplayNames] = useState<Record<string, string>>({});
  const [settlementWindow, setSettlementWindow] = useState<number | null>(null);
  const [newSettlementWindow, setNewSettlementWindow] = useState('');
  
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [settlementLoaded, setSettlementLoaded] = useState(false);
  const [trackedBatchId, setTrackedBatchId] = useState<number | null>(null);

  const validTokenAddress = useMemo(
    () => (isAddress(tokenAddressInput) ? (tokenAddressInput as `0x${string}`) : undefined),
    [tokenAddressInput],
  );

  const validUserAddress = useMemo(
    () => (isAddress(userAddressInput) ? (userAddressInput as `0x${string}`) : undefined),
    [userAddressInput],
  );

  const { data: pausedRaw, refetch: refetchPaused } = useReadContract({
    ...COMPLIANCE_MANAGER_CONTRACT,
    functionName: 'isSystemPaused',
  });

  const { data: isOperatorRaw, refetch: refetchOperator } = useReadContract({
    ...COMPLIANCE_MANAGER_CONTRACT,
    functionName: 'hasOperatorRole',
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address },
  });

  const { data: tokenBlacklistedRaw, refetch: refetchTokenStatus } = useReadContract({
    ...COMPLIANCE_MANAGER_CONTRACT,
    functionName: 'blacklistedTokens',
    args: validTokenAddress ? [validTokenAddress] : undefined,
    query: { enabled: !!validTokenAddress },
  });

  const { data: userStatusRaw, refetch: refetchUserStatus } = useReadContract({
    ...COMPLIANCE_MANAGER_CONTRACT,
    functionName: 'userStatus',
    args: validUserAddress ? [validUserAddress] : undefined,
    query: { enabled: !!validUserAddress },
  });

  const { data: supportedTokensRaw, refetch: refetchSupportedTokens } = useReadContract({
    ...LENDING_POOL_CONTRACT,
    functionName: 'getSupportedTokens',
  });
  const { data: lendingPoolAdminRaw } = useReadContract({
    ...LENDING_POOL_CONTRACT,
    functionName: 'admin',
  });

  const paused = Boolean(pausedRaw);
  const isOperator = Boolean(isOperatorRaw);
  const tokenBlacklisted = Boolean(tokenBlacklistedRaw);
  const currentUserStatus = Number(userStatusRaw ?? 0);
  const supportedTokens = (supportedTokensRaw as `0x${string}`[]) || [];
  const poolAdmin = (lendingPoolAdminRaw as `0x${string}`) || undefined;
  const isPoolAdmin = Boolean(address && poolAdmin && (address as string).toLowerCase() === poolAdmin.toLowerCase());

  // Fetch aToken symbols for display
  useEffect(() => {
    if (!publicClient || supportedTokens.length === 0) return;

    const fetchPoolDisplayNames = async () => {
      const names: Record<string, string> = {};

      for (const token of supportedTokens) {
        try {
          // Get the aToken address for this pool token
          const aTokenAddress = (await publicClient.readContract({
            address: LENDING_POOL_CONTRACT.address,
            abi: LENDING_POOL_CONTRACT.abi,
            functionName: 'getAToken',
            args: [token],
          })) as `0x${string}`;

          if (!aTokenAddress || aTokenAddress === '0x0000000000000000000000000000000000000000') {
            names[token] = token.slice(0, 6) + '...' + token.slice(-4);
            continue;
          }

          // Get the aToken symbol
          const symbol = (await publicClient.readContract({
            address: aTokenAddress,
            abi: ATokenABI.abi,
            functionName: 'symbol',
          })) as string;

          names[token] = symbol || token.slice(0, 6) + '...' + token.slice(-4);
        } catch (error) {
          console.error(`Failed to fetch symbol for token ${token}:`, error);
          names[token] = token.slice(0, 6) + '...' + token.slice(-4);
        }
      }

      setPoolTokenDisplayNames(names);
    };

    fetchPoolDisplayNames();
  }, [supportedTokens, publicClient]);

  useEffect(() => {
    if (!publicClient || !selectedPoolToken || !address) {
      setTokenDecimals(null);
      setTokenAllowance(null);
      return;
    }

    const fetchTokenData = async () => {
      try {
        const dec = (await publicClient.readContract({
          address: selectedPoolToken,
          abi: MockERC20.abi,
          functionName: 'decimals',
        })) as unknown;
        setTokenDecimals(Number(dec));
      } catch (e) {
        setTokenDecimals(null);
      }

      try {
        const allowance = (await publicClient.readContract({
          address: selectedPoolToken,
          abi: MockERC20.abi,
          functionName: 'allowance',
          args: [address as `0x${string}`, LENDING_POOL_CONTRACT.address],
        })) as bigint;
        setTokenAllowance(allowance);
      } catch (e) {
        setTokenAllowance(null);
      }
    };

    fetchTokenData();
  }, [selectedPoolToken, address, publicClient]);

  const runAction = async (actionKey: string, action: () => Promise<unknown>, successMessage: string) => {
    try {
      setBusyAction(actionKey);
      setFeedback('');
      setLastTxStatus('pending');
      setLastTxBlock(null);

      const txHash = (await action()) as `0x${string}`;
      setLastTxHash(txHash);

      if (!publicClient) {
        throw new Error('No public client available to track transaction receipt.');
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      setLastTxStatus(receipt.status === 'success' ? 'confirmed' : 'failed');
      setLastTxBlock(receipt.blockNumber ?? null);
      setFeedback(successMessage);
      await Promise.all([refetchPaused(), refetchOperator(), refetchTokenStatus(), refetchUserStatus(), refetchSupportedTokens()]);
    } catch (error) {
      setLastTxStatus('failed');
      const message = error instanceof Error ? error.message : 'Unknown transaction error';
      setFeedback(message);
    } finally {
      setBusyAction('idle');
    }
  };

  const pauseSystem = () =>
    runAction(
      'pause',
      () =>
        writeContractAsync({
          ...COMPLIANCE_MANAGER_CONTRACT,
          functionName: 'pause',
        }),
      'System paused successfully.',
    );

  const unpauseSystem = () =>
    runAction(
      'unpause',
      () =>
        writeContractAsync({
          ...COMPLIANCE_MANAGER_CONTRACT,
          functionName: 'unpause',
        }),
      'System unpaused successfully.',
    );

  const blacklistToken = () => {
    if (!validTokenAddress) {
      setFeedback('Enter a valid token address.');
      return Promise.resolve();
    }

    return runAction(
      'blacklist',
      () =>
        writeContractAsync({
          ...COMPLIANCE_MANAGER_CONTRACT,
          functionName: 'blacklistToken',
          args: [validTokenAddress],
        }),
      'Token blacklisted successfully.',
    );
  };

  const unblacklistToken = () => {
    if (!validTokenAddress) {
      setFeedback('Enter a valid token address.');
      return Promise.resolve();
    }

    return runAction(
      'unblacklist',
      () =>
        writeContractAsync({
          ...COMPLIANCE_MANAGER_CONTRACT,
          functionName: 'unblacklistToken',
          args: [validTokenAddress],
        }),
      'Token unblacklisted successfully.',
    );
  };

  const updateUserStatus = () => {
    if (!validUserAddress) {
      setFeedback('Enter a valid user address.');
      return Promise.resolve();
    }

    return runAction(
      'setStatus',
      () =>
        writeContractAsync({
          ...COMPLIANCE_MANAGER_CONTRACT,
          functionName: 'setUserStatus',
          args: [validUserAddress, selectedStatus],
        }),
      'User status updated successfully.',
    );
  };

  const provideLiquidity = async () => {
    if (!selectedPoolToken) {
      setFeedback('Select a pool token.');
      return Promise.resolve();
    }

    if (!liquidityAmount || parseFloat(liquidityAmount) <= 0) {
      setFeedback('Enter a valid liquidity amount.');
      return Promise.resolve();
    }

    if (!isPoolAdmin) {
      setFeedback('addLiquidity is admin-only. Connect the lending pool admin account or update the contract.');
      return Promise.resolve();
    }

    const usedDecimals = tokenDecimals ?? 18;
    const parsedAmount = parseUnits(liquidityAmount, usedDecimals);

    // If allowance is missing or insufficient, attempt to approve first
    if (tokenAllowance === null || tokenAllowance < parsedAmount) {
      setFeedback('Approving token for lending pool...');
      try {
        await approveToken();
      } catch (e) {
        // approveToken sets feedback on error; abort
        return Promise.resolve();
      }
    }

    return runAction(
      'provideLiquidity',
      () =>
        writeContractAsync({
          ...LENDING_POOL_CONTRACT,
          functionName: 'addLiquidity',
          args: [selectedPoolToken, parsedAmount],
        }),
      'Liquidity provided successfully.',
    );
  };

  const approveToken = () => {
    if (!selectedPoolToken) {
      setFeedback('Select a pool token to approve.');
      return Promise.resolve();
    }

    if (!liquidityAmount || parseFloat(liquidityAmount) <= 0) {
      setFeedback('Enter a valid amount to approve.');
      return Promise.resolve();
    }

    const usedDecimals = tokenDecimals ?? 18;
    const parsedAmount = parseUnits(liquidityAmount, usedDecimals);

    return runAction(
      'approveToken',
      () =>
        writeContractAsync({
          address: selectedPoolToken,
          abi: MockERC20.abi,
          functionName: 'approve',
          args: [LENDING_POOL_CONTRACT.address, parsedAmount],
        }),
      'Token approved successfully.',
    ).then(async () => {
      // refresh allowance
      try {
        const allowance = (await publicClient!.readContract({
          address: selectedPoolToken,
          abi: MockERC20.abi,
          functionName: 'allowance',
          args: [address as `0x${string}`, LENDING_POOL_CONTRACT.address],
        })) as bigint;
        setTokenAllowance(allowance);
      } catch (e) {
        // ignore
      }
    });
  };

  const simulateYield = () => {
    if (!selectedYieldPoolToken) {
      setFeedback('Select a pool token.');
      return Promise.resolve();
    }

    if (!yieldSeconds || parseFloat(yieldSeconds) <= 0) {
      setFeedback('Enter a valid number of seconds.');
      return Promise.resolve();
    }

    const parsedSeconds = BigInt(Math.floor(parseFloat(yieldSeconds)));

    return runAction(
      'simulateYield',
      () =>
        writeContractAsync({
          ...LENDING_POOL_CONTRACT,
          functionName: 'simulateYield',
          args: [selectedYieldPoolToken, parsedSeconds],
        }),
      'Yield simulated successfully.',
    );
  };

  const fetchSettlementInfo = useCallback(async () => {
    if (!publicClient) return;

    try {
      // Read settlement window, batchOpenedAt, and current batch ID from contract
      const window = (await publicClient.readContract({
        ...SETTLEMENT_ENGINE_CONTRACT,
        functionName: 'settlementWindowSeconds',
      })) as bigint;

      const openedAt = (await publicClient.readContract({
        ...SETTLEMENT_ENGINE_CONTRACT,
        functionName: 'batchOpenedAt',
      })) as bigint;

      const currentBatchId = (await publicClient.readContract({
        ...SETTLEMENT_ENGINE_CONTRACT,
        functionName: 'currentBatchId',
      })) as bigint;

      // Contract's helper that returns time remaining (may use block.timestamp internally)
      const timeRemaining = (await publicClient.readContract({
        ...SETTLEMENT_ENGINE_CONTRACT,
        functionName: 'timeUntilSettlement',
      })) as bigint;

      // Also fetch latest block to compute a local countdown based on on-chain timestamps
      const latestBlock = await publicClient.getBlock({ blockTag: 'latest' });
      const blockTs = Number(latestBlock.timestamp ?? 0n);

      const computedRemaining = Math.max(0, Number(openedAt) + Number(window) - blockTs);
      const batchIdNum = Number(currentBatchId);

      setSettlementWindow(Number(window));

      // Check if batch ID changed (new batch opened after settlement)
      if (trackedBatchId !== null && batchIdNum !== trackedBatchId) {
        // Batch rolled over, reset countdown to the fresh window
        setCountdownSeconds(computedRemaining);
      } else {
        // Same batch, only resync downward to avoid upward jumps
        setCountdownSeconds((prev) => {
          if (prev === null) return computedRemaining;
          // If on-chain/computed remaining is significantly smaller, resync downward
          if (computedRemaining < prev - 1) return computedRemaining;
          // Otherwise keep the current ticking value to avoid pushes back in time
          return prev;
        });
      }

      setTrackedBatchId(batchIdNum);
      setSettlementLoaded(true);

      // Log fetch for debugging
      // eslint-disable-next-line no-console
      console.debug('fetchSettlementInfo', {
        window: Number(window),
        openedAt: Number(openedAt),
        currentBatchId: batchIdNum,
        contractTimeRemaining: Number(timeRemaining),
        computedRemaining,
        blockNumber: Number(latestBlock.number ?? 0n),
        blockTs,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('Failed to fetch settlement info', err);
    }
  }, [publicClient, trackedBatchId]);

  useEffect(() => {
    void fetchSettlementInfo();
    const interval = setInterval(() => void fetchSettlementInfo(), 10000);
    return () => clearInterval(interval);
  }, [fetchSettlementInfo]);

  // Tick local countdown every second based on the computed countdownSeconds
  useEffect(() => {
    const tick = setInterval(() => {
      setCountdownSeconds((prev) => {
        if (prev === null) return null;
        if (prev <= 0) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  const updateSettlementWindow = () => {
    if (!newSettlementWindow || parseFloat(newSettlementWindow) <= 0) {
      setFeedback('Enter a valid settlement window duration in seconds.');
      return Promise.resolve();
    }

    const newWindow = BigInt(Math.floor(parseFloat(newSettlementWindow)));

    return runAction(
      'updateSettlementWindow',
      () =>
        writeContractAsync({
          ...SETTLEMENT_ENGINE_CONTRACT,
          functionName: 'setSettlementWindow',
          args: [newWindow],
        }),
      'Settlement window updated successfully.',
    ).then(() => {
      setNewSettlementWindow('');
      void fetchSettlementInfo();
    });
  };

  const settleBatch = () => {
    if (!settlementLoaded || countdownSeconds === null || countdownSeconds > 0) {
      setFeedback('Settlement window has not expired yet.');
      return Promise.resolve();
    }

    return runAction(
      'settleBatch',
      () =>
        writeContractAsync({
          ...SETTLEMENT_ENGINE_CONTRACT,
          functionName: 'settleBatch',
        }),
      'Batch settled successfully.',
    ).then(() => {
      window.dispatchEvent(new CustomEvent('settlementCompleted'));
      void fetchSettlementInfo();
    });
  };

  return (
    <section className="cm-panel">
      <header className="cm-header">
        <h2>Compliance Manager Panel</h2>
        <p>General Compliance controls managed by the operators of the system</p>
      </header>

      <div className="cm-status-grid">
        <div className="cm-status-card">
          <span>System status</span>
          <strong>{paused ? 'Paused' : 'Active'}</strong>
        </div>
        <div className="cm-status-card">
          <span>Your operator role</span>
          <strong>{isOperator ? 'Operator' : 'Not operator'}</strong>
        </div>
      </div>

      <div className="cm-actions-row">
        <button onClick={pauseSystem} disabled={busyAction !== 'idle' || !isOperator || paused}>
          Pause
        </button>
        <button onClick={unpauseSystem} disabled={busyAction !== 'idle' || !isOperator || !paused}>
          Unpause
        </button>
      </div>

      <div className="cm-block">
        <h3>Token Blacklist</h3>
        <label htmlFor="token-address">Token Address</label>
        <input
          id="token-address"
          placeholder="0x..."
          value={tokenAddressInput}
          onChange={(event) => setTokenAddressInput(event.target.value.trim())}
        />
        <p className="cm-hint">
          Current: {validTokenAddress ? (tokenBlacklisted ? 'Blacklisted' : 'Allowed') : 'Enter a valid address'}
        </p>
        <div className="cm-actions-row">
          <button onClick={blacklistToken} disabled={busyAction !== 'idle' || !isOperator || !validTokenAddress}>
            Blacklist Token
          </button>
          <button onClick={unblacklistToken} disabled={busyAction !== 'idle' || !isOperator || !validTokenAddress}>
            Unblacklist Token
          </button>
        </div>
      </div>

      <div className="cm-block">
        <h3>User Status</h3>
        <label htmlFor="user-address">User Address</label>
        <input
          id="user-address"
          placeholder="0x..."
          value={userAddressInput}
          onChange={(event) => setUserAddressInput(event.target.value.trim())}
        />
        <label htmlFor="status-select">New Status</label>
        <select id="status-select" value={selectedStatus} onChange={(event) => setSelectedStatus(Number(event.target.value))}>
          {USER_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="cm-hint">
          Current status:{' '}
          {USER_STATUS_OPTIONS.find((option) => option.value === currentUserStatus)?.label ?? `Unknown (${currentUserStatus})`}
        </p>
        <div className="cm-actions-row">
          <button onClick={updateUserStatus} disabled={busyAction !== 'idle' || !isOperator || !validUserAddress}>
            Update User Status
          </button>
        </div>
      </div>

      <div className="cm-block">
        <h3>Lending Pool Liquidity</h3>
        <label htmlFor="pool-select">Pool Token</label>
        <select
          id="pool-select"
          value={selectedPoolToken}
          onChange={(event) => setSelectedPoolToken(event.target.value as `0x${string}`)}
        >
          <option value="">Select a pool</option>
          {supportedTokens.map((token) => (
            <option key={token} value={token}>
              {poolTokenDisplayNames[token] || token}
            </option>
          ))}
        </select>
        <label htmlFor="liquidity-amount">Amount to Provide</label>
        <input
          id="liquidity-amount"
          type="number"
          placeholder="0.0"
          value={liquidityAmount}
          onChange={(event) => setLiquidityAmount(event.target.value)}
          min="0"
          step="0.01"
        />
        <p className="cm-hint">
          {selectedPoolToken ? `Token: ${poolTokenDisplayNames[selectedPoolToken] || selectedPoolToken}` : 'Select a token'}
        </p>
        <div className="cm-actions-row">
          <button
            onClick={provideLiquidity}
            disabled={busyAction !== 'idle' || !isPoolAdmin || !selectedPoolToken || !liquidityAmount}
          >
            Provide Liquidity
          </button>
        </div>
        <p className="cm-hint">Admin: {isPoolAdmin ? 'Yes' : poolAdmin ?? 'unknown'}</p>
      </div>

      <div className="cm-block">
        <h3>Simulate Yield</h3>
        <label htmlFor="yield-pool-select">Pool Token</label>
        <select
          id="yield-pool-select"
          value={selectedYieldPoolToken}
          onChange={(event) => setSelectedYieldPoolToken(event.target.value as `0x${string}`)}
        >
          <option value="">Select a pool</option>
          {supportedTokens.map((token) => (
            <option key={token} value={token}>
              {poolTokenDisplayNames[token] || token}
            </option>
          ))}
        </select>
        <label htmlFor="yield-seconds">Seconds to Simulate</label>
        <input
          id="yield-seconds"
          type="number"
          placeholder="0"
          value={yieldSeconds}
          onChange={(event) => setYieldSeconds(event.target.value)}
          min="0"
          step="1"
        />
        <p className="cm-hint">
          {selectedYieldPoolToken ? `Token: ${poolTokenDisplayNames[selectedYieldPoolToken] || selectedYieldPoolToken}` : 'Select a token'}
        </p>
        <div className="cm-actions-row">
          <button onClick={simulateYield} disabled={busyAction !== 'idle' || !isOperator || !selectedYieldPoolToken}>
            Simulate Yield
          </button>
        </div>
      </div>

      <div className="cm-block">
        <h3>Settlement Control</h3>
        <div className="cm-status-grid">
          <div className="cm-status-card">
            <span>Settlement Window</span>
            <strong>{settlementWindow ? `${settlementWindow} seconds` : 'Loading...'}</strong>
          </div>
          <div className="cm-status-card">
            <span>Time Until Settlement</span>
            <strong>{settlementLoaded && countdownSeconds !== null ? `${countdownSeconds}s` : 'Loading...'}</strong>
          </div>
        </div>

        <label htmlFor="new-settlement-window">New Settlement Window (seconds)</label>
        <input
          id="new-settlement-window"
          type="number"
          placeholder="300"
          value={newSettlementWindow}
          onChange={(event) => setNewSettlementWindow(event.target.value)}
          min="60"
          step="1"
        />
        <p className="cm-hint">Minimum: 60 seconds</p>

        <div className="cm-actions-row">
          <button
            onClick={updateSettlementWindow}
            disabled={busyAction !== 'idle' || !isOperator || !newSettlementWindow}
          >
            Update Settlement Window
          </button>
          <button
            onClick={settleBatch}
            disabled={busyAction !== 'idle' || !isOperator || !settlementLoaded || (countdownSeconds !== null && countdownSeconds > 0)}
          >
            Settle Batch
          </button>
        </div>
        <p className="cm-hint">
          {countdownSeconds !== null && countdownSeconds > 0
            ? `Settlement window expires in ${countdownSeconds} seconds`
            : 'Settlement window has expired. You can settle the batch.'}
        </p>
      </div>

      {lastTxHash ? (
        <div className="cm-tx-box">
          <p className="cm-hint">Last transaction hash</p>
          <p className="cm-tx-hash">{lastTxHash}</p>
          <p className="cm-hint">
            Status: {lastTxStatus}
            {lastTxBlock !== null ? ` (mined in block ${lastTxBlock.toString()})` : ''}
          </p>
        </div>
      ) : null}

      {feedback ? <p className="cm-feedback">{feedback}</p> : null}
    </section>
  );
}

export default ComplianceManagerView;