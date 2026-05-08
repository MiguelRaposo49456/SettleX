import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import ComplianceManagerView from './views/ComplianceManagerView';
import CustodianView from './views/CustodianView';
import FungibleOrderbookView from './views/FungibleOrderbookView';
import NFTOrderbookView from './views/NFTOrderbookView';
import './App.css';

type ViewId = 'compliance' | 'fungible-orderbook' | 'nft-orderbook' | 'custodian';

const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: 'compliance', label: 'Compliance Manager' },
  { id: 'fungible-orderbook', label: 'Fungible Orderbook' },
  { id: 'nft-orderbook', label: 'NFT Orderbook' },
  { id: 'custodian', label: 'Custodian' },
];

function App() {
  const { address, isConnected } = useAccount();
  const [activeView, setActiveView] = useState<ViewId>('compliance');

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Blockchain Trading Frontend</h1>
          <p>Custodian, orderbooks, and settlement engine.</p>
        </div>
        <div className="connect-box">
          <ConnectButton />
        </div>
      </header>

      <main className="content">
        {!isConnected ? (
          <section className="hero">
            <h2>Connect wallet to start</h2>
            <p>Connect your wallet to interact with the smart contracts.</p>
          </section>
        ) : (
          <section className="dashboard">
            <h2>Dashboard</h2>
            <p>Connected address: <code>{address}</code></p>
            <nav className="section-tabs" aria-label="Contract views">
              {VIEWS.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  className={activeView === view.id ? 'active' : ''}
                  onClick={() => setActiveView(view.id)}
                  aria-pressed={activeView === view.id}
                >
                  {view.label}
                </button>
              ))}
            </nav>

            <section hidden={activeView !== 'compliance'}>
              <ComplianceManagerView />
            </section>
            <section hidden={activeView !== 'fungible-orderbook'}>
              <FungibleOrderbookView />
            </section>
            <section hidden={activeView !== 'nft-orderbook'}>
              <NFTOrderbookView />
            </section>
            <section hidden={activeView !== 'custodian'}>
              <CustodianView />
            </section>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
