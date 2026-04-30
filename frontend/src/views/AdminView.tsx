import { useAdmin } from '../hooks/useAdmin';

export default function AdminView() {
  const { isOperator, isPaused, togglePause, manualSettle, timeLeft } = useAdmin();

  if (!isOperator) {
    return (
      <div className="card text-center">
        <h3>Access Restricted</h3>
        <p className="muted">Only accounts with the OPERATOR_ROLE can access these controls[cite: 1].</p>
      </div>
    );
  }

  return (
    <div className="view-inner">
      <header className="view-header">
        <h2>System Operations</h2>
        <div className={`badge ${isPaused ? 'danger' : 'success'}`}>
          {isPaused ? 'SYSTEM PAUSED' : 'SYSTEM ACTIVE'}
        </div>
      </header>

      <div className="grid-2">
        {/* Settlement Control Card */}
        <div className="card">
          <h3>Settlement Engine</h3>
          <div className="countdown-box">
            <span className="label">Next Batch Settlement In:</span>
            <span className="big-value">{timeLeft}s</span>
          </div>
          <p className="hint">Settlement triggers automatically via Chainlink, but can be forced manually[cite: 5].</p>
          <button 
            className="btn-outline mt-20" 
            onClick={manualSettle} 
            disabled={timeLeft > 0}
          >
            Settle Batch Now
          </button>
        </div>

        {/* Compliance Card */}
        <div className="card">
          <h3>Circuit Breaker</h3>
          <p className="muted">Pausing stops all deposits and order placements but allows existing code reveals to process if windows are open[cite: 1, 3].</p>
          <button 
            className={`btn-primary mt-20 ${isPaused ? 'btn-unpause' : 'btn-pause'}`} 
            onClick={togglePause}
          >
            {isPaused ? 'Resume All Systems' : 'Emergency Stop'}
          </button>
        </div>
      </div>
    </div>
  );
}