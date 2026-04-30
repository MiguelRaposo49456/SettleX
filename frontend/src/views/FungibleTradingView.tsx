import { useState } from 'react';
import { useTrading } from '../hooks/useTrading';
import { useTokenManager } from '../hooks/useTokenManager';

export default function TradingView() {
  const { tokens, setSearchQuery, discoverToken } = useTokenManager();
  const { createOrder, status } = useTrading();
  
  const [tokenIn, setTokenIn] = useState(tokens[0]); // Default to ETH
  const [tokenOut, setTokenOut] = useState(tokens[0]);
  const [amountIn, setAmountIn] = useState('');
  const [amountOut, setAmountOut] = useState('');
  const [isSelecting, setIsSelecting] = useState<'in' | 'out' | null>(null);

  const handleSelect = (token: any) => {
    if (isSelecting === 'in') setTokenIn(token);
    if (isSelecting === 'out') setTokenOut(token);
    setIsSelecting(null);
  };

  const onPlaceOrder = () => {
    createOrder(tokenIn, tokenOut, amountIn, amountOut, 0);
  };

  return (
    <div className="view-inner">
      <div className="grid-2">
        {/* Main Trading Card */}
        <div className="card">
          <h3>Swap Assets</h3>
          
          <div className="swap-box">
            <div className="token-select-field" onClick={() => setIsSelecting('out')}>
              <label>You Give</label>
              <div className="token-info">
                <span>{tokenOut.symbol}</span>
                <input 
                  type="number" 
                  placeholder="0.0" 
                  value={amountOut} 
                  onChange={(e) => setAmountOut(e.target.value)} 
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>

            <div className="swap-divider">↓</div>

            <div className="token-select-field" onClick={() => setIsSelecting('in')}>
              <label>You Receive</label>
              <div className="token-info">
                <span>{tokenIn.symbol}</span>
                <input 
                  type="number" 
                  placeholder="0.0" 
                  value={amountIn} 
                  onChange={(e) => setAmountIn(e.target.value)} 
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          </div>

          <button className="btn-primary mt-20" onClick={onPlaceOrder} disabled={status !== 'idle'}>
            {status === 'idle' ? 'Place Order' : status.toUpperCase()}
          </button>
        </div>

        {/* Token Selector Modal (Overlay) */}
        {isSelecting && (
          <div className="modal-overlay">
            <div className="modal-card">
              <header>
                <h4>Select a Token</h4>
                <button onClick={() => setIsSelecting(null)}>✕</button>
              </header>
              <input 
                type="text" 
                placeholder="Search symbol or paste address" 
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (e.target.value.startsWith('0x')) discoverToken(e.target.value as `0x${string}`);
                }}
              />
              <div className="token-list">
                {tokens.map(t => (
                  <div key={t.address} className="token-item" onClick={() => handleSelect(t)}>
                    <strong>{t.symbol}</strong>
                    <small>{t.name}</small>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="card">
          <h3>Protocol Insights</h3>
          <p className="muted">Your trade will be committed to the orderbook and revealed automatically after one block to prevent MEV and front-running.</p>
        </div>
      </div>
    </div>
  );
}