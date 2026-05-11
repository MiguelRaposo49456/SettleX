import './OverviewView.css';

function OverviewView() {
  return (
    <section className="overview-panel">
      <header className="overview-header">
        <h2>Welcome to SettleX</h2>
        <p>Explore the different components of the Trading and Settlement System</p>
      </header>

      <div className="overview-grid">
        <div className="overview-card">
          <h3>Custodian</h3>
          <p>Oversee all asset deposits and withdrawals with confidence. Secure storage and full management of your digital assets in one place</p>
        </div>

        <div className="overview-card">
          <h3>Fungible Orderbook</h3>
          <p>Create and manage fungible token orders with full control. Execute limit orders, leverage commit-reveal protocols for transaction privacy, and trade fungible assets seamlessly</p>
        </div>

        <div className="overview-card">
          <h3>NFT Orderbook</h3>
          <p>Browse, list, and trade non-fungible tokens through a structured NFT ordering system for buying and selling unique digital assets</p>
        </div>

        <div className="overview-card">
          <h3>Compliance Manager</h3>
          <p>Operator-exclusive compliance controls for monitoring system blacklists, overseeing the settlement process, and managing liquidity pools</p>
        </div>
      </div>
    </section>
  );
}

export default OverviewView;
