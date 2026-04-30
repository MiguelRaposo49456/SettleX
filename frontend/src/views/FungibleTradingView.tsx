import { useEffect, useState } from 'react';
import { useTrading } from '../hooks/useTrading';
import { useTokenManager } from '../hooks/useTokenManager';

export default function TradingView() {
  const { tokens, setSearchQuery, discoverToken } = useTokenManager();
  const { createOrder, createTake, fetchRecentOrders, orders, status } = useTrading();

  const [activeTab, setActiveTab] = useState<'place' | 'orderbook'>('place');
  const [tokenIn, setTokenIn] = useState(tokens[0]); // Default to ETH
  const [tokenOut, setTokenOut] = useState(tokens[0]);
  const [amountIn, setAmountIn] = useState('');
  const [amountOut, setAmountOut] = useState('');
  const [isSelecting, setIsSelecting] = useState<'in' | 'out' | null>(null);
  const [partialAllowed, setPartialAllowed] = useState(true);
  const [side, setSide] = useState<number>(0);
  const [takeModal, setTakeModal] = useState<{ makerId: bigint | null; open: boolean; }>(() => ({ makerId: null, open: false }));
  const [takeAmount, setTakeAmount] = useState('');

  const handleSelect = (token: any) => {
    if (isSelecting === 'in') setTokenIn(token);
    if (isSelecting === 'out') setTokenOut(token);
    setIsSelecting(null);
  };

  const onPlaceOrder = () => {
    createOrder(tokenIn, tokenOut, amountIn, amountOut, side, partialAllowed);
  };

  useEffect(() => {
    fetchRecentOrders?.();
  }, []);

  const openTake = (makerId: any) => {
    setTakeModal({ makerId: BigInt(makerId), open: true });
    setTakeAmount('');
  };

  const confirmTake = async () => {
    if (!takeModal.makerId) return;
    await createTake(takeModal.makerId, takeAmount);
    setTakeModal({ makerId: null, open: false });
  };

  return (
    <div className="view-inner">
      <div className="grid-1">
        {/* Main Trading Card */}
        <div className="card full-width">
          <h3>Fungible Orderbook</h3>
          <div className="tabs">
            <button className={activeTab === 'place' ? 'active' : ''} onClick={() => setActiveTab('place')}>Place Order</button>
            <button className={activeTab === 'orderbook' ? 'active' : ''} onClick={() => setActiveTab('orderbook')}>Orderbook</button>
          </div>

          {activeTab === 'place' && (
            <>
              <div className="swap-box">
                <div className="token-select-field" onClick={() => setIsSelecting('out')}>
                  <label>You Give</label>
                  <div className="token-info">
                    <span>{tokenOut?.symbol}</span>
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
                    <span>{tokenIn?.symbol}</span>
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

              <div className="input-group">
                <label>Side</label>
                <select value={side} onChange={(e) => setSide(Number(e.target.value))}>
                  <option value={0}>BUY</option>
                  <option value={1}>SELL</option>
                </select>
              </div>

              <label className="checkbox-row">
                <input type="checkbox" checked={partialAllowed} onChange={(e) => setPartialAllowed(e.target.checked)} />
                Allow partial fills
              </label>

              <button className="btn-primary mt-20" onClick={onPlaceOrder} disabled={status !== 'idle'}>
                {status === 'idle' ? 'Place Order' : status.toUpperCase()}
              </button>
            </>
          )}

          {activeTab === 'orderbook' && (
            <div>
              <p className="muted">Recent orders (refreshed on open). Click "Take" to open taker flow.</p>
              <div className="order-list">
                {orders?.length ? orders.map((o: any, i: number) => (
                  <div key={i} className="order-item">
                    <div>
                      <strong>Order #{String(o.orderId ?? i)}</strong>
                      <div className="muted">maker: {o.client}</div>
                    </div>
                    <div>
                      <div>{o.amount?.toString?.() ?? ''} @ {o.price?.toString?.() ?? ''}</div>
                      <div className="inline-row">
                        <button className="btn-outline" onClick={() => openTake(o.orderId)}>Take</button>
                      </div>
                    </div>
                  </div>
                )) : <div className="muted">No orders found</div>}
              </div>
            </div>
          )}
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

        {/* Protocol Insights removed per user request */}
      </div>

      {/* Take modal */}
      {takeModal.open && (
        <div className="modal-overlay">
          <div className="modal-card">
            <header>
              <h4>Take Order #{takeModal.makerId?.toString()}</h4>
              <button onClick={() => setTakeModal({ makerId: null, open: false })}>✕</button>
            </header>
            <div className="input-group">
              <label>Taker amount (raw units)</label>
              <input value={takeAmount} onChange={(e) => setTakeAmount(e.target.value)} placeholder="e.g. 1000000000000000000" />
            </div>
            <div className="button-group">
              <button className="btn-primary" onClick={confirmTake}>Commit & Reveal Take</button>
              <button className="btn-outline" onClick={() => setTakeModal({ makerId: null, open: false })}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}