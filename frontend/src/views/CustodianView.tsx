import { useState } from 'react';
import { useMemo } from 'react';
import { decodeEventLog } from 'viem';
import { parseEther, formatEther, parseUnits, formatUnits } from 'viem';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { CUSTODIAN_CONTRACT, LENDING_POOL_CONTRACT, COMPLIANCE_MANAGER_CONTRACT } from '../constants/contracts';
import validateTokenOnchain from '../hooks/useTokenValidation';
import validateNftCollectionOnchain from '../hooks/useNftValidation';
import type { TokenMetadata } from '../hooks/useTokenValidation';
import type { NFTCollectionMetadata } from '../hooks/useNftValidation';

const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function showContractError(error: unknown, fallbackMessage: string, presentError: (message: string) => void) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  presentError(message);
}

const CUSTODIAN_TABS = [
  { id: 'eth', label: 'ETH' },
  { id: 'erc20', label: 'ERC20' },
  { id: 'nft', label: 'NFT' },
] as const;

type CustodianTab = 'eth' | 'erc20' | 'nft';

function CustodianView() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [ethAmount, setEthAmount] = useState('');
  const [busyAction, setBusyAction] = useState(false);
  const [feedback, setFeedback] = useState('');
  
  const [selectedToken, setSelectedToken] = useState<TokenMetadata | null>(null);
  const [tokenAmount, setTokenAmount] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenFeedback, setTokenFeedback] = useState('');
  const [customAddr, setCustomAddr] = useState('');
  
  const [selectedNftCollection, setSelectedNftCollection] = useState<NFTCollectionMetadata | null>(null);
  const [nftTokenId, setNftTokenId] = useState('');
  const [nftBusy, setNftBusy] = useState(false);
  const [nftFeedback, setNftFeedback] = useState('');
  const [customNftAddr, setCustomNftAddr] = useState('');
  const [withdrawEthAmount, setWithdrawEthAmount] = useState('');
  const [withdrawAllEth, setWithdrawAllEth] = useState(false);
  const [withdrawEthBusy, setWithdrawEthBusy] = useState(false);
  const [withdrawEthFeedback, setWithdrawEthFeedback] = useState('');
  const [withdrawTokenAmount, setWithdrawTokenAmount] = useState('');
  const [withdrawAllToken, setWithdrawAllToken] = useState(false);
  const [withdrawTokenBusy, setWithdrawTokenBusy] = useState(false);
  const [withdrawTokenFeedback, setWithdrawTokenFeedback] = useState('');
  const [withdrawNftBusy, setWithdrawNftBusy] = useState(false);
  const [withdrawNftFeedback, setWithdrawNftFeedback] = useState('');
  
  const [activeTab, setActiveTab] = useState<CustodianTab>('eth');

  void feedback;
  void tokenFeedback;
  void nftFeedback;
  void withdrawEthFeedback;
  void withdrawTokenFeedback;
  void withdrawNftFeedback;

  const presentError = (message: string) => {
    // previously opened a modal; now only log to console to avoid interruptive popups
    // eslint-disable-next-line no-console
    console.error(message);
  };

  const parsedNftTokenId = useMemo(() => {
    try {
      return nftTokenId ? BigInt(nftTokenId) : undefined;
    } catch {
      return undefined;
    }
  }, [nftTokenId]);

  // read whether this NFT (client, collection, tokenId) is held by the custodian
  const { data: nftBalanceRaw, refetch: refetchNftBalance } = useReadContract({
    ...CUSTODIAN_CONTRACT,
    functionName: 'nftBalanceOf',
    args: address && selectedNftCollection && parsedNftTokenId !== undefined ? [address as `0x${string}`, selectedNftCollection.address, parsedNftTokenId] : undefined,
    query: { enabled: !!address && !!selectedNftCollection && parsedNftTokenId !== undefined, refetchInterval: 10_000 },
  });

  const nftHeld = Boolean((nftBalanceRaw as readonly [boolean, boolean] | undefined)?.[0]);
  const nftLocked = Boolean((nftBalanceRaw as readonly [boolean, boolean] | undefined)?.[1]);

  const { data: wethAddressRaw } = useReadContract({
    ...CUSTODIAN_CONTRACT,
    functionName: 'weth',
    query: { enabled: true },
  });

  const wethAddress = (wethAddressRaw as `0x${string}` | undefined) ?? (ZERO_ADDRESS as `0x${string}`);

  // --- Initialization and compliance checks ---
  const { data: isInitialized } = useReadContract({
    ...CUSTODIAN_CONTRACT,
    functionName: 'initialized',
    query: { enabled: true },
  });

  const { data: userAllowed } = useReadContract({
    ...COMPLIANCE_MANAGER_CONTRACT,
    functionName: 'isUserAllowed',
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address },
  });

  const { data: userStatusRaw } = useReadContract({
    ...COMPLIANCE_MANAGER_CONTRACT,
    functionName: 'userStatus',
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address },
  });

  const userStatus = Number(userStatusRaw ?? 0);

  const { data: aTokenAddressRaw, refetch: refetchAToken } = useReadContract({
    ...LENDING_POOL_CONTRACT,
    functionName: 'getAToken',
    args: [wethAddress],
    query: { enabled: wethAddress !== (ZERO_ADDRESS as `0x${string}`) },
  });

  const balanceTokenAddress = useMemo(() => {
    const maybeAToken = aTokenAddressRaw as `0x${string}` | undefined;
    if (maybeAToken && maybeAToken.toLowerCase() !== ZERO_ADDRESS) return maybeAToken;
    return ETH_SENTINEL as `0x${string}`;
  }, [aTokenAddressRaw]);

  const { data: depositedRaw, refetch: refetchDeposited } = useReadContract({
    ...CUSTODIAN_CONTRACT,
    functionName: 'balanceOf',
    args: address ? [address as `0x${string}`, balanceTokenAddress] : undefined,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });

  const { data: fullEthBalanceRaw, refetch: refetchFullEthBalance } = useReadContract({
    ...CUSTODIAN_CONTRACT,
    functionName: 'fullBalanceOf',
    args: address ? [address as `0x${string}`, balanceTokenAddress] : undefined,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });

  const ethAvailable = formatEther((fullEthBalanceRaw as readonly [bigint, bigint] | undefined)?.[0] ?? 0n);
  const ethLocked = formatEther((fullEthBalanceRaw as readonly [bigint, bigint] | undefined)?.[1] ?? 0n);
  const hasDepositedEth = Boolean(depositedRaw && (depositedRaw as bigint) > 0n);
  const canDepositEth = useMemo(() => {
    const trimmed = ethAmount.trim();
    if (!trimmed) return false;
    try {
      return parseEther(trimmed) > 0n;
    } catch {
      return false;
    }
  }, [ethAmount]);
  const canWithdrawEth = useMemo(() => {
    if (withdrawAllEth) return hasDepositedEth;
    const trimmed = withdrawEthAmount.trim();
    if (!trimmed) return false;
    try {
      return parseEther(trimmed) > 0n;
    } catch {
      return false;
    }
  }, [hasDepositedEth, withdrawAllEth, withdrawEthAmount]);

  const withdrawEth = async () => {
    if (!withdrawAllEth && !withdrawEthAmount) {
      setWithdrawEthFeedback('Enter an ETH amount first.');
      return;
    }

    let parsedAmount: bigint;
    try {
      parsedAmount = withdrawAllEth ? ((depositedRaw as bigint) ?? 0n) : parseEther(withdrawEthAmount);
    } catch {
      setWithdrawEthFeedback('Enter a valid ETH amount.');
      return;
    }

    if (parsedAmount <= 0n) {
      setWithdrawEthFeedback('Nothing to withdraw.');
      return;
    }

    try {
      setWithdrawEthBusy(true);

      const txHash = balanceTokenAddress === (ETH_SENTINEL as `0x${string}`)
        ? await writeContractAsync({
            ...CUSTODIAN_CONTRACT,
            functionName: 'withdrawETH',
            args: [parsedAmount],
          })
        : await writeContractAsync({
            ...CUSTODIAN_CONTRACT,
            functionName: 'withdraw',
            args: [balanceTokenAddress, parsedAmount, true],
          });

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
      }

      setWithdrawEthAmount('');
      await refetchAToken();
      await refetchDeposited();
      await refetchFullEthBalance?.();
    } catch (error) {
      showContractError(error, 'ETH withdraw failed', presentError);
    } finally {
      setWithdrawEthBusy(false);
    }
  };

  const depositEth = async () => {
    if (!canDepositEth) {
      setFeedback('Enter an ETH amount first.');
      return;
    }

    try {
      setBusyAction(true);
      const txHash = await writeContractAsync({
        ...CUSTODIAN_CONTRACT,
        functionName: 'depositETH',
        value: parseEther(ethAmount),
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
      }
      setEthAmount('');
      await refetchAToken();
      await refetchDeposited();
      await refetchFullEthBalance?.();
    } catch (error) {
      showContractError(error, 'Unknown deposit error', presentError);
    } finally {
      setBusyAction(false);
    }
  };

  // --- ERC20 deposit flows ---
  const { data: aTokenForSelectedRaw, refetch: refetchATokenForSelected } = useReadContract({
    ...LENDING_POOL_CONTRACT,
    functionName: 'getAToken',
    args: selectedToken ? [selectedToken.address] : undefined,
    query: { enabled: !!selectedToken },
  });

  const selectedBalanceKey = useMemo(() => {
    const maybe = aTokenForSelectedRaw as `0x${string}` | undefined;
    if (maybe && maybe.toLowerCase() !== ZERO_ADDRESS) return maybe;
    return selectedToken ? selectedToken.address : undefined;
  }, [aTokenForSelectedRaw, selectedToken]);

  const { data: depositedTokenRaw, refetch: refetchDepositedToken } = useReadContract({
    ...CUSTODIAN_CONTRACT,
    functionName: 'balanceOf',
    args: address && selectedBalanceKey ? [address as `0x${string}`, selectedBalanceKey] : undefined,
    query: { enabled: !!address && !!selectedBalanceKey },
  });

  const { data: fullTokenBalanceRaw, refetch: refetchFullTokenBalance } = useReadContract({
    ...CUSTODIAN_CONTRACT,
    functionName: 'fullBalanceOf',
    args: address && selectedBalanceKey ? [address as `0x${string}`, selectedBalanceKey] : undefined,
    query: { enabled: !!address && !!selectedBalanceKey, refetchInterval: 10_000 },
  });

  const tokenAvailable = selectedToken
    ? formatUnits((fullTokenBalanceRaw as readonly [bigint, bigint] | undefined)?.[0] ?? 0n, selectedToken.decimals)
    : '0';
  const tokenLocked = selectedToken
    ? formatUnits((fullTokenBalanceRaw as readonly [bigint, bigint] | undefined)?.[1] ?? 0n, selectedToken.decimals)
    : '0';
  const hasDepositedToken = Boolean(depositedTokenRaw && (depositedTokenRaw as bigint) > 0n);
  const canDepositToken = useMemo(() => {
    const trimmed = tokenAmount.trim();
    if (!trimmed || !selectedToken) return false;
    try {
      return parseUnits(trimmed, selectedToken.decimals) > 0n;
    } catch {
      return false;
    }
  }, [selectedToken, tokenAmount]);
  const canWithdrawToken = useMemo(() => {
    if (withdrawAllToken) return hasDepositedToken;
    if (!selectedToken) return false;
    const trimmed = withdrawTokenAmount.trim();
    if (!trimmed) return false;
    try {
      return parseUnits(trimmed, selectedToken.decimals) > 0n;
    } catch {
      return false;
    }
  }, [hasDepositedToken, selectedToken, withdrawAllToken, withdrawTokenAmount]);

  const withdrawErc20 = async () => {
    if (!selectedToken) {
      setWithdrawTokenFeedback('Select a token first');
      return;
    }
    if (!withdrawAllToken && !withdrawTokenAmount) {
      setWithdrawTokenFeedback('Enter token amount');
      return;
    }

    let parsedAmount: bigint;
    try {
      parsedAmount = withdrawAllToken ? ((depositedTokenRaw as bigint) ?? 0n) : parseUnits(withdrawTokenAmount, selectedToken.decimals);
    } catch {
      setWithdrawTokenFeedback('Enter a valid token amount');
      return;
    }

    if (parsedAmount <= 0n) {
      setWithdrawTokenFeedback('Nothing to withdraw');
      return;
    }

    try {
      setWithdrawTokenBusy(true);

      const txHash = await writeContractAsync({
        ...CUSTODIAN_CONTRACT,
        functionName: 'withdraw',
        args: [selectedBalanceKey ?? selectedToken.address, parsedAmount, false],
      });

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
      }

      setWithdrawTokenAmount('');
      await refetchATokenForSelected();
      await refetchDepositedToken();
      await refetchFullTokenBalance?.();
    } catch (error) {
      showContractError(error, 'Token withdraw failed', presentError);
    } finally {
      setWithdrawTokenBusy(false);
    }
  };

  const depositErc20 = async () => {
    if (!selectedToken) {
      setTokenFeedback('Select a token first');
      return;
    }
    if (!canDepositToken) {
      setTokenFeedback('Enter token amount');
      return;
    }

    try {
      setTokenBusy(true);
      // 1) Approve custodian to spend
      const parsed = parseUnits(tokenAmount, selectedToken.decimals);
      // approve on the token contract
      const approvalHash = await writeContractAsync({
        address: selectedToken.address,
        abi: [
          { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
        ],
        functionName: 'approve',
        args: [CUSTODIAN_CONTRACT.address, parsed],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: approvalHash });

      // 2) deposit
      const txHash = await writeContractAsync({
        ...CUSTODIAN_CONTRACT,
        functionName: 'deposit',
        args: [selectedToken.address, parsed],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: txHash });
      setTokenAmount('');
      await refetchATokenForSelected();
      await refetchDepositedToken();
      await refetchFullTokenBalance?.();
      setTokenFeedback('Token deposited successfully');
    } catch (err: any) {
      console.error('Deposit error:', err);
      setTokenFeedback('ERC20 deposit failed');
    } finally {
      setTokenBusy(false);
    }
  };

  const submitCustomToken = async () => {
    if (!customAddr) {
      setTokenFeedback('Enter a token address');
      return;
    }
    try {
      setTokenBusy(true);
      const meta = await validateTokenOnchain(publicClient, customAddr as `0x${string}`);
      setSelectedToken(meta);
    } catch (err: any) {
      showContractError(err, 'Validation failed', presentError);
    } finally {
      setTokenBusy(false);
    }
  };

  

  const depositNft = async () => {
    if (!selectedNftCollection) {
      setNftFeedback('Select an NFT collection first');
      return;
    }

    if (!nftTokenId) {
      setNftFeedback('Enter a token ID');
      return;
    }

    let parsedTokenId: bigint;
    try {
      parsedTokenId = BigInt(nftTokenId);
    } catch {
      setNftFeedback('Token ID must be an integer');
      return;
    }

    try {
      setNftBusy(true);
      const approvalHash = await writeContractAsync({
        address: selectedNftCollection.address,
        abi: [
          {
            name: 'setApprovalForAll',
            type: 'function',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'operator', type: 'address' },
              { name: 'approved', type: 'bool' },
            ],
            outputs: [],
          },
        ],
        functionName: 'setApprovalForAll',
        args: [CUSTODIAN_CONTRACT.address, true],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: approvalHash });

      const txHash = await writeContractAsync({
        ...CUSTODIAN_CONTRACT,
        functionName: 'depositNFT',
        args: [selectedNftCollection.address, parsedTokenId],
      });

      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        for (const log of receipt.logs) {
          try {
            const event = decodeEventLog({
              abi: CUSTODIAN_CONTRACT.abi,
              data: log.data,
              topics: log.topics,
            });
            if (event.eventName !== 'NFTDeposited') continue;

            const args = event.args as { client?: `0x${string}`; collection?: `0x${string}`; tokenId?: bigint };
            if (args.client?.toLowerCase() !== address?.toLowerCase()) continue;
            if (args.collection?.toLowerCase() !== selectedNftCollection.address.toLowerCase()) continue;
            if (args.tokenId === parsedTokenId) break;
          } catch {
            // Ignore unrelated logs.
          }
        }
      }

      setNftTokenId('');
      try {
        await refetchNftBalance?.();
      } catch {
        // ignore
      }
    } catch (error) {
      showContractError(error, 'NFT deposit failed', presentError);
    } finally {
      setNftBusy(false);
    }
  };

  const withdrawNft = async () => {
    if (!selectedNftCollection) {
      setWithdrawNftFeedback('Select an NFT collection first');
      return;
    }

    if (parsedNftTokenId === undefined) {
      setWithdrawNftFeedback('Enter a valid token ID');
      return;
    }

    try {
      setWithdrawNftBusy(true);

      const txHash = await writeContractAsync({
        ...CUSTODIAN_CONTRACT,
        functionName: 'withdrawNFT',
        args: [selectedNftCollection.address, parsedNftTokenId],
      });

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
      }

      await refetchNftBalance?.();
    } catch (error) {
      showContractError(error, 'NFT withdraw failed', presentError);
    } finally {
      setWithdrawNftBusy(false);
    }
  };

  const submitCustomNft = async () => {
    if (!customNftAddr) {
      setNftFeedback('Enter an NFT collection address');
      return;
    }
    try {
      setNftBusy(true);
      const meta = await validateNftCollectionOnchain(publicClient, customNftAddr as `0x${string}`);
      setSelectedNftCollection(meta);
    } catch (err: any) {
      showContractError(err, 'Validation failed', presentError);
    } finally {
      setNftBusy(false);
    }
  };

  

  return (
    <section className="cm-panel">
      <header className="cm-header">
        <h2>Custodian</h2>
        <p>Holds your funds for the trades within the TSS</p>
      </header>

      <div className="cm-status-grid">
        <div className="cm-status-card">
          <span>Your Access</span>
          <strong>
            {userStatus === 0 ? '✓ Allowed' : userStatus === 1 ? '⚠ Can only withdraw' : '✗ Not allowed'}
          </strong>
        </div>
        <div className="cm-status-card">
          <span>Your deposited ETH</span>
          <strong style={{ display: 'block' }}>{ethAvailable} available</strong>
          <strong style={{ display: 'block' }}>{ethLocked} locked</strong>
        </div>
        {activeTab === 'erc20' && selectedToken ? (
          <div className="cm-status-card">
            <span>Your deposited {selectedToken.symbol}</span>
            <strong style={{ display: 'block' }}>{tokenAvailable} available</strong>
            <strong style={{ display: 'block' }}>{tokenLocked} locked</strong>
          </div>
        ) : null}
          {activeTab === 'nft' && selectedNftCollection && parsedNftTokenId !== undefined ? (
            <div className="cm-status-card">
              <span>NFT deposited?</span>
              <strong>{(nftHeld || nftLocked) ? `Yes ${nftLocked ? '(locked)' : '(available)'}` : 'No'}</strong>
            </div>
          ) : null}
      </div>

      <nav className="section-tabs" style={{ marginBottom: 16 }}>
        {CUSTODIAN_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? 'active' : ''}
            onClick={() => setActiveTab(tab.id)}
            aria-pressed={activeTab === tab.id}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'eth' && (
        <>
          <div className="cm-block">
            <h3>Deposit ETH</h3>
            <label htmlFor="eth-amount">Amount</label>
            <input
              id="eth-amount"
              placeholder="0.1"
              value={ethAmount}
              onChange={(event) => setEthAmount(event.target.value.trim())}
            />
            <div className="cm-actions-row">
              <button onClick={depositEth} disabled={busyAction || !address || !(isInitialized as boolean) || !(userAllowed as boolean) || !canDepositEth}>
                Deposit ETH
              </button>
            </div>
          </div>

          <div className="cm-block">
            <h3>Withdraw ETH</h3>
            <label htmlFor="withdraw-eth-amount">Amount</label>
            <input
              id="withdraw-eth-amount"
              placeholder="0.1"
              value={withdrawEthAmount}
              disabled={withdrawAllEth}
              onChange={(event) => setWithdrawEthAmount(event.target.value.trim())}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <input
                type="checkbox"
                checked={withdrawAllEth}
                onChange={(event) => setWithdrawAllEth(event.target.checked)}
              />
              Withdraw all ETH
            </label>
            <div className="cm-actions-row">
              <button onClick={withdrawEth} disabled={withdrawEthBusy || !address || !(isInitialized as boolean) || !(userAllowed as boolean) || !canWithdrawEth}>
                {withdrawAllEth ? 'Withdraw all ETH' : 'Withdraw ETH'}
              </button>
            </div>
          </div>
        </>
      )}

      {activeTab === 'erc20' && (
        <>
          <div className="cm-block">
            <h3>Deposit ERC20</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div>
                <label>Token</label>
                <div>
                  {selectedToken ? (
                    <div>
                      <strong>{selectedToken.name} ({selectedToken.symbol})</strong>
                      <button onClick={() => setSelectedToken(null)}>Change</button>
                    </div>
                  ) : (
                    <div style={{ color: 'rgba(0,0,0,0.65)' }}>Insert a token address</div>
                  )}
                </div>
              </div>
              <div>
                <label>Amount</label>
                <input value={tokenAmount} onChange={(e) => setTokenAmount(e.target.value.trim())} placeholder="100" />
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <label>Token address</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <input placeholder="0x..." value={customAddr} onChange={(e) => setCustomAddr(e.target.value.trim())} style={{ flex: 1 }} />
                <button onClick={submitCustomToken} disabled={tokenBusy || !customAddr}>Validate & Use</button>
              </div>
            </div>
            <div className="cm-actions-row">
              <button onClick={depositErc20} disabled={tokenBusy || !address || !selectedToken || !(isInitialized as boolean) || !(userAllowed as boolean) || !canDepositToken}>
                Approve & Deposit
              </button>
            </div>
          </div>

          <div className="cm-block">
            <h3>Withdraw ERC20</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div>
                <label>Token</label>
                <div>
                  {selectedToken ? (
                    <div>
                      <strong>{selectedToken.name} ({selectedToken.symbol})</strong>
                      <button onClick={() => setSelectedToken(null)}>Change</button>
                    </div>
                  ) : (
                    <div style={{ color: 'rgba(0,0,0,0.65)' }}>Insert a token address</div>
                  )}
                </div>
              </div>
              <div>
                <label>Amount</label>
                <input value={withdrawTokenAmount} disabled={withdrawAllToken} onChange={(e) => setWithdrawTokenAmount(e.target.value.trim())} placeholder="100" />
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <input
                type="checkbox"
                checked={withdrawAllToken}
                onChange={(event) => setWithdrawAllToken(event.target.checked)}
              />
              Withdraw all {selectedToken ? selectedToken.symbol : ''}
            </label>
            <div className="cm-actions-row">
              <button onClick={withdrawErc20} disabled={withdrawTokenBusy || !address || !selectedToken || !(isInitialized as boolean) || !(userAllowed as boolean) || !canWithdrawToken}>
                {withdrawAllToken ? 'Withdraw all ERC20' : 'Withdraw ERC20'}
              </button>
            </div>
          </div>
        </>
      )}

      {activeTab === 'nft' && (
        <>
          <div className="cm-block">
            <h3>Deposit NFT</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <label>Collection</label>
                <div>
                  {selectedNftCollection ? (
                    <div>
                      <strong>{selectedNftCollection.name} ({selectedNftCollection.symbol})</strong>
                      <button onClick={() => setSelectedNftCollection(null)}>Change</button>
                    </div>
                  ) : (
                    <div style={{ color: 'rgba(0,0,0,0.65)' }}>Insert a NFT collection address</div>
                  )}
                </div>
              </div>
              <div>
                <label>Token ID</label>
                <input value={nftTokenId} onChange={(event) => setNftTokenId(event.target.value.trim())} placeholder="1" />
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <label>NFT collection address</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <input placeholder="0x..." value={customNftAddr} onChange={(event) => setCustomNftAddr(event.target.value.trim())} style={{ flex: 1 }} />
                <button onClick={submitCustomNft} disabled={nftBusy || !customNftAddr}>Validate & Use</button>
              </div>
            </div>
            <div className="cm-actions-row">
              <button onClick={depositNft} disabled={nftBusy || !address || !selectedNftCollection || !nftTokenId || !(isInitialized as boolean) || !(userAllowed as boolean)}>
                Approve & Deposit NFT
              </button>
            </div>
          </div>

          <div className="cm-block">
            <h3>Withdraw NFT</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <label>Collection</label>
                <div>
                  {selectedNftCollection ? (
                    <div>
                      <strong>{selectedNftCollection.name} ({selectedNftCollection.symbol})</strong>
                      <button onClick={() => setSelectedNftCollection(null)}>Change</button>
                    </div>
                  ) : (
                    <div style={{ color: 'rgba(0,0,0,0.65)' }}>Insert a NFT collection address</div>
                  )}
                </div>
              </div>
              <div>
                <label>Token ID</label>
                <input value={nftTokenId} onChange={(event) => setNftTokenId(event.target.value.trim())} placeholder="1" />
              </div>
            </div>
            <div className="cm-actions-row">
              <button onClick={withdrawNft} disabled={withdrawNftBusy || !address || !selectedNftCollection || parsedNftTokenId === undefined || !(isInitialized as boolean) || !(userAllowed as boolean) || !nftHeld}>
                Withdraw NFT
              </button>
            </div>
          </div>
        </>
      )}

      

      {/* error modal removed to avoid interruptive popups; errors are logged to console */}

    </section>
  );
}

export default CustodianView;