import { useState } from 'react';
import { useVault } from '../hooks/useVault';
import './Views.css';

export default function VaultView() {
  const { ethBalance, lockedEth, deposit, withdraw, isProcessing } = useVault();
  const [amount, setAmount] = useState('');

  const onDeposit = async () => {
    try {
      await deposit(amount);
      setAmount('');
    } catch (e) { console.error(e); }
  };

  return (
    <div className="view-inner">
      <header className="view-header">
        <h2>Vault & Portfolio</h2>
        <p>Manage your system collateral and track interest-bearing positions.</p>
      </header>

      <div className="grid-2">
        {/* Balance Card */}
        <div className="card">
          <h3>Asset Overview</h3>
          <div className="stat-row">
            <span>Available ETH</span>
            <span className="value">{ethBalance} ETH</span>
          </div>
          <div className="stat-row muted">
            <span>Locked in Orders</span>
            <span className="value">{lockedEth} ETH</span>
          </div>
          <div className="divider" />
          <p className="hint">Available funds can be used to place new orders or withdrawn.</p>
        </div>

        {/* Action Card */}
        <div className="card">
          <h3>Transact</h3>
          <div className="input-group">
            <label>Amount (ETH)</label>
            <input 
              type="number" 
              placeholder="0.0" 
              value={amount} 
              onChange={(e) => setAmount(e.target.value)} 
            />
          </div>
          <div className="button-group">
            <button className="btn-primary" onClick={onDeposit} disabled={isProcessing}>
              {isProcessing ? 'Processing...' : 'Deposit'}
            </button>
            <button className="btn-outline" onClick={() => withdraw(amount)} disabled={isProcessing}>
              Withdraw
            </button>
          </div>
        </div>
      </div>

      {/* Lending Pool Info Section */}
      <div className="card full-width mt-20">
        <h3>Lending Pool Integration</h3>
        <p className="muted">Your deposits are automatically moved to the Mock Lending Pool to earn yield when supported.</p>
      </div>
    </div>
  );
}