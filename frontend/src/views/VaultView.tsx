import { useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { formatEther, formatUnits, parseEther, parseUnits } from 'viem';

import CustodianABI from '../abis/Custodian.json';
import ERC20ABI from '../abis/MockERC20.json';
import { useTokenManager } from '../hooks/useTokenManager';
import './Views.css';

const CUSTODIAN_ADDR = import.meta.env.VITE_CUSTODIAN_ADDRESS as `0x${string}`;
const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

type Activity = 'idle' | 'eth-deposit' | 'eth-withdraw' | 'erc20-deposit' | 'erc20-withdraw' | 'nft-deposit' | 'nft-withdraw';

export default function VaultView() {
  const { address } = useAccount();
  const { allTokens, discoverToken } = useTokenManager();
  const { writeContractAsync } = useWriteContract();

  const erc20Tokens = useMemo(
    () => allTokens.filter((token) => token.address.toLowerCase() !== ETH_SENTINEL.toLowerCase()),
    [allTokens],
  );

  const [activity, setActivity] = useState<Activity>('idle');
  const [ethAmount, setEthAmount] = useState('');
  const [erc20Amount, setErc20Amount] = useState('');
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<`0x${string}` | ''>('');
  const [customTokenAddress, setCustomTokenAddress] = useState('');
  const [erc20ReceiveEth, setErc20ReceiveEth] = useState(false);
  const [nftCollection, setNftCollection] = useState('');
  const [nftTokenId, setNftTokenId] = useState('');

  useEffect(() => {
    if (!selectedTokenAddress && erc20Tokens[0]) {
      setSelectedTokenAddress(erc20Tokens[0].address as `0x${string}`);
    }
  }, [erc20Tokens, selectedTokenAddress]);

  const selectedToken = useMemo(
    () => erc20Tokens.find((token) => token.address.toLowerCase() === selectedTokenAddress.toLowerCase()) ?? erc20Tokens[0] ?? null,
    [erc20Tokens, selectedTokenAddress],
  );

  const { data: ethAvailableRaw } = useReadContract({
    address: CUSTODIAN_ADDR,
    abi: CustodianABI.abi,
    functionName: 'balanceOf',
    args: address ? [address, ETH_SENTINEL as `0x${string}`] : undefined,
    query: { enabled: !!address },
  });

  const { data: ethLockedRaw } = useReadContract({
    address: CUSTODIAN_ADDR,
    abi: CustodianABI.abi,
    functionName: 'lockedBalanceOf',
    args: address ? [address, ETH_SENTINEL as `0x${string}`] : undefined,
    query: { enabled: !!address },
  });

  const { data: erc20BalancesRaw } = useReadContract({
    address: CUSTODIAN_ADDR,
    abi: CustodianABI.abi,
    functionName: 'fullBalanceOf',
    args: address && selectedToken ? [address, selectedToken.address as `0x${string}`] : undefined,
    query: { enabled: !!address && !!selectedToken },
  });

  const { data: nftStatusRaw } = useReadContract({
    address: CUSTODIAN_ADDR,
    abi: CustodianABI.abi,
    functionName: 'nftBalanceOf',
    args: address && nftCollection && nftTokenId ? [address, nftCollection as `0x${string}`, BigInt(nftTokenId)] : undefined,
    query: { enabled: !!address && !!nftCollection && !!nftTokenId },
  });

  const ethAvailable = ethAvailableRaw ? formatEther(ethAvailableRaw as bigint) : '0';
  const ethLocked = ethLockedRaw ? formatEther(ethLockedRaw as bigint) : '0';
  const [erc20AvailableRaw, erc20LockedRaw] = (erc20BalancesRaw ?? [0n, 0n]) as readonly [bigint, bigint];
  const erc20Available = selectedToken ? formatUnits(erc20AvailableRaw, selectedToken.decimals) : '0';
  const erc20Locked = selectedToken ? formatUnits(erc20LockedRaw, selectedToken.decimals) : '0';
  const [nftHeldRaw, nftLockedRaw] = (nftStatusRaw ?? [false, false]) as readonly [boolean, boolean];

  const isBusy = activity !== 'idle';
  const selectedTokenLabel = selectedToken ? `${selectedToken.symbol} (${selectedToken.name})` : 'No token selected';

  const discoverCustomToken = async () => {
    if (!customTokenAddress.startsWith('0x')) {
      return;
    }

    const token = await discoverToken(customTokenAddress as `0x${string}`);
    if (token) {
      setSelectedTokenAddress(token.address as `0x${string}`);
      setCustomTokenAddress('');
    }
  };

  const depositEth = async () => {
    if (!ethAmount) return;

    try {
      setActivity('eth-deposit');
      await writeContractAsync({
        address: CUSTODIAN_ADDR,
        abi: CustodianABI.abi,
        functionName: 'depositETH',
        value: parseEther(ethAmount),
      });
      setEthAmount('');
    } catch (error) {
      console.error('ETH deposit failed:', error);
    } finally {
      setActivity('idle');
    }
  };

  const withdrawEth = async () => {
    if (!ethAmount) return;

    try {
      setActivity('eth-withdraw');
      await writeContractAsync({
        address: CUSTODIAN_ADDR,
        abi: CustodianABI.abi,
        functionName: 'withdrawETH',
        args: [parseEther(ethAmount)],
      });
      setEthAmount('');
    } catch (error) {
      console.error('ETH withdraw failed:', error);
    } finally {
      setActivity('idle');
    }
  };

  const depositErc20 = async () => {
    if (!selectedToken || !erc20Amount) return;

    try {
      setActivity('erc20-deposit');
      const tokenAmount = parseUnits(erc20Amount, selectedToken.decimals);

      await writeContractAsync({
        address: selectedToken.address as `0x${string}`,
        abi: ERC20ABI.abi,
        functionName: 'approve',
        args: [CUSTODIAN_ADDR, tokenAmount],
      });

      await writeContractAsync({
        address: CUSTODIAN_ADDR,
        abi: CustodianABI.abi,
        functionName: 'deposit',
        args: [selectedToken.address as `0x${string}`, tokenAmount],
      });

      setErc20Amount('');
    } catch (error) {
      console.error('ERC20 deposit failed:', error);
    } finally {
      setActivity('idle');
    }
  };

  const withdrawErc20 = async () => {
    if (!selectedToken || !erc20Amount) return;

    try {
      setActivity('erc20-withdraw');
      const tokenAmount = parseUnits(erc20Amount, selectedToken.decimals);

      await writeContractAsync({
        address: CUSTODIAN_ADDR,
        abi: CustodianABI.abi,
        functionName: 'withdraw',
        args: [selectedToken.address as `0x${string}`, tokenAmount, erc20ReceiveEth],
      });

      setErc20Amount('');
    } catch (error) {
      console.error('ERC20 withdraw failed:', error);
    } finally {
      setActivity('idle');
    }
  };

  const depositNft = async () => {
    if (!nftCollection || !nftTokenId) return;

    try {
      setActivity('nft-deposit');
      await writeContractAsync({
        address: CUSTODIAN_ADDR,
        abi: CustodianABI.abi,
        functionName: 'depositNFT',
        args: [nftCollection as `0x${string}`, BigInt(nftTokenId)],
      });
      setNftTokenId('');
    } catch (error) {
      console.error('NFT deposit failed:', error);
    } finally {
      setActivity('idle');
    }
  };

  const withdrawNft = async () => {
    if (!nftCollection || !nftTokenId) return;

    try {
      setActivity('nft-withdraw');
      await writeContractAsync({
        address: CUSTODIAN_ADDR,
        abi: CustodianABI.abi,
        functionName: 'withdrawNFT',
        args: [nftCollection as `0x${string}`, BigInt(nftTokenId)],
      });
      setNftTokenId('');
    } catch (error) {
      console.error('NFT withdraw failed:', error);
    } finally {
      setActivity('idle');
    }
  };

  return (
    <div className="view-inner">
      <header className="view-header">
        <p className="eyebrow">Custodian</p>
        <h2>Hold ETH, ERC20 tokens, and NFTs in separate buckets</h2>
        <p>
          The UI keeps the contract surface explicit: check balances, deposit assets, and withdraw them from the
          custodian without extra steps.
        </p>
      </header>

      <div className="grid-2">
        <section className="card">
          <h3>ETH</h3>
          <div className="stat-row">
            <span>Available</span>
            <span className="value">{ethAvailable} ETH</span>
          </div>
          <div className="stat-row">
            <span>Locked</span>
            <span className="value">{ethLocked} ETH</span>
          </div>
          <div className="input-group">
            <label>Amount</label>
            <input type="number" min="0" step="any" value={ethAmount} onChange={(event) => setEthAmount(event.target.value)} placeholder="0.0" />
          </div>
          <div className="button-group">
            <button className="btn-primary" onClick={depositEth} disabled={isBusy || !ethAmount}>
              Deposit ETH
            </button>
            <button className="btn-outline" onClick={withdrawEth} disabled={isBusy || !ethAmount}>
              Withdraw ETH
            </button>
          </div>
        </section>

        <section className="card">
          <h3>ERC20</h3>
          <p className="helper-text">Use the token list for registered assets or paste a custom token address to check it first.</p>

          <div className="input-group">
            <label>Token</label>
            <select
              value={selectedTokenAddress}
              onChange={(event) => setSelectedTokenAddress(event.target.value as `0x${string}`)}
              disabled={!erc20Tokens.length}
            >
              {erc20Tokens.map((token) => (
                <option key={token.address} value={token.address}>
                  {token.symbol} - {token.name}
                </option>
              ))}
            </select>
          </div>

          <div className="inline-row">
            <input
              value={customTokenAddress}
              onChange={(event) => setCustomTokenAddress(event.target.value)}
              placeholder="Paste a custom token address"
            />
            <button className="btn-outline" onClick={discoverCustomToken} disabled={isBusy || !customTokenAddress}>
              Check token
            </button>
          </div>

          <div className="stat-row">
            <span>Selected token</span>
            <span className="value">{selectedTokenLabel}</span>
          </div>
          <div className="stat-row">
            <span>Available</span>
            <span className="value">
              {erc20Available} {selectedToken?.symbol ?? ''}
            </span>
          </div>
          <div className="stat-row">
            <span>Locked</span>
            <span className="value">
              {erc20Locked} {selectedToken?.symbol ?? ''}
            </span>
          </div>

          <div className="input-group">
            <label>Amount</label>
            <input type="number" min="0" step="any" value={erc20Amount} onChange={(event) => setErc20Amount(event.target.value)} placeholder="0.0" />
          </div>

          <label className="checkbox-row">
            <input type="checkbox" checked={erc20ReceiveEth} onChange={(event) => setErc20ReceiveEth(event.target.checked)} />
            Receive ETH on withdraw when the contract supports it
          </label>

          <div className="button-group mt-20">
            <button className="btn-primary" onClick={depositErc20} disabled={isBusy || !selectedToken || !erc20Amount}>
              Deposit token
            </button>
            <button className="btn-outline" onClick={withdrawErc20} disabled={isBusy || !selectedToken || !erc20Amount}>
              Withdraw token
            </button>
          </div>
        </section>

        <section className="card full-width">
          <h3>NFTs</h3>
          <div className="grid-2">
            <div>
              <div className="input-group">
                <label>Collection address</label>
                <input value={nftCollection} onChange={(event) => setNftCollection(event.target.value)} placeholder="0x..." />
              </div>
              <div className="input-group">
                <label>Token ID</label>
                <input type="number" min="0" step="1" value={nftTokenId} onChange={(event) => setNftTokenId(event.target.value)} placeholder="1" />
              </div>
            </div>
            <div>
              <div className="stat-row">
                <span>Held</span>
                <span className="value">{nftHeldRaw ? 'Yes' : 'No'}</span>
              </div>
              <div className="stat-row">
                <span>Locked</span>
                <span className="value">{nftLockedRaw ? 'Yes' : 'No'}</span>
              </div>
              <p className="helper-text">The custodian keeps NFTs separate from fungible balances. "Held" means the custodian owns that token for your account; "Locked" means it has been reserved by an order or action and cannot be withdrawn until released.</p>
            </div>
          </div>

          <div className="button-group mt-20">
            <button className="btn-primary" onClick={depositNft} disabled={isBusy || !nftCollection || !nftTokenId}>
              Deposit NFT
            </button>
            <button className="btn-outline" onClick={withdrawNft} disabled={isBusy || !nftCollection || !nftTokenId}>
              Withdraw NFT
            </button>
          </div>
        </section>
      </div>

      <section className="card full-width">
        <h3>Lending pool</h3>
        <p className="muted">
          This can stay as a small status block for now: show pool details only if you want them on the page, but the
          core custody flow does not depend on it.
        </p>
      </section>
    </div>
  );
}
