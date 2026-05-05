import { useState } from 'react';
import { useMemo } from 'react';
import { decodeEventLog } from 'viem';
import { parseEther, formatEther, parseUnits, formatUnits } from 'viem';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import { CUSTODIAN_CONTRACT, LENDING_POOL_CONTRACT, COMPLIANCE_MANAGER_CONTRACT } from '../constants/contracts';
import TokenPicker from '../components/TokenPicker';
import NFTCollectionPicker from '../components/NFTCollectionPicker';
import validateTokenOnchain from '../hooks/useTokenValidation';
import validateNftCollectionOnchain from '../hooks/useNftValidation';
import type { TokenMetadata } from '../hooks/useTokenValidation';
import type { NFTCollectionMetadata } from '../hooks/useNftValidation';

const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function CustodianView() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [ethAmount, setEthAmount] = useState('');
  const [busyAction, setBusyAction] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [selectedToken, setSelectedToken] = useState<TokenMetadata | null>(null);
  const [tokenAmount, setTokenAmount] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenFeedback, setTokenFeedback] = useState('');
  const [customAddr, setCustomAddr] = useState('');
  const [showNftPicker, setShowNftPicker] = useState(false);
  const [selectedNftCollection, setSelectedNftCollection] = useState<NFTCollectionMetadata | null>(null);
  const [nftTokenId, setNftTokenId] = useState('');
  const [nftBusy, setNftBusy] = useState(false);
  const [nftFeedback, setNftFeedback] = useState('');
  const [customNftAddr, setCustomNftAddr] = useState('');
  const [withdrawEthAmount, setWithdrawEthAmount] = useState('');
  const [withdrawEthBusy, setWithdrawEthBusy] = useState(false);
  const [withdrawEthFeedback, setWithdrawEthFeedback] = useState('');
  const [withdrawTokenAmount, setWithdrawTokenAmount] = useState('');
  const [withdrawTokenBusy, setWithdrawTokenBusy] = useState(false);
  const [withdrawTokenFeedback, setWithdrawTokenFeedback] = useState('');
  const [withdrawNftBusy, setWithdrawNftBusy] = useState(false);
  const [withdrawNftFeedback, setWithdrawNftFeedback] = useState('');

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
    query: { enabled: !!address && !!selectedNftCollection && parsedNftTokenId !== undefined },
  });

  const nftHeld = Boolean((nftBalanceRaw as readonly [boolean, boolean] | undefined)?.[0]);

  const wethAddress = (import.meta.env.VITE_WETH_ADDRESS as `0x${string}` | undefined) ?? (ZERO_ADDRESS as `0x${string}`);

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
    query: { enabled: !!address },
  });

  const depositedEth = depositedRaw ? formatEther(depositedRaw as bigint) : '0';

  const withdrawEth = async () => {
    if (!withdrawEthAmount) {
      setWithdrawEthFeedback('Enter an ETH amount first.');
      return;
    }

    let parsedAmount: bigint;
    try {
      parsedAmount = parseEther(withdrawEthAmount);
    } catch {
      setWithdrawEthFeedback('Enter a valid ETH amount.');
      return;
    }

    try {
      setWithdrawEthBusy(true);
      setWithdrawEthFeedback('');

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
      setWithdrawEthFeedback('ETH withdrawn successfully.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ETH withdraw failed';
      setWithdrawEthFeedback(message);
    } finally {
      setWithdrawEthBusy(false);
    }
  };

  const depositEth = async () => {
    if (!ethAmount) {
      setFeedback('Enter an ETH amount first.');
      return;
    }

    try {
      setBusyAction(true);
      setFeedback('');
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
      setFeedback('ETH deposited successfully.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown deposit error';
      setFeedback(message);
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

  const depositedToken = depositedTokenRaw && selectedToken ? formatUnits(depositedTokenRaw as bigint, selectedToken.decimals) : '0';

  const withdrawErc20 = async () => {
    if (!selectedToken) {
      setWithdrawTokenFeedback('Select a token first');
      return;
    }
    if (!withdrawTokenAmount) {
      setWithdrawTokenFeedback('Enter token amount');
      return;
    }

    let parsedAmount: bigint;
    try {
      parsedAmount = parseUnits(withdrawTokenAmount, selectedToken.decimals);
    } catch {
      setWithdrawTokenFeedback('Enter a valid token amount');
      return;
    }

    try {
      setWithdrawTokenBusy(true);
      setWithdrawTokenFeedback('');

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
      setWithdrawTokenFeedback('Token withdrawn successfully.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Token withdraw failed';
      setWithdrawTokenFeedback(message);
    } finally {
      setWithdrawTokenBusy(false);
    }
  };

  const depositErc20 = async () => {
    if (!selectedToken) {
      setTokenFeedback('Select a token first');
      return;
    }
    if (!tokenAmount) {
      setTokenFeedback('Enter token amount');
      return;
    }

    try {
      setTokenBusy(true);
      setTokenFeedback('');
      // 1) Approve custodian to spend
      const parsed = parseUnits(tokenAmount, selectedToken.decimals);
      setTokenFeedback(`Approving ${selectedToken.symbol}...`);
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
      setTokenFeedback(`Depositing ${tokenAmount} ${selectedToken.symbol}...`);
      const txHash = await writeContractAsync({
        ...CUSTODIAN_CONTRACT,
        functionName: 'deposit',
        args: [selectedToken.address, parsed],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: txHash });
      setTokenAmount('');
      await refetchATokenForSelected();
      await refetchDepositedToken();
      setTokenFeedback('Token deposited successfully');
    } catch (err: any) {
      console.error('Deposit error:', err);
      let errorMsg = 'ERC20 deposit failed';
      if (err?.shortMessage) {
        errorMsg = err.shortMessage;
      } else if (err?.reason) {
        errorMsg = err.reason;
      } else if (err?.message) {
        errorMsg = err.message;
      }
      // Check for specific contract errors
      if (err?.data?.message) {
        errorMsg += ` (${err.data.message})`;
      }
      setTokenFeedback(errorMsg);
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
      setTokenFeedback('');
      const meta = await validateTokenOnchain(publicClient, customAddr as `0x${string}`);
      setSelectedToken(meta);
      setTokenFeedback('Token validated and selected');
    } catch (err: any) {
      setTokenFeedback(err?.message ?? 'Validation failed');
    } finally {
      setTokenBusy(false);
    }
  };

  const handleTokenSelect = (token: TokenMetadata) => {
    setSelectedToken(token);
    setShowPicker(false);
    // Refresh aToken lookup and deposited balance immediately for visual feedback
    try {
      refetchATokenForSelected?.();
    } catch {
      // ignore
    }
    try {
      refetchDepositedToken?.();
    } catch {
      // ignore
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
      setNftFeedback('');

      setNftFeedback(`Approving ${selectedNftCollection.symbol}...`);
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

      setNftFeedback(`Depositing NFT #${nftTokenId}...`);
      const txHash = await writeContractAsync({
        ...CUSTODIAN_CONTRACT,
        functionName: 'depositNFT',
        args: [selectedNftCollection.address, parsedTokenId],
      });

      let successMessage = `NFT #${nftTokenId} deposited successfully.`;
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
            if (args.tokenId === parsedTokenId) {
              successMessage = `Deposited NFT #${args.tokenId.toString()} from ${selectedNftCollection.name} successfully.`;
              break;
            }
          } catch {
            // Ignore unrelated logs.
          }
        }
      }

      setNftTokenId('');
      setNftFeedback(successMessage);
      try {
        await refetchNftBalance?.();
      } catch {
        // ignore
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'NFT deposit failed';
      setNftFeedback(message);
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
      setWithdrawNftFeedback('');

      const txHash = await writeContractAsync({
        ...CUSTODIAN_CONTRACT,
        functionName: 'withdrawNFT',
        args: [selectedNftCollection.address, parsedNftTokenId],
      });

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
      }

      await refetchNftBalance?.();
      setWithdrawNftFeedback('NFT withdrawn successfully.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'NFT withdraw failed';
      setWithdrawNftFeedback(message);
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
      setNftFeedback('');
      const meta = await validateNftCollectionOnchain(publicClient, customNftAddr as `0x${string}`);
      setSelectedNftCollection(meta);
      setNftFeedback('NFT collection validated and selected');
    } catch (err: any) {
      setNftFeedback(err?.message ?? 'Validation failed');
    } finally {
      setNftBusy(false);
    }
  };

  const handleNftCollectionSelect = (collection: NFTCollectionMetadata) => {
    setSelectedNftCollection(collection);
    setShowNftPicker(false);
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
          <strong>{(userAllowed as boolean) ? '✓ Allowed' : '✗ Not allowed'}</strong>
        </div>
        <div className="cm-status-card">
          <span>Your deposited ETH</span>
          <strong>{depositedEth} ETH</strong>
        </div>
        {selectedToken ? (
          <div className="cm-status-card">
            <span>Your deposited {selectedToken.symbol}</span>
            <strong>{depositedToken} {selectedToken.symbol}</strong>
          </div>
        ) : null}
          {selectedNftCollection && parsedNftTokenId !== undefined ? (
            <div className="cm-status-card">
              <span>NFT deposited?</span>
              <strong>{nftHeld ? 'Yes' : 'No'}</strong>
            </div>
          ) : null}
      </div>

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
          <button onClick={depositEth} disabled={busyAction || !address || !(isInitialized as boolean) || !(userAllowed as boolean)}>
            Deposit ETH
          </button>
        </div>
        {!(isInitialized as boolean) && <p className="cm-feedback" style={{ color: 'orange' }}>Custodian not initialized</p>}
        {(isInitialized as boolean) && !(userAllowed as boolean) && <p className="cm-feedback" style={{ color: 'orange' }}>Your account is not allowed to deposit</p>}
      </div>

      <div className="cm-block">
        <h3>Withdraw ETH</h3>
        <label htmlFor="withdraw-eth-amount">Amount</label>
        <input
          id="withdraw-eth-amount"
          placeholder="0.1"
          value={withdrawEthAmount}
          onChange={(event) => setWithdrawEthAmount(event.target.value.trim())}
        />
        <div className="cm-actions-row">
          <button onClick={withdrawEth} disabled={withdrawEthBusy || !address || !(isInitialized as boolean) || !(userAllowed as boolean) || Number(depositedEth) <= 0}>
            Withdraw ETH
          </button>
        </div>
        <p className="cm-feedback">Available: {depositedEth} ETH</p>
        {withdrawEthFeedback ? <p className="cm-feedback">{withdrawEthFeedback}</p> : null}
      </div>

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
                <button onClick={() => setShowPicker(true)}>Pick token</button>
              )}
            </div>
            {selectedToken ? (
              <div style={{ marginTop: 8 }}>
                <div style={{ padding: 8, borderRadius: 6, background: '#f6f8fa' }}>
                  <strong>Deposited:</strong> {depositedToken} {selectedToken.symbol}
                </div>
              </div>
            ) : null}
          </div>

          <div>
            <label>Amount</label>
            <input value={tokenAmount} onChange={(e) => setTokenAmount(e.target.value.trim())} placeholder="100" />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>Custom token address</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <input placeholder="0x..." value={customAddr} onChange={(e) => setCustomAddr(e.target.value.trim())} style={{ flex: 1 }} />
            <button onClick={submitCustomToken} disabled={tokenBusy || !customAddr}>Validate & Use</button>
          </div>
        </div>
        <div className="cm-actions-row">
          <button onClick={depositErc20} disabled={tokenBusy || !address || !selectedToken || !(isInitialized as boolean) || !(userAllowed as boolean)}>
            Approve & Deposit
          </button>
        </div>
        {!(isInitialized as boolean) && <p className="cm-feedback" style={{ color: 'orange' }}>Custodian not initialized</p>}
        {(isInitialized as boolean) && !(userAllowed as boolean) && <p className="cm-feedback" style={{ color: 'orange' }}>Your account is not allowed to deposit</p>}
        {tokenFeedback ? <p className="cm-feedback">{tokenFeedback}</p> : null}
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
                <button onClick={() => setShowPicker(true)}>Pick token</button>
              )}
            </div>
            {selectedToken ? (
              <div style={{ marginTop: 8 }}>
                <div style={{ padding: 8, borderRadius: 6, background: '#f6f8fa' }}>
                  <strong>Available:</strong> {depositedToken} {selectedToken.symbol}
                </div>
              </div>
            ) : null}
          </div>

          <div>
            <label>Amount</label>
            <input value={withdrawTokenAmount} onChange={(e) => setWithdrawTokenAmount(e.target.value.trim())} placeholder="100" />
          </div>
        </div>
        <div className="cm-actions-row">
          <button onClick={withdrawErc20} disabled={withdrawTokenBusy || !address || !selectedToken || !(isInitialized as boolean) || !(userAllowed as boolean) || depositedToken === '0'}>
            Withdraw ERC20
          </button>
        </div>
        {withdrawTokenFeedback ? <p className="cm-feedback">{withdrawTokenFeedback}</p> : null}
      </div>

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
                <button onClick={() => setShowNftPicker(true)}>Pick collection</button>
              )}
            </div>
          </div>

          <div>
            <label>Token ID</label>
            <input value={nftTokenId} onChange={(event) => setNftTokenId(event.target.value.trim())} placeholder="1" />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>Custom NFT collection address</label>
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
        {nftFeedback ? <p className="cm-feedback">{nftFeedback}</p> : null}
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
                <button onClick={() => setShowNftPicker(true)}>Pick collection</button>
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
        {withdrawNftFeedback ? <p className="cm-feedback">{withdrawNftFeedback}</p> : null}
      </div>

      {showPicker ? <TokenPicker onSelect={handleTokenSelect} onClose={() => setShowPicker(false)} /> : null}
      {showNftPicker ? <NFTCollectionPicker onSelect={handleNftCollectionSelect} onClose={() => setShowNftPicker(false)} /> : null}

      {feedback ? <p className="cm-feedback">{feedback}</p> : null}
    </section>
  );
}

export default CustodianView;