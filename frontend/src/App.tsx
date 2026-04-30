import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';

import VaultView from './views/VaultView';
import TradingView from './views/FungibleTradingView';
import NFTMarketView from './views/NFTMarketView';
import AdminView from './views/AdminView';

import './App.css';

function App() {
  const { isConnected } = useAccount();
  const [activeTab, setActiveTab] = useState<'vault' | 'trading' | 'nft' | 'admin'>('vault');

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="logo">
          <h2>BatchDEX</h2>
          <span className="version">Thesis v1.0</span>
        </div>
        
        <nav>
          <button 
            className={activeTab === 'vault' ? 'active' : ''} 
            onClick={() => setActiveTab('vault')}
          >
            Vault & Portfolio
          </button>
          <button 
            className={activeTab === 'trading' ? 'active' : ''} 
            onClick={() => setActiveTab('trading')}
          >
            Trading Floor
          </button>
          <button 
            className={activeTab === 'nft' ? 'active' : ''} 
            onClick={() => setActiveTab('nft')}
          >
            NFT Marketplace
          </button>
          <button 
            className={activeTab === 'admin' ? 'active' : ''} 
            onClick={() => setActiveTab('admin')}
          >
            System Ops
          </button>
        </nav>

        <div className="sidebar-footer">
          <ConnectButton chainStatus="icon" showBalance={false} />
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        {!isConnected ? (
          <div className="hero-section">
            <h1>Welcome to the Batch Auction System</h1>
            <p>Connect your wallet to manage assets and place protected orders.</p>
            <div className="hero-connect">
               <ConnectButton />
            </div>
          </div>
        ) : (
          <div className="view-container">
            {activeTab === 'vault' && <VaultView />}
            {activeTab === 'trading' && <TradingView />}
            {activeTab === 'nft' && <NFTMarketView />}
            {activeTab === 'admin' && <AdminView />}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;