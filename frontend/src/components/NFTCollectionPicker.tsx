import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { usePublicClient } from 'wagmi';
import validateNftCollectionOnchain from '../hooks/useNftValidation';
import type { NFTCollectionMetadata } from '../hooks/useNftValidation';

type Props = {
  onSelect: (collection: NFTCollectionMetadata) => void;
  onClose?: () => void;
};

type CoinGeckoNFTCollection = {
  id: string;
  name: string;
  symbol: string;
  contract_address?: string | null;
  asset_platform_id?: string | null;
};

function NFTCollectionPicker({ onSelect, onClose }: Props) {
  const publicClient = usePublicClient();
  
  const [query, setQuery] = useState('');
  const [collections, setCollections] = useState<CoinGeckoNFTCollection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [visibleCount, setVisibleCount] = useState(150);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('https://api.coingecko.com/api/v3/nfts/list')
      .then((response) => response.json() as Promise<CoinGeckoNFTCollection[]>)
      .then((results) => {
        if (cancelled) return;
        setCollections(results.filter((collection) => Boolean(collection.contract_address)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load NFT collections');
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
      ? collections
      : collections.filter(
          (collection) =>
            collection.name.toLowerCase().includes(q) ||
            collection.symbol.toLowerCase().includes(q) ||
            collection.id.toLowerCase().includes(q)
        );
    return next;
  }, [collections, query]);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const [entry] = entries;
      if (entry?.isIntersecting) {
        setVisibleCount((current) => Math.min(current + 150, filtered.length));
      }
    });

    const target = document.getElementById('nft-picker-sentinel');
    if (target) observer.observe(target);
    return () => observer.disconnect();
  }, [filtered.length]);

  async function selectCollection(collectionId: string) {
    setError('');
    setLoading(true);
    try {
      const collection = collections.find((item) => item.id === collectionId);
      const addr = collection?.contract_address;
      if (!addr) {
        setError('CoinGecko does not expose a contract address for this NFT collection. Use custom address.');
        return;
      }

      const meta = await validateNftCollectionOnchain(publicClient, addr as `0x${string}`);
      onSelect(meta);
      onClose?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to select NFT collection');
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
    boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
  };

  const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };

  return (
    <div style={overlayStyle} onClick={() => onClose?.()}>
      <div style={boxStyle} onClick={(event) => event.stopPropagation()}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0 }}>Select NFT collection</h3>
          <button onClick={() => onClose?.()}>Close</button>
        </div>

        <div>
          <input
            style={{ width: '100%', padding: 8, marginBottom: 8 }}
            placeholder="Search by name, symbol or id"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {loading ? <div>Loading...</div> : null}
          {error ? <div className="error">{error}</div> : null}
          <ul className="coin-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {filtered.slice(0, visibleCount).map((collection) => (
              <li key={collection.id} style={{ marginBottom: 6 }}>
                <button
                  style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6 }}
                  onClick={() => selectCollection(collection.id)}
                >
                  {collection.name} ({collection.symbol})
                  <div style={{ fontSize: 12, opacity: 0.72 }}>{collection.contract_address}</div>
                </button>
              </li>
            ))}
          </ul>
          <div id="nft-picker-sentinel" style={{ height: 1 }} />
        </div>
      </div>
    </div>
  );
}

export default NFTCollectionPicker;