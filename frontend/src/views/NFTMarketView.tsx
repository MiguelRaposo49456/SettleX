import { useState } from 'react';
import { useNFTMarket } from '../hooks/useNFTMarket';

export default function NFTMarketView() {
  const { createNFTAction, status } = useNFTMarket();
  const [viewMode, setViewMode] = useState<'browse' | 'create'>('browse');
  
  // Form State
  const [collection, setCollection] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [price, setPrice] = useState('');
  const [offerType, setOfferType] = useState<'erc20' | 'erc721'>('erc20');
  const [offerToken, setOfferToken] = useState('');
  const [offerTokenId, setOfferTokenId] = useState('');
  const [listingPaymentType, setListingPaymentType] = useState<'erc20' | 'erc721'>('erc20');
  const [listingPaymentToken, setListingPaymentToken] = useState('');
  const [listingPaymentAmount, setListingPaymentAmount] = useState('');
  const [listingPaymentTokenId, setListingPaymentTokenId] = useState('');

  const handleListNFT = (e: React.FormEvent) => {
    e.preventDefault();
    const assetType = listingPaymentType === 'erc20' ? 0 : 1;
    const paymentTokenAddr = listingPaymentToken as `0x${string}`;
    const paymentAmount = listingPaymentType === 'erc20' ? (BigInt(listingPaymentAmount || '0') * (BigInt(10) ** BigInt(18))) : 0n;
    const paymentTokenIdVal = listingPaymentType === 'erc721' ? BigInt(listingPaymentTokenId || '0') : 0n;

    createNFTAction('list', {
      collection: collection as `0x${string}`,
      tokenId: BigInt(tokenId || '0'),
      assetType: assetType,
      paymentToken: paymentTokenAddr,
      paymentAmount: paymentAmount,
      paymentTokenId: paymentTokenIdVal
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
                <label>Payment Type</label>
                <select value={listingPaymentType} onChange={(e) => setListingPaymentType(e.target.value as 'erc20' | 'erc721')}>
                  <option value="erc20">ERC20 (ask for tokens)</option>
                  <option value="erc721">ERC721 (ask for another NFT)</option>
                </select>
              </div>

              <div className="input-group">
                <label>{listingPaymentType === 'erc20' ? 'ERC20 Token Address' : 'Requested NFT Collection'}</label>
                <input type="text" value={listingPaymentToken} onChange={(e) => setListingPaymentToken(e.target.value)} placeholder="0x..." />
              </div>

              {listingPaymentType === 'erc20' ? (
                <div className="input-group">
                  <label>Asked Amount (tokens)</label>
                  <input type="number" value={listingPaymentAmount} onChange={(e) => setListingPaymentAmount(e.target.value)} placeholder="Amount in units" />
                </div>
              ) : (
                <div className="input-group">
                  <label>Requested Token ID</label>
                  <input type="number" value={listingPaymentTokenId} onChange={(e) => setListingPaymentTokenId(e.target.value)} placeholder="Token ID" />
                </div>
              )}
              <button type="submit" className="btn-primary" disabled={status !== 'idle'}>
                {status === 'idle' ? 'Submit Listing' : 'Processing...'}
              </button>
            </form>
          </div>
          
          <div className="card">
            <h3>Create Offer</h3>
            <form onSubmit={(e) => { e.preventDefault();
                // Build params matching the NFTOrderbook commit/reveal shape
                const assetType = offerType === 'erc20' ? 0 : 1; // 0 = ERC20, 1 = ERC721
                const paymentTokenAddr = offerToken as `0x${string}`;
                const paymentAmount = offerType === 'erc20' ? (BigInt(price || '0') * (BigInt(10) ** BigInt(18))) : 0n;
                const paymentTokenIdVal = offerType === 'erc721' ? BigInt(offerTokenId || '0') : 0n;

                createNFTAction('offer', {
                  collection: collection as `0x${string}`,
                  tokenId: BigInt(tokenId || '0'),
                  assetType: assetType,
                  paymentToken: paymentTokenAddr,
                  paymentAmount: paymentAmount,
                  paymentTokenId: paymentTokenIdVal
                });
              }} className="mt-20">
              <div className="input-group">
                <label>Collection Address</label>
                <input type="text" value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="0x..." />
              </div>
              <div className="input-group">
                <label>Token ID</label>
                <input type="number" value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="1" />
              </div>

              <div className="input-group">
                <label>Offer Type</label>
                <select value={offerType} onChange={(e) => setOfferType(e.target.value as 'erc20' | 'erc721')}>
                  <option value="erc20">ERC20 (pay with tokens)</option>
                  <option value="erc721">ERC721 (offer another NFT)</option>
                </select>
              </div>

              <div className="input-group">
                <label>{offerType === 'erc20' ? 'ERC20 Token Address' : 'Offered NFT Collection'}</label>
                <input type="text" value={offerToken} onChange={(e) => setOfferToken(e.target.value)} placeholder="0x..." />
              </div>

              {offerType === 'erc20' ? (
                <div className="input-group">
                  <label>Offer Amount (tokens)</label>
                  <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Amount in units" />
                </div>
              ) : (
                <div className="input-group">
                  <label>Offered Token ID</label>
                  <input type="number" value={offerTokenId} onChange={(e) => setOfferTokenId(e.target.value)} placeholder="Token ID" />
                </div>
              )}

              <div className="button-group">
                <button type="submit" className="btn-primary" disabled={status !== 'idle'}>{status === 'idle' ? 'Create Offer' : 'Processing...'}</button>
              </div>
            </form>
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