import { useMemo, useState } from 'react';
import { isAddress } from 'viem';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { usePublicClient } from 'wagmi';
import { COMPLIANCE_MANAGER_CONTRACT } from '../constants/contracts';

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

  const paused = Boolean(pausedRaw);
  const isOperator = Boolean(isOperatorRaw);
  const tokenBlacklisted = Boolean(tokenBlacklistedRaw);
  const currentUserStatus = Number(userStatusRaw ?? 0);

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
      await Promise.all([refetchPaused(), refetchOperator(), refetchTokenStatus(), refetchUserStatus()]);
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