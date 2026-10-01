import { useState, useMemo } from 'react';
import { useAccount, useReadContract } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import OverviewView from './views/OverviewView';
import ComplianceManagerView from './views/ComplianceManagerView';
import CustodianView from './views/CustodianView';
import FungibleOrderbookView from './views/FungibleOrderbookView';
import NFTOrderbookView from './views/NFTOrderbookView';
import MarketHistoryView from './views/MarketHistoryView.tsx';
import SettlementView from './views/SettlementView';
import { COMPLIANCE_MANAGER_CONTRACT } from './constants/contracts';
import './App.css';

type ViewId = 'overview' | 'custodian' | 'fungible-orderbook' | 'nft-orderbook' | 'market-history' | 'settlement' | 'compliance';

const ALL_VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'custodian', label: 'Custodian' },
  { id: 'fungible-orderbook', label: 'Fungible Orderbook' },
  { id: 'nft-orderbook', label: 'NFT Orderbook' },
  { id: 'market-history', label: 'Market History' },
  { id: 'settlement', label: 'Settlement' },
  { id: 'compliance', label: 'Compliance Manager' },
];

function App() {
  const { address, isConnected } = useAccount();
  const [activeView, setActiveView] = useState<ViewId>('overview');

  const { data: defaultAdminRoleRaw } = useReadContract({
    ...COMPLIANCE_MANAGER_CONTRACT,
    functionName: 'DEFAULT_ADMIN_ROLE',
  });

  const { data: isOperatorRaw } = useReadContract({
    ...COMPLIANCE_MANAGER_CONTRACT,
    functionName: 'hasOperatorRole',
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address },
  });

  const { data: isComplianceAdminRaw } = useReadContract({
    ...COMPLIANCE_MANAGER_CONTRACT,
    functionName: 'hasRole',
    args: address && defaultAdminRoleRaw ? [defaultAdminRoleRaw as `0x${string}`, address as `0x${string}`] : undefined,
    query: { enabled: !!address && !!defaultAdminRoleRaw },
  });

  const isOperator = useMemo(() => Boolean(isOperatorRaw), [isOperatorRaw]);
  const isComplianceAdmin = useMemo(() => Boolean(isComplianceAdminRaw), [isComplianceAdminRaw]);

  const VIEWS = useMemo(
    () => ALL_VIEWS.filter((view) => view.id !== 'compliance' || isOperator),
    [isOperator],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>SettleX</h1>
          <h2>Trade Fast. Settle Smarter.</h2>
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

            <section hidden={activeView !== 'overview'}>
              <OverviewView />
            </section>
            <section hidden={activeView !== 'custodian'}>
              <CustodianView />
            </section>
            <section hidden={activeView !== 'fungible-orderbook'}>
              <FungibleOrderbookView />
            </section>
            <section hidden={activeView !== 'nft-orderbook'}>
              <NFTOrderbookView />
            </section>
            <section hidden={activeView !== 'market-history'}>
              <MarketHistoryView isRegulatorAllowed={isComplianceAdmin} />
            </section>
            <section hidden={activeView !== 'settlement'}>
              <SettlementView />
            </section>
            <section hidden={activeView !== 'compliance'}>
              <ComplianceManagerView />
            </section>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
