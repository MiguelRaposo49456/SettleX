import { useState, useEffect, useMemo } from 'react';
import { usePublicClient } from 'wagmi';
import ERC20ABI from '../abis/MockERC20.json';

// The sentinel address used by the Custodian to identify Native ETH
const NATIVE_ETH = {
  address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  symbol: "ETH",
  name: "Native Ether",
  decimals: 18,
  logoURI: "https://ethereum.org/static/6b935ac22584f2963e38d32b6491297d/a8664/eth-diamond-black.png"
};

export function useTokenManager() {
  const [tokens, setTokens] = useState<any[]>([NATIVE_ETH]);
  const [searchQuery, setSearchQuery] = useState('');
  const publicClient = usePublicClient();

  useEffect(() => {
    // Fetching the CoinGecko list for popular tokens
    fetch('https://tokens.coingecko.com/uniswap/all.json')
      .then(res => res.json())
      .then(data => {
        // Filter out any duplicates of ETH and merge
        const apiTokens = data.tokens.filter((t: any) => t.symbol !== 'ETH');
        setTokens([NATIVE_ETH, ...apiTokens]);
      })
      .catch(() => console.log("Offline or API rate limited, using local tokens only."));
  }, []);

  const discoverToken = async (address: `0x${string}`) => {
    if (!publicClient || !address.startsWith('0x')) return;
    try {
      const [name, symbol, decimals] = await Promise.all([
        publicClient.readContract({ address, abi: ERC20ABI.abi, functionName: 'name' }),
        publicClient.readContract({ address, abi: ERC20ABI.abi, functionName: 'symbol' }),
        publicClient.readContract({ address, abi: ERC20ABI.abi, functionName: 'decimals' }),
      ]);
      const newToken = { address, name, symbol, decimals: Number(decimals) };
      setTokens(prev => [newToken, ...prev]);
      return newToken;
    } catch (e) {
      console.error("Invalid ERC20", e);
    }
  };

  const filteredTokens = useMemo(() => {
    return tokens.filter(t => 
      t.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.address.toLowerCase() === searchQuery.toLowerCase()
    );
  }, [tokens, searchQuery]);

  return { tokens: filteredTokens, setSearchQuery, discoverToken, allTokens: tokens };
}