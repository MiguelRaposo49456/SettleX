import { network } from "hardhat";
import { performance } from "node:perf_hooks";

const { ethers } = await network.connect({
  network: "sepolia",
  chainType: "l1",
});

const CommitType = { Order: 0, Take: 1, NFTList: 0, NFTOffer: 1 };
const Side = { BUY: 0, SELL: 1 };
const UserStatus = { Allowed: 0, BlacklistedWithWithdrawal: 1, Blacklisted: 2 };
const AssetType = { ERC20: 0, ERC721: 1 };

const TOKEN_AMOUNT = ethers.parseUnits("100", 18);
const TOKEN_AMOUNT_SMALL = ethers.parseUnits("25", 18);
const TOKEN_AMOUNT_LARGE = ethers.parseUnits("200", 18);
const TOKEN_DEPOSIT = ethers.parseUnits("10000", 18);
const ETH_DEPOSIT = ethers.parseEther("0.001");
const NFT_PAYMENT_AMOUNT = ethers.parseUnits("200", 18);
const SALT = ethers.encodeBytes32String("sepolia-eval");
const SETTLEMENT_WINDOW_SECONDS = 60;
const MAX_APPROVAL = (1n << 256n) - 1n;

type BenchmarkRow = {
  operation: string;
  gasUsed: string;
  durationMs: string;
  txHash?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeOrderHash(
  sender: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOut: bigint,
  side: number,
  partialAllowed: boolean,
  salt: string
): string {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "address", "uint256", "uint256", "uint8", "bool", "bytes32"],
    [sender, tokenIn, tokenOut, amountIn, amountOut, side, partialAllowed, salt]
  );
}

function computeTakeHash(sender: string, makerOrderId: bigint, takerAmount: bigint, salt: string): string {
  return ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256", "bytes32"],
    [sender, makerOrderId, takerAmount, salt]
  );
}

function computeNFTListHash(
  sender: string,
  collection: string,
  tokenId: bigint,
  paymentType: number,
  paymentToken: string,
  paymentAmount: bigint,
  paymentTokenId: bigint,
  salt: string
): string {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint256", "uint8", "address", "uint256", "uint256", "bytes32"],
    [sender, collection, tokenId, paymentType, paymentToken, paymentAmount, paymentTokenId, salt]
  );
}

function computeNFTOfferHash(
  sender: string,
  collection: string,
  tokenId: bigint,
  offerType: number,
  offerToken: string,
  offerAmount: bigint,
  offerTokenId: bigint,
  salt: string
): string {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint256", "uint8", "address", "uint256", "uint256", "bytes32"],
    [sender, collection, tokenId, offerType, offerToken, offerAmount, offerTokenId, salt]
  );
}

async function getLatestEventArgs(contract: any, filter: any, blockNumber: number) {
  const events = await contract.queryFilter(filter, blockNumber, blockNumber);

  if (events.length === 0) {
    throw new Error(`No event found for block ${blockNumber}`);
  }

  return events[events.length - 1].args;
}

async function measureTx<T>(rows: BenchmarkRow[], label: string, txFactory: () => Promise<T>): Promise<any> {
  const startedAt = performance.now();
  const tx: any = await txFactory();
  const receipt = await tx.wait();
  const durationMs = Math.round(performance.now() - startedAt);
  const txHash = String(tx.hash);

  rows.push({ operation: label, gasUsed: receipt.gasUsed.toString(), durationMs: durationMs.toString(), txHash });
  console.log(`${label}: ${receipt.gasUsed.toString()} gas, ${durationMs} ms`);

  return receipt;
}

