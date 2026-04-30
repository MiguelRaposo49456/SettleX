import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';

import VaultView from './views/VaultView';
import TradingView from './views/FungibleTradingView';
import NFTMarketView from './views/NFTMarketView';
import AdminView from './views/AdminView';

import './App.css';
import './views/Views.css';

type SectionId = 'custodian' | 'fungible' | 'nft' | 'operators';

const SECTIONS: Array<{
  id: SectionId;
  label: string;
  title: string;
  description: string;
}> = [
  {
    id: 'custodian',
    label: 'Custodian',
    title: 'Custodian',
    description: 'Deposit and withdraw ETH, ERC20 tokens, and NFTs with a clear available-versus-locked view.',
  },
  {
    id: 'fungible',
    label: 'Fungible orderbook',
    title: 'Fungible orderbook',
    description: 'Submit one-action orders, then let commit and reveal happen separately in the background.',
  },
  {
    id: 'nft',
    label: 'NFT orderbook',
    title: 'NFT orderbook',
    description: 'Create listings and offers for NFT trades with the same commit-reveal flow.',
  },
  {
    id: 'operators',
    label: 'Operators',
    title: 'Operators',
    description: 'Pause the system, manage operators, and review the settlement engine state.',
  },
];

function App() {
  const { isConnected } = useAccount();
  const [activeSection, setActiveSection] = useState<SectionId>('custodian');

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Blockchain trading frontend</p>
          <h1>TSS custody and trading in one simple interface</h1>
          <p className="topbar-copy">
            Local-first UI for the custodian, fungible orderbook, NFT orderbook, and operator controls.
          </p>
        </div>
        <div className="connect-box">
          <ConnectButton chainStatus="icon" showBalance={false} />
        </div>
      </header>

      {!isConnected ? (
        <main className="hero">
          <section className="hero-card">
            <p className="eyebrow">Connect a wallet to continue</p>
            <h2>Simple, contract-first UI</h2>
            <p>
              The app is organized around the actual on-chain modules: custodial deposits, ERC20 trading,
              NFT markets, and operator tools.
            </p>
            <div className="hero-actions">
              <ConnectButton />
            </div>
          </section>

          <section className="hero-grid">
            {SECTIONS.map((section) => (
              <article key={section.id} className="hero-mini-card">
                <h3>{section.label}</h3>
                <p>{section.description}</p>
              </article>
            ))}
          </section>
        </main>
      ) : (
        <main className="content-shell">
          <nav className="section-tabs" aria-label="Application sections">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                className={activeSection === section.id ? 'active' : ''}
                onClick={() => setActiveSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </nav>

          <section className="section-summary">
            <div>
              <p className="eyebrow">Current section</p>
              <h2>{SECTIONS.find((section) => section.id === activeSection)?.title}</h2>
              <p>{SECTIONS.find((section) => section.id === activeSection)?.description}</p>
            </div>
          </section>

          <section className="view-frame">
            {activeSection === 'custodian' && <VaultView />}
            {activeSection === 'fungible' && <TradingView />}
            {activeSection === 'nft' && <NFTMarketView />}
            {activeSection === 'operators' && <AdminView />}
          </section>
        </main>
      )}
    </div>
  );
}

export default App;
