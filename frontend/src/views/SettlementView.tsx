import { useCallback, useEffect, useState } from 'react';
import { usePublicClient, useWriteContract } from 'wagmi';
import { SETTLEMENT_ENGINE_CONTRACT } from '../constants/contracts';

function SettlementView() {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [batchId, setBatchId] = useState<number | null>(null);
  const [settlementWindow, setSettlementWindow] = useState<number | null>(null);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');

  const fetchSettlementInfo = useCallback(async () => {
    if (!publicClient) return;

    try {
      const [window, currentBatchId, timeRemaining] = await Promise.all([
        publicClient.readContract({
          ...SETTLEMENT_ENGINE_CONTRACT,
          functionName: 'settlementWindowSeconds',
        }) as Promise<bigint>,
        publicClient.readContract({
          ...SETTLEMENT_ENGINE_CONTRACT,
          functionName: 'currentBatchId',
        }) as Promise<bigint>,
        publicClient.readContract({
          ...SETTLEMENT_ENGINE_CONTRACT,
          functionName: 'timeUntilSettlement',
        }) as Promise<bigint>,
      ]);

      setSettlementWindow(Number(window));
      setBatchId(Number(currentBatchId));
      setCountdownSeconds(Number(timeRemaining));
      setLoaded(true);
    } catch (error) {
      console.warn('Failed to fetch settlement information', error);
      setLoaded(false);
    }
  }, [publicClient]);

  useEffect(() => {
    void fetchSettlementInfo();
    const interval = setInterval(() => void fetchSettlementInfo(), 15000);
    return () => clearInterval(interval);
  }, [fetchSettlementInfo]);

  useEffect(() => {
    const tick = setInterval(() => {
      setCountdownSeconds((previous) => (previous === null ? null : Math.max(0, previous - 1)));
    }, 1000);
    return () => clearInterval(tick);
  }, []);

  const settleBatch = async () => {
    if (!loaded || countdownSeconds === null || countdownSeconds > 0) return;

    try {
      setBusy(true);
      setFeedback('Waiting for settlement transaction...');
      const hash = await writeContractAsync({
        ...SETTLEMENT_ENGINE_CONTRACT,
        functionName: 'settleBatch',
      });

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash });
      }

      setFeedback('Batch settled successfully.');
      await fetchSettlementInfo();
    } catch (error) {
      console.warn('Settlement failed', error);
      setFeedback('Settlement failed or was cancelled.');
    } finally {
      setBusy(false);
    }
  };

  const isExpired = loaded && countdownSeconds === 0;

  return (
    <section className="cm-panel">
      <header className="cm-header">
        <h2>Settlement</h2>
        <p>Anyone can settle the current batch after its settlement window expires.</p>
      </header>

      <div className="cm-block">
        <h3>Current Batch</h3>
        <div className="cm-status-grid">
          <div className="cm-status-card">
            <span>Batch ID</span>
            <strong>{batchId === null ? 'Loading...' : batchId}</strong>
          </div>
          <div className="cm-status-card">
            <span>Settlement Window</span>
            <strong>{settlementWindow === null ? 'Loading...' : `${settlementWindow} seconds`}</strong>
          </div>
          <div className="cm-status-card">
            <span>Time Until Settlement</span>
            <strong>{countdownSeconds === null ? 'Loading...' : `${countdownSeconds}s`}</strong>
          </div>
        </div>

        <div className="cm-actions-row">
          <button onClick={settleBatch} disabled={busy || !isExpired}>
            {busy ? 'Settling...' : 'Settle Batch'}
          </button>
        </div>
        <p className="cm-hint">
          {!loaded
            ? 'Reading settlement status from the network...'
            : countdownSeconds !== null && countdownSeconds > 0
              ? `Settlement is available in ${countdownSeconds} seconds.`
              : 'The settlement window has expired. Anyone can settle this batch.'}
        </p>
        {feedback ? <p className="cm-feedback">{feedback}</p> : null}
      </div>
    </section>
  );
}

export default SettlementView;