async function main() {
  const rows: BenchmarkRow[] = [];
  const signers = await ethers.getSigners();
  const admin = signers[0];
  const client1 = signers[1] ?? admin;
  const client2 = admin; // Reusing admin as client2
  const client3 = client1; // Reusing client1 as client3
  const benchmarkUserAddress = ethers.Wallet.createRandom().address;

  const tokenA = await ethers.deployContract("MockERC20", ["TokenA", "TKA", 18]);
  const tokenB = await ethers.deployContract("MockERC20", ["TokenB", "TKB", 18]);
  const nftCollection = await ethers.deployContract("MockERC721", ["CollectionA", "CLXA"]);
  const otherNFTCollection = await ethers.deployContract("MockERC721", ["CollectionB", "CLXB"]);
  const mockLendingPool = await ethers.deployContract("MockLendingPool");
  const mockWeth = await ethers.deployContract("MockWETH");

  const complianceManager = await ethers.deployContract("ComplianceManager");
  const fungibleOrderbook = await ethers.deployContract("FungibleOrderbook", [complianceManager.target]);
  const nftOrderbook = await ethers.deployContract("NFTOrderbook", [complianceManager.target]);
  const custodian = await ethers.deployContract("Custodian", [complianceManager.target, mockLendingPool.target, mockWeth.target]);
  const settlementEngine = await ethers.deployContract("SettlementEngine", [complianceManager.target, SETTLEMENT_WINDOW_SECONDS, 10]);

  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  await nftCollection.waitForDeployment();
  await otherNFTCollection.waitForDeployment();
  await mockLendingPool.waitForDeployment();
  await mockWeth.waitForDeployment();
  await complianceManager.waitForDeployment();
  await fungibleOrderbook.waitForDeployment();
  await nftOrderbook.waitForDeployment();
  await custodian.waitForDeployment();
  await settlementEngine.waitForDeployment();

  await (await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA")).wait();
  await (await tokenA.connect(admin).mint(admin.address, TOKEN_AMOUNT_LARGE)).wait();
  await (await tokenA.connect(admin).approve(mockLendingPool.target, TOKEN_AMOUNT_LARGE)).wait();
  await (await mockLendingPool.connect(admin).addLiquidity(tokenA.target, TOKEN_AMOUNT_LARGE)).wait();

  const tokenAUnderlyingAddress = String(tokenA.target);
  const tokenAAddress = String(await mockLendingPool.getAToken(tokenA.target));
  const tokenBAddress = String(tokenB.target);
  const nftCollectionAddress = String(nftCollection.target);
  const otherNFTCollectionAddress = String(otherNFTCollection.target);
  const fungibleOrderbookAddress = String(fungibleOrderbook.target);
  const nftOrderbookAddress = String(nftOrderbook.target);
  const custodianAddress = String(custodian.target);
  const settlementEngineAddress = String(settlementEngine.target);

  await fungibleOrderbook.connect(admin).initialize(custodianAddress, settlementEngineAddress);
  await nftOrderbook.connect(admin).initialize(custodianAddress, settlementEngineAddress);
  await custodian.connect(admin).initialize(fungibleOrderbookAddress, nftOrderbookAddress, settlementEngineAddress);
  await settlementEngine.connect(admin).initialize(fungibleOrderbookAddress, nftOrderbookAddress, custodianAddress);

  await measureTx(rows, "ComplianceManager.pause", () => complianceManager.connect(admin).pause());
  await measureTx(rows, "ComplianceManager.unpause", () => complianceManager.connect(admin).unpause());
  await measureTx(rows, "ComplianceManager.blacklistToken", () => complianceManager.connect(admin).blacklistToken(otherNFTCollectionAddress));
  await measureTx(rows, "ComplianceManager.unblacklistToken", () => complianceManager.connect(admin).unblacklistToken(otherNFTCollectionAddress));
  await measureTx(rows, "ComplianceManager.setUserStatus(blacklist)", () => complianceManager.connect(admin).setUserStatus(benchmarkUserAddress, UserStatus.BlacklistedWithWithdrawal));
  await measureTx(rows, "ComplianceManager.setUserStatus(allow)", () => complianceManager.connect(admin).setUserStatus(benchmarkUserAddress, UserStatus.Allowed));

  await measureTx(rows, "SettlementEngine.setSettlementWindow", () => settlementEngine.connect(admin).setSettlementWindow(SETTLEMENT_WINDOW_SECONDS));
  await measureTx(rows, "SettlementEngine.setMaxBatchSize", () => settlementEngine.connect(admin).setMaxBatchSize(20));

  for (const client of [client1, client2, client3]) {
    await (await tokenA.mint(client.address, TOKEN_DEPOSIT + TOKEN_AMOUNT_LARGE)).wait();
    await (await tokenB.mint(client.address, TOKEN_DEPOSIT + TOKEN_AMOUNT_LARGE)).wait();
    await (await tokenA.connect(client).approve(custodianAddress, MAX_APPROVAL)).wait();
    await (await tokenB.connect(client).approve(custodianAddress, MAX_APPROVAL)).wait();
    await (await custodian.connect(client).deposit(tokenAUnderlyingAddress, TOKEN_DEPOSIT)).wait();
    await (await custodian.connect(client).deposit(tokenBAddress, TOKEN_DEPOSIT)).wait();
  }

  await (await nftCollection.mint(client1.address, 1)).wait();
  await (await nftCollection.mint(client2.address, 2)).wait();
  await (await nftCollection.mint(client1.address, 3)).wait();
  await (await nftCollection.mint(client1.address, 4)).wait();
  await (await nftCollection.connect(client1).approve(custodianAddress, 1)).wait();
  await (await nftCollection.connect(client2).approve(custodianAddress, 2)).wait();
  await (await nftCollection.connect(client1).approve(custodianAddress, 3)).wait();
  await (await nftCollection.connect(client1).approve(custodianAddress, 4)).wait();

  await measureTx(rows, "Custodian.deposit(tokenA - with pool)", () => custodian.connect(client1).deposit(tokenAUnderlyingAddress, TOKEN_AMOUNT_LARGE));
  await measureTx(rows, "Custodian.withdraw(tokenA - with pool)", () => custodian.connect(client1).withdraw(tokenAAddress, TOKEN_AMOUNT_SMALL, false));
  await measureTx(rows, "Custodian.deposit(tokenB - without pool)", () => custodian.connect(client1).deposit(tokenBAddress, TOKEN_AMOUNT_SMALL));
  await measureTx(rows, "Custodian.withdraw(tokenB - without pool)", () => custodian.connect(client1).withdraw(tokenBAddress, TOKEN_AMOUNT_SMALL, false));
  await measureTx(rows, "Custodian.depositETH", () => custodian.connect(client1).depositETH({ value: ETH_DEPOSIT }));
  await measureTx(rows, "Custodian.withdrawETH", () => custodian.connect(client1).withdrawETH(ETH_DEPOSIT));
  await measureTx(rows, "Custodian.depositNFT", () => custodian.connect(client1).depositNFT(nftCollectionAddress, 3));
  await measureTx(rows, "Custodian.withdrawNFT", () => custodian.connect(client1).withdrawNFT(nftCollectionAddress, 3));

  await custodian.connect(client1).depositNFT(nftCollectionAddress, 4);

  const unmatchedCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(to cancel)", () =>
    fungibleOrderbook.connect(client1).commit(
      computeOrderHash(client1.address, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_LARGE, TOKEN_AMOUNT_SMALL, Side.SELL, true, SALT),
      CommitType.Order
    )
  );
  const unmatchedCommitArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), unmatchedCommitReceipt.blockNumber);
  const unmatchedCommitId = unmatchedCommitArgs.commitId as bigint;
  const unmatchedRevealReceipt = await measureTx(rows, "FungibleOrderbook.revealOrder(to cancel)", () =>
    fungibleOrderbook.connect(client1).revealOrder(unmatchedCommitId, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_LARGE, TOKEN_AMOUNT_SMALL, Side.SELL, true, SALT)
  );
  const unmatchedOrderArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.OrderPlaced(), unmatchedRevealReceipt.blockNumber);
  const unmatchedOrderId = unmatchedOrderArgs.orderId as bigint;
  await measureTx(rows, "FungibleOrderbook.cancelOrder", () => fungibleOrderbook.connect(client1).cancelOrder(unmatchedOrderId));

  const makerCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(to be taken)", () =>
    fungibleOrderbook.connect(client1).commit(
      computeOrderHash(client1.address, tokenAAddress, tokenBAddress, TOKEN_AMOUNT, TOKEN_AMOUNT, Side.SELL, true, SALT),
      CommitType.Order
    )
  );
  const makerCommitArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), makerCommitReceipt.blockNumber);
  const makerCommitId = makerCommitArgs.commitId as bigint;
  const makerOrderReceipt = await measureTx(rows, "FungibleOrderbook.revealOrder(to be taken)", () =>
    fungibleOrderbook.connect(client1).revealOrder(makerCommitId, tokenAAddress, tokenBAddress, TOKEN_AMOUNT, TOKEN_AMOUNT, Side.SELL, true, SALT)
  );
  const makerOrderArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.OrderPlaced(), makerOrderReceipt.blockNumber);
  const makerOrderId = makerOrderArgs.orderId as bigint;

  const takerCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(take)", () =>
    fungibleOrderbook.connect(client2).commit(computeTakeHash(client2.address, makerOrderId, TOKEN_AMOUNT, SALT), CommitType.Take)
  );
  const takerCommitArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), takerCommitReceipt.blockNumber);
  const takerCommitId = takerCommitArgs.commitId as bigint;
  await measureTx(rows, "FungibleOrderbook.revealTake", () =>
    fungibleOrderbook.connect(client2).revealTake(takerCommitId, makerOrderId, TOKEN_AMOUNT, SALT)
  );

  await sleep((SETTLEMENT_WINDOW_SECONDS + 10) * 1000);
  await measureTx(rows, "SettlementEngine.settleBatch (batch=1)", () => settlementEngine.connect(client3).settleBatch());

  const SALT_B3_NFT = [
    ethers.encodeBytes32String("sb3-a"),
    ethers.encodeBytes32String("sb3-b"),
    ethers.encodeBytes32String("sb3-c"),
  ];

  for (const salt of SALT_B3_NFT) {
    const mcr = await fungibleOrderbook.connect(client1).commit(
      computeOrderHash(client1.address, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_SMALL, TOKEN_AMOUNT_SMALL, Side.SELL, true, salt),
      CommitType.Order
    );
    const mcrReceipt = await mcr.wait();
    if (!mcrReceipt) throw new Error(`Transaction failed: maker commit (${salt})`);
    const mArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), mcrReceipt.blockNumber);
    const mCommitId = mArgs.commitId as bigint;
    const mReveal = await fungibleOrderbook.connect(client1).revealOrder(mCommitId, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_SMALL, TOKEN_AMOUNT_SMALL, Side.SELL, true, salt);
    const mRevealReceipt = await mReveal.wait();
    if (!mRevealReceipt) throw new Error(`Transaction failed: maker reveal (${salt})`);
    const mOArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.OrderPlaced(), mRevealReceipt.blockNumber);
    const mOrderId = mOArgs.orderId as bigint;

    const tcr = await fungibleOrderbook.connect(client2).commit(
      computeTakeHash(client2.address, mOrderId, TOKEN_AMOUNT_SMALL, salt),
      CommitType.Take
    );
    const tcrReceipt = await tcr.wait();
    if (!tcrReceipt) throw new Error(`Transaction failed: taker commit (${salt})`);
    const tArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), tcrReceipt.blockNumber);
    const tCommitId = tArgs.commitId as bigint;
    await fungibleOrderbook.connect(client2).revealTake(tCommitId, mOrderId, TOKEN_AMOUNT_SMALL, salt);
  }

  await sleep((SETTLEMENT_WINDOW_SECONDS + 10) * 1000);
  await measureTx(rows, "SettlementEngine.settleBatch (batch=3)", () => settlementEngine.connect(client3).settleBatch());

  const SALT_B5_NFT = [
    ethers.encodeBytes32String("sb5-a"),
    ethers.encodeBytes32String("sb5-b"),
    ethers.encodeBytes32String("sb5-c"),
    ethers.encodeBytes32String("sb5-d"),
    ethers.encodeBytes32String("sb5-e"),
  ];

  for (const salt of SALT_B5_NFT) {
    const mcr = await fungibleOrderbook.connect(client1).commit(
      computeOrderHash(client1.address, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_SMALL, TOKEN_AMOUNT_SMALL, Side.SELL, true, salt),
      CommitType.Order
    );
    const mcrReceipt = await mcr.wait();
    if (!mcrReceipt) throw new Error(`Transaction failed: maker commit (${salt})`);
    const mArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), mcrReceipt.blockNumber);
    const mCommitId = mArgs.commitId as bigint;
    const mReveal = await fungibleOrderbook.connect(client1).revealOrder(mCommitId, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_SMALL, TOKEN_AMOUNT_SMALL, Side.SELL, true, salt);
    const mRevealReceipt = await mReveal.wait();
    if (!mRevealReceipt) throw new Error(`Transaction failed: maker reveal (${salt})`);
    const mOArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.OrderPlaced(), mRevealReceipt.blockNumber);
    const mOrderId = mOArgs.orderId as bigint;

    const tcr = await fungibleOrderbook.connect(client2).commit(
      computeTakeHash(client2.address, mOrderId, TOKEN_AMOUNT_SMALL, salt),
      CommitType.Take
    );
    const tcrReceipt = await tcr.wait();
    if (!tcrReceipt) throw new Error(`Transaction failed: taker commit (${salt})`);
    const tArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), tcrReceipt.blockNumber);
    const tCommitId = tArgs.commitId as bigint;
    await fungibleOrderbook.connect(client2).revealTake(tCommitId, mOrderId, TOKEN_AMOUNT_SMALL, salt);
  }

  await sleep((SETTLEMENT_WINDOW_SECONDS + 10) * 1000);
  await measureTx(rows, "SettlementEngine.settleBatch (batch=5)", () => settlementEngine.connect(client3).settleBatch());

  const exactMakerCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(maker to match)", () =>
    fungibleOrderbook.connect(client1).commit(
      computeOrderHash(client1.address, tokenAAddress, tokenBAddress, TOKEN_AMOUNT, TOKEN_AMOUNT, Side.SELL, true, SALT),
      CommitType.Order
    )
  );
  const exactMakerCommitArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), exactMakerCommitReceipt.blockNumber);
  const exactMakerCommitId = exactMakerCommitArgs.commitId as bigint;
  const exactMakerRevealReceipt = await measureTx(rows, "FungibleOrderbook.revealOrder(maker to match)", () =>
    fungibleOrderbook.connect(client1).revealOrder(exactMakerCommitId, tokenAAddress, tokenBAddress, TOKEN_AMOUNT, TOKEN_AMOUNT, Side.SELL, true, SALT)
  );
  const exactMakerOrderArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.OrderPlaced(), exactMakerRevealReceipt.blockNumber);
  const exactMakerOrderId = exactMakerOrderArgs.orderId as bigint;

  const exactCounterCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(taker counter order)", () =>
    fungibleOrderbook.connect(client2).commit(
      computeOrderHash(client2.address, tokenBAddress, tokenAAddress, TOKEN_AMOUNT, TOKEN_AMOUNT, Side.BUY, true, SALT),
      CommitType.Order
    )
  );
  const exactCounterCommitArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), exactCounterCommitReceipt.blockNumber);
  const exactCounterCommitId = exactCounterCommitArgs.commitId as bigint;
  await measureTx(rows, "FungibleOrderbook.revealOrder(taker counter order)", () =>
    fungibleOrderbook.connect(client2).revealOrder(exactCounterCommitId, tokenBAddress, tokenAAddress, TOKEN_AMOUNT, TOKEN_AMOUNT, Side.BUY, true, SALT)
  );

  const listingCancelCommitReceipt = await measureTx(rows, "NFTOrderbook.commit listing(to cancel)", () =>
    nftOrderbook.connect(client1).commit(
      computeNFTListHash(client1.address, nftCollectionAddress, 4n, AssetType.ERC20, tokenAAddress, NFT_PAYMENT_AMOUNT, 0n, SALT),
      CommitType.NFTList
    )
  );
  const listingCancelCommitArgs = await getLatestEventArgs(nftOrderbook, nftOrderbook.filters.Committed(), listingCancelCommitReceipt.blockNumber);
  const listingCancelCommitId = listingCancelCommitArgs.commitId as bigint;
  await measureTx(rows, "NFTOrderbook.revealNFTList", () =>
    nftOrderbook.connect(client1).revealNFTList(listingCancelCommitId, nftCollectionAddress, 4, AssetType.ERC20, tokenAAddress, NFT_PAYMENT_AMOUNT, 0n, SALT)
  );
  await measureTx(rows, "NFTOrderbook.cancelNFTListing", () => nftOrderbook.connect(client1).cancelNFTListing(1));

  const offerCancelCommitReceipt = await measureTx(rows, "NFTOrderbook.commit offer(to cancel)", () =>
    nftOrderbook.connect(client2).commit(
      computeNFTOfferHash(client2.address, nftCollectionAddress, 999n, AssetType.ERC20, tokenAAddress, NFT_PAYMENT_AMOUNT, 0n, SALT),
      CommitType.NFTOffer
    )
  );
  const offerCancelCommitArgs = await getLatestEventArgs(nftOrderbook, nftOrderbook.filters.Committed(), offerCancelCommitReceipt.blockNumber);
  const offerCancelCommitId = offerCancelCommitArgs.commitId as bigint;
  await measureTx(rows, "NFTOrderbook.revealNFTOffer", () =>
    nftOrderbook.connect(client2).revealNFTOffer(offerCancelCommitId, nftCollectionAddress, 999, AssetType.ERC20, tokenAAddress, NFT_PAYMENT_AMOUNT, 0n, SALT)
  );
  await measureTx(rows, "NFTOrderbook.cancelNFTOffer", () => nftOrderbook.connect(client2).cancelNFTOffer(1));

  await (await nftCollection.connect(client1).approve(custodianAddress, 1)).wait();
  await (await nftCollection.connect(client2).approve(custodianAddress, 2)).wait();
  await (await custodian.connect(client1).depositNFT(nftCollectionAddress, 1)).wait();
  await (await custodian.connect(client2).depositNFT(nftCollectionAddress, 2)).wait();

  const nftMatchListingCommitReceipt = await measureTx(rows, "NFTOrderbook.commit listing(to match)", () =>
    nftOrderbook.connect(client1).commit(
      computeNFTListHash(client1.address, nftCollectionAddress, 1n, AssetType.ERC20, tokenAAddress, NFT_PAYMENT_AMOUNT, 0n, SALT),
      CommitType.NFTList
    )
  );
  const nftMatchListingCommitArgs = await getLatestEventArgs(nftOrderbook, nftOrderbook.filters.Committed(), nftMatchListingCommitReceipt.blockNumber);
  const nftMatchListingCommitId = nftMatchListingCommitArgs.commitId as bigint;
  await measureTx(rows, "NFTOrderbook.revealNFTList(match)", () =>
    nftOrderbook.connect(client1).revealNFTList(nftMatchListingCommitId, nftCollectionAddress, 1, AssetType.ERC20, tokenAAddress, NFT_PAYMENT_AMOUNT, 0n, SALT)
  );

  const nftMatchOfferCommitReceipt = await measureTx(rows, "NFTOrderbook.commit offer(to match)", () =>
    nftOrderbook.connect(client2).commit(
      computeNFTOfferHash(client2.address, nftCollectionAddress, 1n, AssetType.ERC20, tokenAAddress, NFT_PAYMENT_AMOUNT, 0n, SALT),
      CommitType.NFTOffer
    )
  );
  const nftMatchOfferCommitArgs = await getLatestEventArgs(nftOrderbook, nftOrderbook.filters.Committed(), nftMatchOfferCommitReceipt.blockNumber);
  const nftMatchOfferCommitId = nftMatchOfferCommitArgs.commitId as bigint;
  await measureTx(rows, "NFTOrderbook.revealNFTOffer(match)", () =>
    nftOrderbook.connect(client2).revealNFTOffer(nftMatchOfferCommitId, nftCollectionAddress, 1, AssetType.ERC20, tokenAAddress, NFT_PAYMENT_AMOUNT, 0n, SALT)
  );

  await sleep((SETTLEMENT_WINDOW_SECONDS + 10) * 1000);
  await measureTx(rows, "SettlementEngine.performUpkeep (batch=1)", () => settlementEngine.connect(client3).performUpkeep("0x"));

  const SALT_B3 = [
    ethers.encodeBytes32String("pu3-a"),
    ethers.encodeBytes32String("pu3-b"),
    ethers.encodeBytes32String("pu3-c"),
  ];

  for (const salt of SALT_B3) {
    const mcr = await fungibleOrderbook.connect(client1).commit(
      computeOrderHash(client1.address, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_SMALL, TOKEN_AMOUNT_SMALL, Side.SELL, true, salt),
      CommitType.Order
    );
    const mcrReceipt = await mcr.wait();
    if (!mcrReceipt) throw new Error(`Transaction failed: maker commit (${salt})`);
    const mArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), mcrReceipt.blockNumber);
    const mCommitId = mArgs.commitId as bigint;
    const mReveal = await fungibleOrderbook.connect(client1).revealOrder(mCommitId, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_SMALL, TOKEN_AMOUNT_SMALL, Side.SELL, true, salt);
    const mRevealReceipt = await mReveal.wait();
    if (!mRevealReceipt) throw new Error(`Transaction failed: maker reveal (${salt})`);
    const mOArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.OrderPlaced(), mRevealReceipt.blockNumber);
    const mOrderId = mOArgs.orderId as bigint;

    const tcr = await fungibleOrderbook.connect(client2).commit(
      computeTakeHash(client2.address, mOrderId, TOKEN_AMOUNT_SMALL, salt),
      CommitType.Take
    );
    const tcrReceipt = await tcr.wait();
    if (!tcrReceipt) throw new Error(`Transaction failed: taker commit (${salt})`);
    const tArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), tcrReceipt.blockNumber);
    const tCommitId = tArgs.commitId as bigint;
    await fungibleOrderbook.connect(client2).revealTake(tCommitId, mOrderId, TOKEN_AMOUNT_SMALL, salt);
  }

  await sleep((SETTLEMENT_WINDOW_SECONDS + 10) * 1000);
  await measureTx(rows, "SettlementEngine.performUpkeep (batch=3)", () => settlementEngine.connect(client3).performUpkeep("0x"));

  const SALT_B5 = [
    ethers.encodeBytes32String("pu5-a"),
    ethers.encodeBytes32String("pu5-b"),
    ethers.encodeBytes32String("pu5-c"),
    ethers.encodeBytes32String("pu5-d"),
    ethers.encodeBytes32String("pu5-e"),
  ];

  for (const salt of SALT_B5) {
    const mcr = await fungibleOrderbook.connect(client1).commit(
      computeOrderHash(client1.address, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_SMALL, TOKEN_AMOUNT_SMALL, Side.SELL, true, salt),
      CommitType.Order
    );
    const mcrReceipt = await mcr.wait();
    if (!mcrReceipt) throw new Error(`Transaction failed: maker commit (${salt})`);
    const mArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), mcrReceipt.blockNumber);
    const mCommitId = mArgs.commitId as bigint;
    const mReveal = await fungibleOrderbook.connect(client1).revealOrder(mCommitId, tokenAAddress, tokenBAddress, TOKEN_AMOUNT_SMALL, TOKEN_AMOUNT_SMALL, Side.SELL, true, salt);
    const mRevealReceipt = await mReveal.wait();
    if (!mRevealReceipt) throw new Error(`Transaction failed: maker reveal (${salt})`);
    const mOArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.OrderPlaced(), mRevealReceipt.blockNumber);
    const mOrderId = mOArgs.orderId as bigint;

    const tcr = await fungibleOrderbook.connect(client2).commit(
      computeTakeHash(client2.address, mOrderId, TOKEN_AMOUNT_SMALL, salt),
      CommitType.Take
    );
    const tcrReceipt = await tcr.wait();
    if (!tcrReceipt) throw new Error(`Transaction failed: taker commit (${salt})`);
    const tArgs = await getLatestEventArgs(fungibleOrderbook, fungibleOrderbook.filters.Committed(), tcrReceipt.blockNumber);
    const tCommitId = tArgs.commitId as bigint;
    await fungibleOrderbook.connect(client2).revealTake(tCommitId, mOrderId, TOKEN_AMOUNT_SMALL, salt);
  }

  await sleep((SETTLEMENT_WINDOW_SECONDS + 10) * 1000);
  await measureTx(rows, "SettlementEngine.performUpkeep (batch=5)", () => settlementEngine.connect(client3).performUpkeep("0x"));

  console.log("\nBenchmark summary");
  console.table(rows);

  const pairs: [string, string, string][] = [
    ["FungibleOrderbook.commit(to cancel)", "FungibleOrderbook.revealOrder(to cancel)", "FungibleOrderbook: place order (to cancel)"],
    ["FungibleOrderbook.commit(to be taken)", "FungibleOrderbook.revealOrder(to be taken)", "FungibleOrderbook: place order (to be taken)"],
    ["FungibleOrderbook.commit(take)", "FungibleOrderbook.revealTake", "FungibleOrderbook: take order"],
    ["FungibleOrderbook.commit(maker to match)", "FungibleOrderbook.revealOrder(maker to match)", "FungibleOrderbook: place order (maker to match)"],
    ["FungibleOrderbook.commit(taker counter order)", "FungibleOrderbook.revealOrder(taker counter order)", "FungibleOrderbook: place order (taker counter order)"],
    ["NFTOrderbook.commit listing(to cancel)", "NFTOrderbook.revealNFTList", "NFTOrderbook: list NFT (to cancel)"],
    ["NFTOrderbook.commit offer(to cancel)", "NFTOrderbook.revealNFTOffer", "NFTOrderbook: offer NFT (to cancel)"],
    ["NFTOrderbook.commit listing(to match)", "NFTOrderbook.revealNFTList(match)", "NFTOrderbook: list NFT (to match)"],
    ["NFTOrderbook.commit offer(to match)", "NFTOrderbook.revealNFTOffer(match)", "NFTOrderbook: offer NFT (to match)"],
  ];

  const pairRows: { operation: string; commitGas: string; revealGas: string; totalGas: string; commitTxHash?: string; revealTxHash?: string }[] = [];
  for (const [commitLabel, revealLabel, friendlyLabel] of pairs) {
    const commitRow = rows.find((r) => r.operation === commitLabel);
    const revealRow = rows.find((r) => r.operation === revealLabel);
    if (!commitRow || !revealRow) {
      console.warn(`Missing row for pair: ${commitLabel} / ${revealLabel}`);
      continue;
    }

    const commitGas = BigInt(commitRow.gasUsed);
    const revealGas = BigInt(revealRow.gasUsed);
    pairRows.push({
      operation: friendlyLabel,
      commitGas: commitGas.toString(),
      revealGas: revealGas.toString(),
      totalGas: (commitGas + revealGas).toString(),
      commitTxHash: commitRow.txHash,
      revealTxHash: revealRow.txHash,
    });
  }

  console.log("\nCommit+Reveal paired totals:");
  console.table(pairRows);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
