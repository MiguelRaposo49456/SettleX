import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import ComplianceManagerView from './views/ComplianceManagerView';
import './App.css';

function App() {
  const { address, isConnected } = useAccount();

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
            <ComplianceManagerView />
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
