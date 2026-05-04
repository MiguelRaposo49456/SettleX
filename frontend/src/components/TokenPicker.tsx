import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import validateTokenOnchain from '../hooks/useTokenValidation';
import type { TokenMetadata } from '../hooks/useTokenValidation';
import { usePublicClient } from 'wagmi';

type Props = {
  onSelect: (token: TokenMetadata) => void;
  onClose?: () => void;
};

type CoinGeckoCoin = {
  id: string;
  name: string;
  symbol: string;
  platforms: {
    ethereum?: string;
  };
};

function TokenPicker({ onSelect, onClose }: Props) {
  const publicClient = usePublicClient();
  const [query, setQuery] = useState('');
  const [coins, setCoins] = useState<CoinGeckoCoin[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [visibleCount, setVisibleCount] = useState(150);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=true')
      .then((response) => response.json() as Promise<CoinGeckoCoin[]>)
      .then((results) => {
        if (cancelled) return;
        setCoins(results);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load tokens');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setVisibleCount(150);
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const next = !q
      ? coins
      : coins.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.symbol.toLowerCase().includes(q) ||
            c.id.toLowerCase().includes(q)
        );
    return next;
  }, [coins, query]);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const [entry] = entries;
      if (entry?.isIntersecting) {
        setVisibleCount((current) => Math.min(current + 150, filtered.length));
      }
    });

    const target = document.getElementById('token-picker-sentinel');
    if (target) observer.observe(target);
    return () => observer.disconnect();
  }, [filtered.length]);

  async function selectCoin(coinId: string) {
    setError('');
    setLoading(true);
    try {
      const coin = coins.find((item) => item.id === coinId);
      const addr = coin?.platforms?.ethereum;
      if (!addr) {
        setError('CoinGecko has no Ethereum contract address for this token. Use custom address.');
        return;
      }
      const meta = await validateTokenOnchain(publicClient, addr as `0x${string}`);
      onSelect(meta);
      onClose?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to select token');
    } finally {
      setLoading(false);
    }
  }

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    zIndex: 9999,
  };

  const boxStyle: CSSProperties = {
    background: 'white',
    borderRadius: 8,
    padding: 16,
    width: 'min(760px, 96%)',
    maxHeight: '86vh',
    overflow: 'auto',
    boxShadow: '0 8px 24px rgba(0,0,0,0.2)'
  };

  const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };

  return (
    <div style={overlayStyle} onClick={() => onClose?.()}>
      <div style={boxStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0 }}>Select token</h3>
          <button onClick={() => onClose?.()}>Close</button>
        </div>

        <div>
          <input style={{ width: '100%', padding: 8, marginBottom: 8 }} placeholder="Search by name or symbol" value={query} onChange={(e) => setQuery(e.target.value)} />
          {loading ? <div>Loading...</div> : null}
          {error ? <div className="error">{error}</div> : null}
          <ul className="coin-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {filtered.slice(0, visibleCount).map((c) => (
              <li key={c.id} style={{ marginBottom: 6 }}>
                <button style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6 }} onClick={() => selectCoin(c.id)}>
                  {c.name} ({c.symbol})
                </button>
              </li>
            ))}
          </ul>
          <div id="token-picker-sentinel" style={{ height: 1 }} />
        </div>
      </div>
    </div>
  );
}

export default TokenPicker;
