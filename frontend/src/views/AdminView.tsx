import { useAdmin } from '../hooks/useAdmin';
import { useReadContract } from 'wagmi';
import { useState } from 'react';
import ComplianceABI from '../abis/ComplianceManager.json';

const COMPLIANCE_ADDR = import.meta.env.VITE_COMPLIANCE_MANAGER_ADDRESS as `0x${string}`;

export default function AdminView() {
  const { isOperator, isPaused, togglePause, manualSettle, timeLeft, blacklistToken, setUserStatus, grantOperator } = useAdmin();
  const { data: OPERATOR_ROLE } = useReadContract({ address: COMPLIANCE_ADDR, abi: ComplianceABI.abi, functionName: 'OPERATOR_ROLE' });

  const [tokenAddr, setTokenAddr] = (useState as any)('');
  const [userAddr, setUserAddr] = (useState as any)('');
  const [newOperator, setNewOperator] = (useState as any)('');
  const [selectedStatus, setSelectedStatus] = useState<number>(0);

  if (!isOperator) {
    return (
      <div className="card text-center">
        <h3>Access Restricted</h3>
        <p className="muted">Only accounts with the operator role can access these controls.</p>
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
          <p className="muted">Settlement can run automatically later, but you can force a batch manually during local testing.</p>
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
          <p className="muted">Pausing stops deposits and order placements while leaving already pending reveal flows intact.</p>
          <button 
            className={`btn-primary mt-20 ${isPaused ? 'btn-unpause' : 'btn-pause'}`} 
            onClick={togglePause}
          >
            {isPaused ? 'Resume All Systems' : 'Emergency Stop'}
          </button>
        </div>
      </div>

      <div className="grid-2 mt-20">
        <section className="card">
          <h3>Blacklist Token</h3>
          <p className="muted">Blacklist a token address to prevent future deposits/trades.</p>
          <div className="input-group">
            <label>Token address</label>
            <input value={tokenAddr} onChange={(e:any)=>setTokenAddr(e.target.value)} placeholder="0x..." />
          </div>
          <div className="button-group">
            <button className="btn-primary" onClick={() => blacklistToken?.(tokenAddr)} disabled={!tokenAddr}>Blacklist</button>
          </div>
        </section>

        <section className="card">
          <h3>User Controls</h3>
          <p className="muted">Set user status.</p>
          <div className="input-group">
            <label>User address</label>
            <input value={userAddr} onChange={(e:any)=>setUserAddr(e.target.value)} placeholder="0x..." />
          </div>
          
          <div className="input-group">
            <label>Set status</label>
            <select value={String(selectedStatus)} onChange={(e:any)=>setSelectedStatus(Number(e.target.value))}>
              <option value={0}>Active</option>
              <option value={1}>BlacklistedWithWithdrawal</option>
              <option value={2}>Blacklisted</option>
            </select>
          </div>
          <div className="button-group">
            <button className="btn-primary" onClick={() => setUserStatus?.(userAddr, selectedStatus)} disabled={!userAddr}>Set Status</button>
          </div>
        </section>
      </div>

      <section className="card mt-20">
        <h3>Operator Management</h3>
        <p className="muted">Grant operator role to an address (requires admin privileges).</p>
        <div className="input-group">
          <label>Operator address</label>
          <input value={newOperator} onChange={(e:any)=>setNewOperator(e.target.value)} placeholder="0x..." />
        </div>
        <div className="button-group">
          <button className="btn-primary" onClick={() => grantOperator?.(OPERATOR_ROLE as `0x${string}`, newOperator)} disabled={!newOperator}>Add Operator</button>
        </div>
      </section>
    </div>
  );
}