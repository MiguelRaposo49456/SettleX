import { useEffect, useMemo, useState } from 'react';
import { isAddress, keccak256, encodePacked, decodeEventLog } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { NFT_ORDERBOOK_CONTRACT } from '../constants/contracts';
import validateTokenOnchain, { type TokenMetadata } from '../hooks/useTokenValidation';
import validateNftCollectionOnchain, { type NFTCollectionMetadata } from '../hooks/useNftValidation';

const ASSET_TYPE_OPTIONS = [
  { value: 0, label: 'ERC20' },
  { value: 1, label: 'ERC721 (NFT)' },
] as const;

const FORM_TABS = [
  { id: 'listing', label: 'Create Listing' },
  { id: 'offer', label: 'Create Offer' },
] as const;

function generateSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`) as `0x${string}`;
}

type NFTListingRecord = {
  listingId: bigint;
  seller: `0x${string}`;
  collection: `0x${string}`;
  tokenId: bigint;
  paymentType: number;
  paymentToken: `0x${string}`;
  paymentAmount: bigint;
  paymentTokenId: bigint;
  status: number;
};

type NFTOfferRecord = {
  offerId: bigint;
  buyer: `0x${string}`;
  collection: `0x${string}`;
  tokenId: bigint;
  offerType: number;
  offerToken: `0x${string}`;
  offerAmount: bigint;
  offerTokenId: bigint;
  status: number;
};

type MatchedPendingRecord = {
  listing: NFTListingRecord;
  offer: NFTOfferRecord;
};

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTokenLabel(metadata: TokenMetadata | null, input: string, isValid: boolean, fetchError = false) {
  if (!input) return '';
  if (!isValid) return '⚠ Invalid address';
  if (fetchError) return '⚠ Not a valid ERC20 token';
  if (metadata) return `✓ ${metadata.symbol} - ${metadata.name} (${metadata.decimals} decimals)`;
  return 'Address looks valid. Click away to validate token metadata.';
}

function formatNftLabel(metadata: NFTCollectionMetadata | null, input: string, isValid: boolean, fetchError = false) {
  if (!input) return '';
  if (!isValid) return '⚠ Invalid address';
  if (fetchError) return '⚠ Not a valid ERC721 collection';
  if (metadata) return `✓ ${metadata.symbol} - ${metadata.name}`;
  return 'Address looks valid. Click away to validate NFT metadata.';
}

function nftKey(collection: `0x${string}`, tokenId: bigint) {
  return `${collection.toLowerCase()}:${tokenId.toString()}`;
}

function NFTOrderbookView() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const [activeTab, setActiveTab] = useState<'listing' | 'offer'>('listing');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [lastCommitHash, setLastCommitHash] = useState<`0x${string}` | null>(null);
  const [lastRevealHash, setLastRevealHash] = useState<`0x${string}` | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [listings, setListings] = useState<NFTListingRecord[]>([]);
  const [offers, setOffers] = useState<NFTOfferRecord[]>([]);
  const [matchedPending, setMatchedPending] = useState<MatchedPendingRecord[]>([]);
  const [tokenMetadataByAddress, setTokenMetadataByAddress] = useState<Record<string, TokenMetadata | null>>({});
  const [nftMetadataByAddress, setNftMetadataByAddress] = useState<Record<string, NFTCollectionMetadata | null>>({});
  const [pendingCancelListingId, setPendingCancelListingId] = useState<bigint | null>(null);
  const [pendingCancelOfferId, setPendingCancelOfferId] = useState<bigint | null>(null);

  // Listing form state
  const [listingCollectionInput, setListingCollectionInput] = useState('');
  const [listingTokenIdInput, setListingTokenIdInput] = useState('');
  const [listingPaymentType, setListingPaymentType] = useState<number>(0);
  const [listingPaymentTokenInput, setListingPaymentTokenInput] = useState('');
  const [listingPaymentAmount, setListingPaymentAmount] = useState('');
  const [listingPaymentTokenId, setListingPaymentTokenId] = useState('');
  const [listingCollectionMetadata, setListingCollectionMetadata] = useState<NFTCollectionMetadata | null>(null);
  const [listingCollectionError, setListingCollectionError] = useState(false);
  const [listingPaymentTokenMetadata, setListingPaymentTokenMetadata] = useState<TokenMetadata | null>(null);
  const [listingPaymentCollectionMetadata, setListingPaymentCollectionMetadata] = useState<NFTCollectionMetadata | null>(null);
  const [listingPaymentError, setListingPaymentError] = useState(false);

  // Offer form state
  const [offerCollectionInput, setOfferCollectionInput] = useState('');
  const [offerTokenIdInput, setOfferTokenIdInput] = useState('');
  const [offerType, setOfferType] = useState<number>(0);
  const [offerTokenInput, setOfferTokenInput] = useState('');
  const [offerAmount, setOfferAmount] = useState('');
  const [offerTokenId, setOfferTokenId] = useState('');
  const [offerCollectionMetadata, setOfferCollectionMetadata] = useState<NFTCollectionMetadata | null>(null);
  const [offerCollectionError, setOfferCollectionError] = useState(false);
  const [offerTokenMetadata, setOfferTokenMetadata] = useState<TokenMetadata | null>(null);
  const [offerTokenCollectionMetadata, setOfferTokenCollectionMetadata] = useState<NFTCollectionMetadata | null>(null);
  const [offerTokenError, setOfferTokenError] = useState(false);

  const validListingCollection = isAddress(listingCollectionInput) ? (listingCollectionInput as `0x${string}`) : undefined;
  const validListingPaymentToken = isAddress(listingPaymentTokenInput) ? (listingPaymentTokenInput as `0x${string}`) : undefined;
  const validOfferCollection = isAddress(offerCollectionInput) ? (offerCollectionInput as `0x${string}`) : undefined;
  const validOfferToken = isAddress(offerTokenInput) ? (offerTokenInput as `0x${string}`) : undefined;

  const canSubmitListing = Boolean(
    address &&
    validListingCollection &&
    listingTokenIdInput &&
    validListingPaymentToken &&
    (listingPaymentType === 0 ? listingPaymentAmount : listingPaymentTokenId) &&
    !busy,
  );

  const canSubmitOffer = Boolean(
    address &&
    validOfferCollection &&
    offerTokenIdInput &&
    validOfferToken &&
    (offerType === 0 ? offerAmount : offerTokenId) &&
    !busy,
  );

  const mineOneBlockIfPossible = async (targetBlock: bigint) => {
    if (!publicClient) return;

    try {
      await (publicClient as unknown as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }).request({
        method: 'evm_mine',
        params: [],
      });
      return;
    } catch {
      // Fall back to polling
    }

    const timeoutAt = Date.now() + 30_000;
    while (Date.now() < timeoutAt) {
      const currentBlock = await publicClient.getBlockNumber();
      if (currentBlock > targetBlock) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error('Timed out waiting for the next block.');
  };

  const validateSingleToken = async (
    tokenAddress: `0x${string}`,
    setter: (meta: TokenMetadata | null) => void,
    setError: (value: boolean) => void,
  ) => {
    if (!publicClient) return;
    setError(false);
    try {
      const meta = await validateTokenOnchain(publicClient, tokenAddress);
      setter(meta);
    } catch {
      setter(null);
      setError(true);
    }
  };

  const validateSingleNft = async (
    collectionAddress: `0x${string}`,
    setter: (meta: NFTCollectionMetadata | null) => void,
    setError: (value: boolean) => void,
  ) => {
    if (!publicClient) return;
    setError(false);
    try {
      const meta = await validateNftCollectionOnchain(publicClient, collectionAddress);
      setter(meta);
    } catch {
      setter(null);
      setError(true);
    }
  };

  const getAddressDisplay = (addressValue: `0x${string}`, kind: 'token' | 'nft') => {
    if (kind === 'token') {
      const tokenMeta = tokenMetadataByAddress[addressValue.toLowerCase()];
      return tokenMeta ? `${tokenMeta.symbol} - ${tokenMeta.name}` : shortAddress(addressValue);
    }
    const nftMeta = nftMetadataByAddress[addressValue.toLowerCase()];
    return nftMeta ? `${nftMeta.symbol} - ${nftMeta.name}` : shortAddress(addressValue);
  };

  const refreshMarket = async () => {
    if (!publicClient) return;

    try {
      setMarketLoading(true);
      const latestBlock = await publicClient.getBlockNumber();

      const [listingLogs, offerLogs, matchedLogs] = await Promise.all([
        publicClient.getLogs({
          address: NFT_ORDERBOOK_CONTRACT.address,
          event: {
            type: 'event',
            name: 'NFTListed',
            inputs: [
              { indexed: true, name: 'listingId', type: 'uint256' },
              { indexed: true, name: 'seller', type: 'address' },
              { indexed: true, name: 'collection', type: 'address' },
              { indexed: false, name: 'tokenId', type: 'uint256' },
            ],
          },
          fromBlock: 0n,
          toBlock: latestBlock,
        }),
        publicClient.getLogs({
          address: NFT_ORDERBOOK_CONTRACT.address,
          event: {
            type: 'event',
            name: 'NFTOfferMade',
            inputs: [
              { indexed: true, name: 'offerId', type: 'uint256' },
              { indexed: true, name: 'buyer', type: 'address' },
              { indexed: true, name: 'collection', type: 'address' },
              { indexed: false, name: 'tokenId', type: 'uint256' },
            ],
          },
          fromBlock: 0n,
          toBlock: latestBlock,
        }),
        publicClient.getLogs({
          address: NFT_ORDERBOOK_CONTRACT.address,
          event: {
            type: 'event',
            name: 'NFTTradeMatched',
            inputs: [
              { indexed: true, name: 'listingId', type: 'uint256' },
              { indexed: true, name: 'offerId', type: 'uint256' },
            ],
          },
          fromBlock: 0n,
          toBlock: latestBlock,
        }),
      ]);

      const listingById = new Map<string, NFTListingRecord>();
      const offerById = new Map<string, NFTOfferRecord>();
      const nextListings: NFTListingRecord[] = [];
      for (const log of listingLogs) {
        const decoded = decodeEventLog({
          abi: NFT_ORDERBOOK_CONTRACT.abi,
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName !== 'NFTListed') continue;
        const args = decoded.args as { listingId?: bigint } | undefined;
        const listingId = args?.listingId;
        if (listingId === undefined) continue;

        const listing = await publicClient.readContract({
          ...NFT_ORDERBOOK_CONTRACT,
          functionName: 'getNFTListing',
          args: [listingId],
        }) as {
          listingId: bigint;
          seller: `0x${string}`;
          collection: `0x${string}`;
          tokenId: bigint;
          paymentType: bigint;
          paymentToken: `0x${string}`;
          paymentAmount: bigint;
          paymentTokenId: bigint;
          status: bigint;
        };

        const listingRecord: NFTListingRecord = {
          listingId: listing.listingId,
          seller: listing.seller,
          collection: listing.collection,
          tokenId: listing.tokenId,
          paymentType: Number(listing.paymentType),
          paymentToken: listing.paymentToken,
          paymentAmount: listing.paymentAmount,
          paymentTokenId: listing.paymentTokenId,
          status: Number(listing.status),
        };

        listingById.set(listingRecord.listingId.toString(), listingRecord);
        if (listingRecord.status === 1) nextListings.push(listingRecord);
      }

      const nextOffers: NFTOfferRecord[] = [];
      for (const log of offerLogs) {
        const decoded = decodeEventLog({
          abi: NFT_ORDERBOOK_CONTRACT.abi,
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName !== 'NFTOfferMade') continue;
        const args = decoded.args as { offerId?: bigint } | undefined;
        const offerId = args?.offerId;
        if (offerId === undefined) continue;

        const offer = await publicClient.readContract({
          ...NFT_ORDERBOOK_CONTRACT,
          functionName: 'getNFTOffer',
          args: [offerId],
        }) as {
          offerId: bigint;
          buyer: `0x${string}`;
          collection: `0x${string}`;
          tokenId: bigint;
          offerType: bigint;
          offerToken: `0x${string}`;
          offerAmount: bigint;
          offerTokenId: bigint;
          status: bigint;
        };

        const offerRecord: NFTOfferRecord = {
          offerId: offer.offerId,
          buyer: offer.buyer,
          collection: offer.collection,
          tokenId: offer.tokenId,
          offerType: Number(offer.offerType),
          offerToken: offer.offerToken,
          offerAmount: offer.offerAmount,
          offerTokenId: offer.offerTokenId,
          status: Number(offer.status),
        };

        offerById.set(offerRecord.offerId.toString(), offerRecord);
        if (offerRecord.status === 1) nextOffers.push(offerRecord);
      }

      const matchedPairs: MatchedPendingRecord[] = [];
      const matchedListingIds = new Set<string>();
      const matchedOfferIds = new Set<string>();
      const seenPairKeys = new Set<string>();

      for (const log of matchedLogs) {
        const decoded = decodeEventLog({
          abi: NFT_ORDERBOOK_CONTRACT.abi,
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName !== 'NFTTradeMatched') continue;
        const args = decoded.args as { listingId?: bigint; offerId?: bigint } | undefined;
        const listingId = args?.listingId;
        const offerId = args?.offerId;
        if (listingId === undefined || offerId === undefined) continue;

        const listingRecord = listingById.get(listingId.toString());
        const offerRecord = offerById.get(offerId.toString());
        if (!listingRecord || !offerRecord) continue;

        // Only show matched pairs still pending settlement.
        if (listingRecord.status !== 1 || offerRecord.status !== 1) continue;

        const pairKey = `${listingId.toString()}-${offerId.toString()}`;
        if (seenPairKeys.has(pairKey)) continue;
        seenPairKeys.add(pairKey);

        matchedListingIds.add(listingId.toString());
        matchedOfferIds.add(offerId.toString());
        matchedPairs.push({ listing: listingRecord, offer: offerRecord });
      }

      const activeListings = nextListings.filter((listing) => !matchedListingIds.has(listing.listingId.toString()));
      const activeOffers = nextOffers.filter((offer) => !matchedOfferIds.has(offer.offerId.toString()));

      activeListings.sort((a, b) => Number(b.listingId - a.listingId));
      activeOffers.sort((a, b) => Number(b.offerId - a.offerId));
      matchedPairs.sort((a, b) => Number(b.listing.listingId - a.listing.listingId));

      const nftAddressSet = new Set<string>();
      const tokenAddressSet = new Set<string>();

      for (const listing of activeListings) {
        nftAddressSet.add(listing.collection.toLowerCase());
        if (listing.paymentType === 0) tokenAddressSet.add(listing.paymentToken.toLowerCase());
        else nftAddressSet.add(listing.paymentToken.toLowerCase());
      }

      for (const offer of activeOffers) {
        nftAddressSet.add(offer.collection.toLowerCase());
        if (offer.offerType === 0) tokenAddressSet.add(offer.offerToken.toLowerCase());
        else nftAddressSet.add(offer.offerToken.toLowerCase());
      }

      for (const pair of matchedPairs) {
        nftAddressSet.add(pair.listing.collection.toLowerCase());
        if (pair.listing.paymentType === 0) tokenAddressSet.add(pair.listing.paymentToken.toLowerCase());
        else nftAddressSet.add(pair.listing.paymentToken.toLowerCase());

        if (pair.offer.offerType === 0) tokenAddressSet.add(pair.offer.offerToken.toLowerCase());
        else nftAddressSet.add(pair.offer.offerToken.toLowerCase());
      }

      const [tokenEntries, nftEntries] = await Promise.all([
        Promise.all(Array.from(tokenAddressSet).map(async (addr) => {
          try {
            const metadata = await validateTokenOnchain(publicClient, addr as `0x${string}`);
            return [addr, metadata] as const;
          } catch {
            return [addr, null] as const;
          }
        })),
        Promise.all(Array.from(nftAddressSet).map(async (addr) => {
          try {
            const metadata = await validateNftCollectionOnchain(publicClient, addr as `0x${string}`);
            return [addr, metadata] as const;
          } catch {
            return [addr, null] as const;
          }
        })),
      ]);

      setListings(activeListings);
      setOffers(activeOffers);
      setMatchedPending(matchedPairs);
      setTokenMetadataByAddress(Object.fromEntries(tokenEntries));
      setNftMetadataByAddress(Object.fromEntries(nftEntries));
    } catch (error) {
      console.warn('Failed to load NFT market data', error);
      setListings([]);
      setOffers([]);
      setMatchedPending([]);
      setTokenMetadataByAddress({});
      setNftMetadataByAddress({});
    } finally {
      setMarketLoading(false);
    }
  };

  useEffect(() => {
    void refreshMarket();
  }, [publicClient, lastRevealHash]);

  useEffect(() => {
    const refreshHandler = () => void refreshMarket();
    const storageHandler = (event: StorageEvent) => {
      if (event.key === 'settlementCompleted') void refreshMarket();
    };

    window.addEventListener('settlementCompleted', refreshHandler);
    window.addEventListener('storage', storageHandler);
    return () => {
      window.removeEventListener('settlementCompleted', refreshHandler);
      window.removeEventListener('storage', storageHandler);
    };
  }, [publicClient]);

  const marketGroups = useMemo(() => {
    const groups = new Map<string, {
      collection: `0x${string}`;
      tokenId: bigint;
      listings: NFTListingRecord[];
      offers: NFTOfferRecord[];
    }>();

    for (const listing of listings) {
      const key = nftKey(listing.collection, listing.tokenId);
      const group = groups.get(key) ?? {
        collection: listing.collection,
        tokenId: listing.tokenId,
        listings: [],
        offers: [],
      };
      group.listings.push(listing);
      groups.set(key, group);
    }

    for (const offer of offers) {
      const key = nftKey(offer.collection, offer.tokenId);
      const group = groups.get(key) ?? {
        collection: offer.collection,
        tokenId: offer.tokenId,
        listings: [],
        offers: [],
      };
      group.offers.push(offer);
      groups.set(key, group);
    }

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        listings: [...group.listings].sort((a, b) => Number(b.listingId - a.listingId)),
        offers: [...group.offers].sort((a, b) => Number(b.offerId - a.offerId)),
      }))
      .sort((a, b) => Number(b.tokenId - a.tokenId));
  }, [listings, offers]);

  const submitListing = async () => {
    if (!address || !canSubmitListing) {
      setFeedback('Fill in all required fields.');
      return;
    }

    try {
      setBusy(true);
      setFeedback('Submitting listing commit...');

      const salt = generateSalt();
      const paymentAmount = listingPaymentType === 0 ? BigInt(listingPaymentAmount || 0) : 0n;
      const paymentTokenId = listingPaymentType === 1 ? BigInt(listingPaymentTokenId || 0) : 0n;

      // Compute commit hash: keccak256(abi.encode(msg.sender, collection, tokenId, paymentType, paymentToken, paymentAmount, paymentTokenId, salt))
      const commitHash = keccak256(
        encodePacked(
          ['address', 'address', 'uint256', 'uint8', 'address', 'uint256', 'uint256', 'bytes32'],
          [
            address as `0x${string}`,
            validListingCollection as `0x${string}`,
            BigInt(listingTokenIdInput),
            listingPaymentType,
            validListingPaymentToken as `0x${string}`,
            paymentAmount,
            paymentTokenId,
            salt,
          ],
        ),
      );

      // Commit
      const commitTxHash = await writeContractAsync({
        ...NFT_ORDERBOOK_CONTRACT,
        functionName: 'commit',
        args: [commitHash, 0], // CommitType.NFTList = 0
      });

      if (!publicClient) {
        throw new Error('No public client available to track transaction.');
      }

      const commitReceipt = await publicClient.waitForTransactionReceipt({ hash: commitTxHash });
      setLastCommitHash(commitTxHash);

      setFeedback('Waiting one block before reveal...');
      await mineOneBlockIfPossible(commitReceipt.blockNumber ?? 0n);

      // Extract commitId from event
      const committedEvent = commitReceipt.logs
        .map((log) => {
          try {
            return decodeEventLog({ abi: NFT_ORDERBOOK_CONTRACT.abi, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .find((event) => event?.eventName === 'Committed');

      const commitId = committedEvent?.args && 'commitId' in committedEvent.args
        ? (committedEvent.args.commitId as bigint)
        : undefined;

      if (commitId === undefined) {
        throw new Error('Commit transaction succeeded but commitId was not found.');
      }

      setFeedback('Revealing listing...');
      const revealTxHash = await writeContractAsync({
        ...NFT_ORDERBOOK_CONTRACT,
        functionName: 'revealNFTList',
        args: [
          commitId,
          validListingCollection as `0x${string}`,
          BigInt(listingTokenIdInput),
          listingPaymentType,
          validListingPaymentToken as `0x${string}`,
          paymentAmount,
          paymentTokenId,
          salt,
        ],
      });

      await publicClient.waitForTransactionReceipt({ hash: revealTxHash });

      setLastRevealHash(revealTxHash);
      setFeedback('Listing created successfully!');
      setListingCollectionInput('');
      setListingTokenIdInput('');
      setListingPaymentTokenInput('');
      setListingPaymentAmount('');
      setListingPaymentTokenId('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Listing submission failed';
      setFeedback(message);
    } finally {
      setBusy(false);
    }
  };

  const submitOffer = async () => {
    if (!address || !canSubmitOffer) {
      setFeedback('Fill in all required fields.');
      return;
    }

    try {
      setBusy(true);
      setFeedback('Submitting offer commit...');

      const salt = generateSalt();
      const offerAmountValue = offerType === 0 ? BigInt(offerAmount || 0) : 0n;
      const offerTokenIdValue = offerType === 1 ? BigInt(offerTokenId || 0) : 0n;

      // Compute commit hash: keccak256(abi.encode(msg.sender, collection, tokenId, offerType, offerToken, offerAmount, offerTokenId, salt))
      const commitHash = keccak256(
        encodePacked(
          ['address', 'address', 'uint256', 'uint8', 'address', 'uint256', 'uint256', 'bytes32'],
          [
            address as `0x${string}`,
            validOfferCollection as `0x${string}`,
            BigInt(offerTokenIdInput),
            offerType,
            validOfferToken as `0x${string}`,
            offerAmountValue,
            offerTokenIdValue,
            salt,
          ],
        ),
      );

      // Commit
      const commitTxHash = await writeContractAsync({
        ...NFT_ORDERBOOK_CONTRACT,
        functionName: 'commit',
        args: [commitHash, 1], // CommitType.NFTOffer = 1
      });

      if (!publicClient) {
        throw new Error('No public client available to track transaction.');
      }

      const commitReceipt = await publicClient.waitForTransactionReceipt({ hash: commitTxHash });
      setLastCommitHash(commitTxHash);

      setFeedback('Waiting one block before reveal...');
      await mineOneBlockIfPossible(commitReceipt.blockNumber ?? 0n);

      // Extract commitId from event
      const committedEvent = commitReceipt.logs
        .map((log) => {
          try {
            return decodeEventLog({ abi: NFT_ORDERBOOK_CONTRACT.abi, data: log.data, topics: log.topics });
          } catch {
            return null;
          }
        })
        .find((event) => event?.eventName === 'Committed');

      const commitId = committedEvent?.args && 'commitId' in committedEvent.args
        ? (committedEvent.args.commitId as bigint)
        : undefined;

      if (commitId === undefined) {
        throw new Error('Commit transaction succeeded but commitId was not found.');
      }

      setFeedback('Revealing offer...');
      const revealTxHash = await writeContractAsync({
        ...NFT_ORDERBOOK_CONTRACT,
        functionName: 'revealNFTOffer',
        args: [
          commitId,
          validOfferCollection as `0x${string}`,
          BigInt(offerTokenIdInput),
          offerType,
          validOfferToken as `0x${string}`,
          offerAmountValue,
          offerTokenIdValue,
          salt,
        ],
      });

      await publicClient.waitForTransactionReceipt({ hash: revealTxHash });

      setLastRevealHash(revealTxHash);
      setFeedback('Offer created successfully!');
      setOfferCollectionInput('');
      setOfferTokenIdInput('');
      setOfferTokenInput('');
      setOfferAmount('');
      setOfferTokenId('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Offer submission failed';
      setFeedback(message);
    } finally {
      setBusy(false);
    }
  };

  const cancelListing = async (listingId: bigint) => {
    if (!address) {
      setFeedback('Connect your wallet first.');
      setPendingCancelListingId(null);
      return;
    }

    try {
      setBusy(true);
      setFeedback(`Sending cancel for listing #${listingId.toString()}...`);
      const txHash = await writeContractAsync({
        ...NFT_ORDERBOOK_CONTRACT,
        functionName: 'cancelNFTListing',
        args: [listingId],
      });

      if (!publicClient) throw new Error('No public client available to track transaction.');
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      setFeedback(`Listing #${listingId.toString()} cancelled.`);
      // Refresh market to reflect cancellation
      await refreshMarket();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cancel failed';
      setFeedback(message);
    } finally {
      setBusy(false);
      setPendingCancelListingId(null);
    }
  };

  const cancelOffer = async (offerId: bigint) => {
    if (!address) {
      setFeedback('Connect your wallet first.');
      setPendingCancelOfferId(null);
      return;
    }

    try {
      setBusy(true);
      setFeedback(`Sending cancel for offer #${offerId.toString()}...`);
      const txHash = await writeContractAsync({
        ...NFT_ORDERBOOK_CONTRACT,
        functionName: 'cancelNFTOffer',
        args: [offerId],
      });

      if (!publicClient) throw new Error('No public client available to track transaction.');
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      setFeedback(`Offer #${offerId.toString()} cancelled.`);
      // Refresh market to reflect cancellation
      await refreshMarket();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cancel failed';
      setFeedback(message);
    } finally {
      setBusy(false);
      setPendingCancelOfferId(null);
    }
  };

  return (
    <section className="cm-panel">
      <header className="cm-header">
        <h2>NFT Orderbook</h2>
        <p>Create NFT listings and offers with commit-reveal.</p>
      </header>

      <div className="cm-block" style={{ marginTop: 8, marginBottom: 20 }}>
        <div className="cm-actions-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Market View</h3>
          <button type="button" onClick={() => void refreshMarket()} disabled={marketLoading || busy}>
            {marketLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div className="cm-tx-box" style={{ marginBottom: 12 }}>
          <p style={{ margin: 0 }}><strong>Matched (Pending Settlement)</strong></p>
          <p className="cm-hint" style={{ marginTop: 4 }}>
            These listing-offer pairs have already matched and are waiting for batch settlement.
          </p>

          {matchedPending.length === 0 ? (
            <p className="cm-hint">No matched pairs waiting for settlement.</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {matchedPending.map((pair) => (
                <div
                  key={`${pair.listing.listingId.toString()}-${pair.offer.offerId.toString()}`}
                  className="cm-panel"
                  style={{ padding: 10 }}
                >
                  <p style={{ margin: 0 }}>
                    NFT {getAddressDisplay(pair.listing.collection, 'nft')} #{pair.listing.tokenId.toString()}
                  </p>
                  <p className="cm-hint" style={{ marginTop: 4 }}>
                    Listing #{pair.listing.listingId.toString()} by {shortAddress(pair.listing.seller)} matched with Offer #{pair.offer.offerId.toString()} by {shortAddress(pair.offer.buyer)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <p style={{ marginTop: 0, marginBottom: 8 }}><strong>Active Market</strong></p>

        {marketGroups.length === 0 ? (
          <p className="cm-hint">No active NFT listings or offers found.</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {marketGroups.map((group) => (
              <article key={nftKey(group.collection, group.tokenId)} className="cm-tx-box">
                <p><strong>NFT:</strong> {getAddressDisplay(group.collection, 'nft')} #{group.tokenId.toString()}</p>
                <p className="cm-hint" style={{ marginTop: -6 }}>{group.collection}</p>

                <p style={{ marginTop: 10, marginBottom: 6 }}><strong>Listings ({group.listings.length})</strong></p>
                {group.listings.length === 0 ? (
                  <p className="cm-hint">No active listing for this NFT.</p>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {group.listings.map((listing) => {
                      const isListingOwner = address?.toLowerCase() === listing.seller.toLowerCase();
                      const confirmingCancel = pendingCancelListingId === listing.listingId;
                      return (
                        <div key={listing.listingId.toString()} className="cm-panel" style={{ padding: 10 }}>
                          <p style={{ margin: 0 }}>
                            Listing #{listing.listingId.toString()} by {shortAddress(listing.seller)}
                          </p>
                          {listing.paymentType === 0 ? (
                            <p className="cm-hint" style={{ marginTop: 4 }}>
                              Wants ERC20 {getAddressDisplay(listing.paymentToken, 'token')} amount {listing.paymentAmount.toString()}
                            </p>
                          ) : (
                            <p className="cm-hint" style={{ marginTop: 4 }}>
                              Wants NFT {getAddressDisplay(listing.paymentToken, 'nft')} #{listing.paymentTokenId.toString()}
                            </p>
                          )}
                          {isListingOwner && (
                            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                              {!confirmingCancel ? (
                                <button
                                  type="button"
                                  onClick={() => setPendingCancelListingId(listing.listingId)}
                                  disabled={busy}
                                  style={{ padding: '4px 8px', fontSize: '0.9em' }}
                                >
                                  Cancel Listing
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void cancelListing(listing.listingId)}
                                    disabled={busy}
                                    style={{ padding: '4px 8px', fontSize: '0.9em'}}
                                  >
                                    Confirm Cancel
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setPendingCancelListingId(null)}
                                    disabled={busy}
                                    style={{ padding: '4px 8px', fontSize: '0.9em' }}
                                  >
                                    Abort
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <p style={{ marginTop: 12, marginBottom: 6 }}><strong>Offers ({group.offers.length})</strong></p>
                {group.offers.length === 0 ? (
                  <p className="cm-hint">No active offers for this NFT.</p>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {group.offers.map((offer) => {
                      const isOfferOwner = address?.toLowerCase() === offer.buyer.toLowerCase();
                      const confirmingCancel = pendingCancelOfferId === offer.offerId;
                      return (
                        <div key={offer.offerId.toString()} className="cm-panel" style={{ padding: 10 }}>
                          <p style={{ margin: 0 }}>
                            Offer #{offer.offerId.toString()} by {shortAddress(offer.buyer)}
                          </p>
                          {offer.offerType === 0 ? (
                            <p className="cm-hint" style={{ marginTop: 4 }}>
                              Offers ERC20 {getAddressDisplay(offer.offerToken, 'token')} amount {offer.offerAmount.toString()}
                            </p>
                          ) : (
                            <p className="cm-hint" style={{ marginTop: 4 }}>
                              Offers NFT {getAddressDisplay(offer.offerToken, 'nft')} #{offer.offerTokenId.toString()}
                            </p>
                          )}
                          {isOfferOwner && (
                            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                              {!confirmingCancel ? (
                                <button
                                  type="button"
                                  onClick={() => setPendingCancelOfferId(offer.offerId)}
                                  disabled={busy}
                                  style={{ padding: '4px 8px', fontSize: '0.9em' }}
                                >
                                  Cancel Offer
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void cancelOffer(offer.offerId)}
                                    disabled={busy}
                                    style={{ padding: '4px 8px', fontSize: '0.9em'}}
                                  >
                                    Confirm Cancel
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setPendingCancelOfferId(null)}
                                    disabled={busy}
                                    style={{ padding: '4px 8px', fontSize: '0.9em' }}
                                  >
                                    Abort
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <nav className="section-tabs" style={{ marginBottom: 16 }}>
        {FORM_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? 'active' : ''}
            onClick={() => setActiveTab(tab.id)}
            aria-pressed={activeTab === tab.id}
            disabled={busy}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Listing Form */}
      {activeTab === 'listing' && (
        <div className="cm-block">
          <h3>Create NFT Listing</h3>

          <label htmlFor="listing-collection">NFT Collection Address</label>
          <input
            id="listing-collection"
            placeholder="0x..."
            value={listingCollectionInput}
            onChange={(event) => {
              setListingCollectionInput(event.target.value.trim());
              setListingCollectionMetadata(null);
              setListingCollectionError(false);
            }}
            onBlur={() => {
              if (validListingCollection) {
                void validateSingleNft(validListingCollection, setListingCollectionMetadata, setListingCollectionError);
              }
            }}
          />
          <p className="cm-hint">{formatNftLabel(listingCollectionMetadata, listingCollectionInput, !!validListingCollection, listingCollectionError)}</p>

          <label htmlFor="listing-token-id">Token ID</label>
          <input
            id="listing-token-id"
            type="number"
            placeholder="0"
            value={listingTokenIdInput}
            onChange={(event) => setListingTokenIdInput(event.target.value)}
            min="0"
          />

          <label htmlFor="listing-payment-type">Payment Type</label>
          <select
            id="listing-payment-type"
            value={listingPaymentType}
            onChange={(event) => {
              const nextType = Number(event.target.value);
              setListingPaymentType(nextType);
              setListingPaymentTokenMetadata(null);
              setListingPaymentCollectionMetadata(null);
              setListingPaymentError(false);
            }}
          >
            {ASSET_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="listing-payment-token">Payment Token {listingPaymentType === 0 ? '(ERC20)' : '(NFT Collection)'}</label>
          <input
            id="listing-payment-token"
            placeholder="0x..."
            value={listingPaymentTokenInput}
            onChange={(event) => {
              setListingPaymentTokenInput(event.target.value.trim());
              setListingPaymentTokenMetadata(null);
              setListingPaymentCollectionMetadata(null);
              setListingPaymentError(false);
            }}
            onBlur={() => {
              if (!validListingPaymentToken) return;
              if (listingPaymentType === 0) {
                void validateSingleToken(validListingPaymentToken, setListingPaymentTokenMetadata, setListingPaymentError);
              } else {
                void validateSingleNft(validListingPaymentToken, setListingPaymentCollectionMetadata, setListingPaymentError);
              }
            }}
          />
          <p className="cm-hint">
            {listingPaymentType === 0
              ? formatTokenLabel(listingPaymentTokenMetadata, listingPaymentTokenInput, !!validListingPaymentToken, listingPaymentError)
              : formatNftLabel(listingPaymentCollectionMetadata, listingPaymentTokenInput, !!validListingPaymentToken, listingPaymentError)}
          </p>

          {listingPaymentType === 0 && (
            <>
              <label htmlFor="listing-payment-amount">Amount (in smallest unit)</label>
              <input
                id="listing-payment-amount"
                type="number"
                placeholder="0"
                value={listingPaymentAmount}
                onChange={(event) => setListingPaymentAmount(event.target.value)}
                min="0"
              />
            </>
          )}

          {listingPaymentType === 1 && (
            <>
              <label htmlFor="listing-payment-token-id">Desired NFT Token ID</label>
              <input
                id="listing-payment-token-id"
                type="number"
                placeholder="0"
                value={listingPaymentTokenId}
                onChange={(event) => setListingPaymentTokenId(event.target.value)}
                min="0"
              />
            </>
          )}

          <div className="cm-actions-row" style={{ marginTop: 16 }}>
            <button onClick={submitListing} disabled={!canSubmitListing}>
              Create Listing
            </button>
          </div>
        </div>
      )}

      {/* Offer Form */}
      {activeTab === 'offer' && (
        <div className="cm-block">
          <h3>Create NFT Offer</h3>

          <label htmlFor="offer-collection">NFT Collection Address</label>
          <input
            id="offer-collection"
            placeholder="0x..."
            value={offerCollectionInput}
            onChange={(event) => {
              setOfferCollectionInput(event.target.value.trim());
              setOfferCollectionMetadata(null);
              setOfferCollectionError(false);
            }}
            onBlur={() => {
              if (validOfferCollection) {
                void validateSingleNft(validOfferCollection, setOfferCollectionMetadata, setOfferCollectionError);
              }
            }}
          />
          <p className="cm-hint">{formatNftLabel(offerCollectionMetadata, offerCollectionInput, !!validOfferCollection, offerCollectionError)}</p>

          <label htmlFor="offer-token-id">Token ID</label>
          <input
            id="offer-token-id"
            type="number"
            placeholder="0"
            value={offerTokenIdInput}
            onChange={(event) => setOfferTokenIdInput(event.target.value)}
            min="0"
          />

          <label htmlFor="offer-type">Offer Type</label>
          <select
            id="offer-type"
            value={offerType}
            onChange={(event) => {
              const nextType = Number(event.target.value);
              setOfferType(nextType);
              setOfferTokenMetadata(null);
              setOfferTokenCollectionMetadata(null);
              setOfferTokenError(false);
            }}
          >
            {ASSET_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="offer-token">Offer Token {offerType === 0 ? '(ERC20)' : '(NFT Collection)'}</label>
          <input
            id="offer-token"
            placeholder="0x..."
            value={offerTokenInput}
            onChange={(event) => {
              setOfferTokenInput(event.target.value.trim());
              setOfferTokenMetadata(null);
              setOfferTokenCollectionMetadata(null);
              setOfferTokenError(false);
            }}
            onBlur={() => {
              if (!validOfferToken) return;
              if (offerType === 0) {
                void validateSingleToken(validOfferToken, setOfferTokenMetadata, setOfferTokenError);
              } else {
                void validateSingleNft(validOfferToken, setOfferTokenCollectionMetadata, setOfferTokenError);
              }
            }}
          />
          <p className="cm-hint">
            {offerType === 0
              ? formatTokenLabel(offerTokenMetadata, offerTokenInput, !!validOfferToken, offerTokenError)
              : formatNftLabel(offerTokenCollectionMetadata, offerTokenInput, !!validOfferToken, offerTokenError)}
          </p>

          {offerType === 0 && (
            <>
              <label htmlFor="offer-amount">Amount (in smallest unit)</label>
              <input
                id="offer-amount"
                type="number"
                placeholder="0"
                value={offerAmount}
                onChange={(event) => setOfferAmount(event.target.value)}
                min="0"
              />
            </>
          )}

          {offerType === 1 && (
            <>
              <label htmlFor="offer-token-id-offered">Your NFT Token ID</label>
              <input
                id="offer-token-id-offered"
                type="number"
                placeholder="0"
                value={offerTokenId}
                onChange={(event) => setOfferTokenId(event.target.value)}
                min="0"
              />
            </>
          )}

          <div className="cm-actions-row" style={{ marginTop: 16 }}>
            <button onClick={submitOffer} disabled={!canSubmitOffer}>
              Create Offer
            </button>
          </div>
        </div>
      )}

      {lastCommitHash ? (
        <div className="cm-tx-box">
          <p className="cm-hint">Last commit hash</p>
          <p className="cm-tx-hash">{lastCommitHash}</p>
        </div>
      ) : null}

      {feedback ? <p className="cm-feedback">{feedback}</p> : null}
    </section>
  );
}

export default NFTOrderbookView;
