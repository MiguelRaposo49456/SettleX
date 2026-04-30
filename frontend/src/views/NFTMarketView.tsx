import { useState } from 'react';
import { useNFTMarket } from '../hooks/useNFTMarket';

export default function NFTMarketView() {
  const { createNFTAction, status, currentBlock } = useNFTMarket();
  const [viewMode, setViewMode] = useState<'browse' | 'create'>('browse');
  
  // Form State
  const [collection, setCollection] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [price, setPrice] = useState('');

  const handleListNFT = (e: React.FormEvent) => {
    e.preventDefault();
    createNFTAction('list', {
      collection: collection as `0x${string}`,
      tokenId: BigInt(tokenId),
      assetType: 0, // ERC20 payment
      paymentToken: import.meta.env.VITE_MOCK_USDT_ADDRESS as `0x${string}`,
      paymentAmount: BigInt(price) * BigInt(10**18),
      paymentTokenId: 0n
    });
  };

  return (
    <div className="view-inner">
      <header className="view-header">
        <h2>NFT Marketplace</h2>
        <div className="tabs">
          <button className={viewMode === 'browse' ? 'active' : ''} onClick={() => setViewMode('browse')}>Market Gallery</button>
          <button className={viewMode === 'create' ? 'active' : ''} onClick={() => setViewMode('create')}>List an NFT</button>
        </div>
      </header>

      {viewMode === 'create' ? (
        <div className="grid-2">
          <div className="card">
            <h3>Create New Listing</h3>
            <form onSubmit={handleListNFT} className="mt-20">
              <div className="input-group">
                <label>Collection Address</label>
                <input type="text" value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="0x..." />
              </div>
              <div className="input-group">
                <label>Token ID</label>
                <input type="number" value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="1" />
              </div>
              <div className="input-group">
                <label>Asking Price (USDT)</label>
                <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="100" />
              </div>
              <button type="submit" className="btn-primary" disabled={status !== 'idle'}>
                {status === 'idle' ? 'Submit Listing' : 'Processing...'}
              </button>
            </form>
          </div>
          
          <div className="card">
            <h3>Protocol Steps</h3>
            <div className="status-box">
              {status === 'idle' ? (
                <p className="muted">Listing an NFT requires transferring it to the Custodian and committing the price secret.</p>
              ) : (
                <div className="pulse-container">
                  <div className="pulse-ring"></div>
                  <p><strong>System Phase:</strong> {status.toUpperCase()}</p>
                  <small>Your NFT will be locked in the Custodian until revealed or cancelled.</small>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="card full-width">
          <h3>Active Listings</h3>
          <p className="muted">Currently monitoring the Orderbook for reveals...</p>
          {/* Map through list of listings fetched from NFTOrderbook events here */}
        </div>
      )}
    </div>
  );
}