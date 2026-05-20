import { network } from "hardhat";

const { ethers } = await network.connect();

const CommitType = { Order: 0, Take: 1, NFTList: 0, NFTOffer: 1 };
const Side = { BUY: 0, SELL: 1 };
const UserStatus = { Allowed: 0, BlacklistedWithWithdrawal: 1, Blacklisted: 2 };
const AssetType = { ERC20: 0, ERC721: 1 };

const TOKEN_AMOUNT = ethers.parseUnits("100", 18);
const TOKEN_AMOUNT_SMALL = ethers.parseUnits("25", 18);
const TOKEN_AMOUNT_LARGE = ethers.parseUnits("200", 18);
const TOKEN_DEPOSIT = ethers.parseUnits("10000", 18);
const ETH_DEPOSIT = ethers.parseEther("1");
const NFT_PAYMENT_AMOUNT = ethers.parseUnits("200", 18);
const SALT = ethers.encodeBytes32String("hardhat-eval");
const SETTLEMENT_WINDOW_SECONDS = 120;
const MAX_APPROVAL = (1n << 256n) - 1n;

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

type GasRow = {
  operation: string;
  gasUsed: string;
};

async function getLatestEventArgs(contract: any, filter: any, blockNumber: number) {
  const events = await contract.queryFilter(filter, blockNumber, blockNumber);

  if (events.length === 0) {
    throw new Error(`No event found for block ${blockNumber}`);
  }

  return events[events.length - 1].args;
}

async function measureTx(rows: GasRow[], label: string, txFactory: () => Promise<any>): Promise<any> {
  const tx = await txFactory();
  const receipt = await tx.wait();

  rows.push({ operation: label, gasUsed: receipt.gasUsed.toString() });
  console.log(`${label}: ${receipt.gasUsed.toString()} gas`);

  return receipt;
}

async function main() {
  const rows: GasRow[] = [];

  const [admin, client1, client2, , client3] = await ethers.getSigners();

  const tokenA = await ethers.deployContract("MockERC20", ["TokenA", "TKA", 18]);
  const tokenB = await ethers.deployContract("MockERC20", ["TokenB", "TKB", 18]);
  const nftCollection = await ethers.deployContract("MockERC721", ["CollectionA", "CLXA"]);
  const otherNFTCollection = await ethers.deployContract("MockERC721", ["CollectionB", "CLXB"]);
  const mockLendingPool = await ethers.deployContract("MockLendingPool");
  const mockWeth = await ethers.deployContract("MockWETH");

  const complianceManager = await ethers.deployContract("ComplianceManager");
  const fungibleOrderbook = await ethers.deployContract("FungibleOrderbook", [complianceManager.target]);
  const nftOrderbook = await ethers.deployContract("NFTOrderbook", [complianceManager.target]);
  const custodian = await ethers.deployContract("Custodian", [
    complianceManager.target,
    mockLendingPool.target,
    mockWeth.target,
  ]);
  const settlementEngine = await ethers.deployContract("SettlementEngine", [
    complianceManager.target,
    SETTLEMENT_WINDOW_SECONDS,
    10,
  ]);

  await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA");
  await tokenA.connect(admin).mint(admin.address, TOKEN_AMOUNT_LARGE);
  await tokenA.connect(admin).approve(mockLendingPool.target, TOKEN_AMOUNT_LARGE);
  await mockLendingPool.connect(admin).addLiquidity(tokenA.target, TOKEN_AMOUNT_LARGE);

  const tokenAUnderlyingAddress = String(tokenA.target);
  const tokenAAddress = String(await mockLendingPool.getAToken(tokenA.target));
  let tokenBAddress = String(tokenB.target);

  await fungibleOrderbook.connect(admin).initialize(custodian.target, settlementEngine.target);
  await nftOrderbook.connect(admin).initialize(custodian.target, settlementEngine.target);
  await custodian.connect(admin).initialize(fungibleOrderbook.target, nftOrderbook.target, settlementEngine.target);
  await settlementEngine.connect(admin).initialize(fungibleOrderbook.target, nftOrderbook.target, custodian.target);

  await measureTx(rows, "ComplianceManager.pause", () => complianceManager.connect(admin).pause());
  await measureTx(rows, "ComplianceManager.unpause", () => complianceManager.connect(admin).unpause());
  await measureTx(rows, "ComplianceManager.blacklistToken", () =>
    complianceManager.connect(admin).blacklistToken(otherNFTCollection.target)
  );
  await measureTx(rows, "ComplianceManager.unblacklistToken", () =>
    complianceManager.connect(admin).unblacklistToken(otherNFTCollection.target)
  );
  await measureTx(rows, "ComplianceManager.setUserStatus(blacklist)", () =>
    complianceManager.connect(admin).setUserStatus(client3.address, UserStatus.BlacklistedWithWithdrawal)
  );
  await measureTx(rows, "ComplianceManager.setUserStatus(allow)", () =>
    complianceManager.connect(admin).setUserStatus(client3.address, UserStatus.Allowed)
  );

  await measureTx(rows, "SettlementEngine.setSettlementWindow", () =>
    settlementEngine.connect(admin).setSettlementWindow(SETTLEMENT_WINDOW_SECONDS)
  );
  await measureTx(rows, "SettlementEngine.setMaxBatchSize", () =>
    settlementEngine.connect(admin).setMaxBatchSize(20)
  );

  for (const client of [client1, client2, client3]) {
    await tokenA.mint(client.address, TOKEN_DEPOSIT + TOKEN_AMOUNT_LARGE);
    await tokenB.mint(client.address, TOKEN_DEPOSIT + TOKEN_AMOUNT_LARGE);
    await tokenA.connect(client).approve(custodian.target, MAX_APPROVAL);
    await tokenB.connect(client).approve(custodian.target, MAX_APPROVAL);
    await custodian.connect(client).deposit(tokenAUnderlyingAddress, TOKEN_DEPOSIT);
    await custodian.connect(client).deposit(String(tokenB.target), TOKEN_DEPOSIT);
  }

  await nftCollection.mint(client1.address, 1);
  await nftCollection.mint(client2.address, 2);
  await nftCollection.mint(client1.address, 3);
  await nftCollection.mint(client1.address, 4);
  await nftCollection.connect(client1).approve(custodian.target, 1);
  await nftCollection.connect(client2).approve(custodian.target, 2);
  await nftCollection.connect(client1).approve(custodian.target, 3);
  await nftCollection.connect(client1).approve(custodian.target, 4);

  await measureTx(rows, "Custodian.deposit(tokenA - with pool)", () =>
    custodian.connect(client1).deposit(tokenAUnderlyingAddress, TOKEN_AMOUNT_LARGE)
  );
  await measureTx(rows, "Custodian.withdraw(tokenA - with pool)", () =>
    custodian.connect(client1).withdraw(tokenAAddress, TOKEN_AMOUNT_SMALL, false)
  );
  await measureTx(rows, "Custodian.deposit(tokenB - without pool)", () =>
    custodian.connect(client1).deposit(String(tokenB.target), TOKEN_AMOUNT_SMALL)
  );
  await measureTx(rows, "Custodian.withdraw(tokenB - without pool)", () =>
    custodian.connect(client1).withdraw(String(tokenB.target), TOKEN_AMOUNT_SMALL, false)
  );
  await measureTx(rows, "Custodian.depositETH", () =>
    custodian.connect(client1).depositETH({ value: ETH_DEPOSIT })
  );
  await measureTx(rows, "Custodian.withdrawETH", () =>
    custodian.connect(client1).withdrawETH(ethers.parseEther("0.25"))
  );
  await measureTx(rows, "Custodian.depositNFT", () =>
    custodian.connect(client1).depositNFT(nftCollection.target, 3)
  );
  await measureTx(rows, "Custodian.withdrawNFT", () =>
    custodian.connect(client1).withdrawNFT(nftCollection.target, 3)
  );

  await custodian.connect(client1).depositNFT(nftCollection.target, 4);

  const unmatchedCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(to cancel)", () =>
    fungibleOrderbook.connect(client1).commit(
      computeOrderHash(
        client1.address,
        tokenAAddress,
        tokenBAddress,
        TOKEN_AMOUNT_LARGE,
        TOKEN_AMOUNT_SMALL,
        Side.SELL,
        true,
        SALT
      ),
      CommitType.Order
    )
  );
  const unmatchedCommitArgs = await getLatestEventArgs(
    fungibleOrderbook,
    fungibleOrderbook.filters.Committed(),
    unmatchedCommitReceipt.blockNumber
  );
  const unmatchedCommitId = unmatchedCommitArgs.commitId as bigint;
  const unmatchedRevealReceipt = await measureTx(rows, "FungibleOrderbook.revealOrder(to cancel)", () =>
    fungibleOrderbook.connect(client1).revealOrder(
      unmatchedCommitId,
      tokenAAddress,
      tokenBAddress,
      TOKEN_AMOUNT_LARGE,
      TOKEN_AMOUNT_SMALL,
      Side.SELL,
      true,
      SALT
    )
  );
  const unmatchedOrderArgs = await getLatestEventArgs(
    fungibleOrderbook,
    fungibleOrderbook.filters.OrderPlaced(),
    unmatchedRevealReceipt.blockNumber
  );
  const unmatchedOrderId = unmatchedOrderArgs.orderId as bigint;
  await measureTx(rows, "FungibleOrderbook.cancelOrder", () =>
    fungibleOrderbook.connect(client1).cancelOrder(unmatchedOrderId)
  );
  // Token B kept without a lending pool to compare deposit gas against Token A (which has a pool)

  const makerCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(to be taken)", () =>
    fungibleOrderbook.connect(client1).commit(
      computeOrderHash(
        client1.address,
        tokenAAddress,
        tokenBAddress,
        TOKEN_AMOUNT,
        TOKEN_AMOUNT,
        Side.SELL,
        true,
        SALT
      ),
      CommitType.Order
    )
  );
  const makerCommitArgs = await getLatestEventArgs(
    fungibleOrderbook,
    fungibleOrderbook.filters.Committed(),
    makerCommitReceipt.blockNumber
  );
  const makerCommitId = makerCommitArgs.commitId as bigint;
  const makerOrderReceipt = await measureTx(rows, "FungibleOrderbook.revealOrder(to be taken)", () =>
    fungibleOrderbook.connect(client1).revealOrder(
      makerCommitId,
      tokenAAddress,
      tokenBAddress,
      TOKEN_AMOUNT,
      TOKEN_AMOUNT,
      Side.SELL,
      true,
      SALT
    )
  );
  const makerOrderArgs = await getLatestEventArgs(
    fungibleOrderbook,
    fungibleOrderbook.filters.OrderPlaced(),
    makerOrderReceipt.blockNumber
  );
  const makerOrderId = makerOrderArgs.orderId as bigint;

  const takerCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(take)", () =>
    fungibleOrderbook.connect(client2).commit(
      computeTakeHash(client2.address, makerOrderId, TOKEN_AMOUNT, SALT),
      CommitType.Take
    )
  );
  const takerCommitArgs = await getLatestEventArgs(
    fungibleOrderbook,
    fungibleOrderbook.filters.Committed(),
    takerCommitReceipt.blockNumber
  );
  const takerCommitId = takerCommitArgs.commitId as bigint;
  await measureTx(rows, "FungibleOrderbook.revealTake", () =>
    fungibleOrderbook.connect(client2).revealTake(takerCommitId, makerOrderId, TOKEN_AMOUNT, SALT)
  );

  await measureTx(rows, "SettlementEngine.settleBatch (batch=1)", async () => {
    await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW_SECONDS + 1]);
    await ethers.provider.send("evm_mine", []);
    return settlementEngine.connect(client3).settleBatch();
  });

  // ── settleBatch batch=3 ──────────────────────────────────────────────────
  const SALT_SB3 = [
    ethers.encodeBytes32String("sb3-a"),
    ethers.encodeBytes32String("sb3-b"),
    ethers.encodeBytes32String("sb3-c"),
  ];

  for (const salt of SALT_SB3) {
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

  await measureTx(rows, "SettlementEngine.settleBatch (batch=3)", async () => {
    await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW_SECONDS + 1]);
    await ethers.provider.send("evm_mine", []);
    return settlementEngine.connect(client3).settleBatch();
  });

  // ── settleBatch batch=5 ──────────────────────────────────────────────────
  const SALT_SB5 = [
    ethers.encodeBytes32String("sb5-a"),
    ethers.encodeBytes32String("sb5-b"),
    ethers.encodeBytes32String("sb5-c"),
    ethers.encodeBytes32String("sb5-d"),
    ethers.encodeBytes32String("sb5-e"),
  ];

  for (const salt of SALT_SB5) {
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

  await measureTx(rows, "SettlementEngine.settleBatch (batch=5)", async () => {
    await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW_SECONDS + 1]);
    await ethers.provider.send("evm_mine", []);
    return settlementEngine.connect(client3).settleBatch();
  });

  const exactMakerCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(maker to match)", () =>
    fungibleOrderbook.connect(client1).commit(
      computeOrderHash(
        client1.address,
        tokenAAddress,
        tokenBAddress,
        TOKEN_AMOUNT,
        TOKEN_AMOUNT,
        Side.SELL,
        true,
        SALT
      ),
      CommitType.Order
    )
  );
  const exactMakerCommitArgs = await getLatestEventArgs(
    fungibleOrderbook,
    fungibleOrderbook.filters.Committed(),
    exactMakerCommitReceipt.blockNumber
  );
  const exactMakerCommitId = exactMakerCommitArgs.commitId as bigint;
  const exactMakerRevealReceipt = await measureTx(rows, "FungibleOrderbook.revealOrder(maker to match)", () =>
    fungibleOrderbook.connect(client1).revealOrder(
      exactMakerCommitId,
      tokenAAddress,
      tokenBAddress,
      TOKEN_AMOUNT,
      TOKEN_AMOUNT,
      Side.SELL,
      true,
      SALT
    )
  );
  const exactMakerOrderArgs = await getLatestEventArgs(
    fungibleOrderbook,
    fungibleOrderbook.filters.OrderPlaced(),
    exactMakerRevealReceipt.blockNumber
  );
  const exactMakerOrderId = exactMakerOrderArgs.orderId as bigint;

  const exactCounterCommitReceipt = await measureTx(rows, "FungibleOrderbook.commit(taker counter order)", () =>
    fungibleOrderbook.connect(client2).commit(
      computeOrderHash(
        client2.address,
        tokenBAddress,
        tokenAAddress,
        TOKEN_AMOUNT,
        TOKEN_AMOUNT,
        Side.BUY,
        true,
        SALT
      ),
      CommitType.Order
    )
  );
  const exactCounterCommitArgs = await getLatestEventArgs(
    fungibleOrderbook,
    fungibleOrderbook.filters.Committed(),
    exactCounterCommitReceipt.blockNumber
  );
  const exactCounterCommitId = exactCounterCommitArgs.commitId as bigint;
  await measureTx(rows, "FungibleOrderbook.revealOrder(taker counter order)", () =>
    fungibleOrderbook.connect(client2).revealOrder(
      exactCounterCommitId,
      tokenBAddress,
      tokenAAddress,
      TOKEN_AMOUNT,
      TOKEN_AMOUNT,
      Side.BUY,
      true,
      SALT
    )
  );

  const listingCancelCommitReceipt = await measureTx(rows, "NFTOrderbook.commit listing(to cancel)", () =>
    nftOrderbook.connect(client1).commit(
      computeNFTListHash(
        client1.address,
        String(nftCollection.target),
        4n,
        AssetType.ERC20,
        tokenAAddress,
        NFT_PAYMENT_AMOUNT,
        0n,
        SALT
      ),
      CommitType.NFTList
    )
  );
  const listingCancelCommitArgs = await getLatestEventArgs(
    nftOrderbook,
    nftOrderbook.filters.Committed(),
    listingCancelCommitReceipt.blockNumber
  );
  const listingCancelCommitId = listingCancelCommitArgs.commitId as bigint;
  await measureTx(rows, "NFTOrderbook.revealNFTList", () =>
    nftOrderbook.connect(client1).revealNFTList(
      listingCancelCommitId,
      nftCollection.target,
      4,
      AssetType.ERC20,
      tokenAAddress,
      NFT_PAYMENT_AMOUNT,
      0n,
      SALT
    )
  );
  await measureTx(rows, "NFTOrderbook.cancelNFTListing", () =>
    nftOrderbook.connect(client1).cancelNFTListing(1)
  );

  const offerCancelCommitReceipt = await measureTx(rows, "NFTOrderbook.commit offer(to cancel)", () =>
    nftOrderbook.connect(client2).commit(
      computeNFTOfferHash(
        client2.address,
        String(nftCollection.target),
        999n,
        AssetType.ERC20,
        tokenAAddress,
        NFT_PAYMENT_AMOUNT,
        0n,
        SALT
      ),
      CommitType.NFTOffer
    )
  );
  const offerCancelCommitArgs = await getLatestEventArgs(
    nftOrderbook,
    nftOrderbook.filters.Committed(),
    offerCancelCommitReceipt.blockNumber
  );
  const offerCancelCommitId = offerCancelCommitArgs.commitId as bigint;
  await measureTx(rows, "NFTOrderbook.revealNFTOffer", () =>
    nftOrderbook.connect(client2).revealNFTOffer(
      offerCancelCommitId,
      nftCollection.target,
      999,
      AssetType.ERC20,
      tokenAAddress,
      NFT_PAYMENT_AMOUNT,
      0n,
      SALT
    )
  );
  await measureTx(rows, "NFTOrderbook.cancelNFTOffer", () =>
    nftOrderbook.connect(client2).cancelNFTOffer(1)
  );

  await nftCollection.connect(client1).approve(custodian.target, 1);
  await nftCollection.connect(client2).approve(custodian.target, 2);
  await custodian.connect(client1).depositNFT(nftCollection.target, 1);
  await custodian.connect(client2).depositNFT(nftCollection.target, 2);

  const nftMatchListingCommitReceipt = await measureTx(rows, "NFTOrderbook.commit listing(to match)", () =>
    nftOrderbook.connect(client1).commit(
      computeNFTListHash(
        client1.address,
        String(nftCollection.target),
        1n,
        AssetType.ERC20,
        tokenAAddress,
        NFT_PAYMENT_AMOUNT,
        0n,
        SALT
      ),
      CommitType.NFTList
    )
  );
  const nftMatchListingCommitArgs = await getLatestEventArgs(
    nftOrderbook,
    nftOrderbook.filters.Committed(),
    nftMatchListingCommitReceipt.blockNumber
  );
  const nftMatchListingCommitId = nftMatchListingCommitArgs.commitId as bigint;
  await measureTx(rows, "NFTOrderbook.revealNFTList(match)", () =>
    nftOrderbook.connect(client1).revealNFTList(
      nftMatchListingCommitId,
      nftCollection.target,
      1,
      AssetType.ERC20,
      tokenAAddress,
      NFT_PAYMENT_AMOUNT,
      0n,
      SALT
    )
  );

  const nftMatchOfferCommitReceipt = await measureTx(rows, "NFTOrderbook.commit offer(to match)", () =>
    nftOrderbook.connect(client2).commit(
      computeNFTOfferHash(
        client2.address,
        String(nftCollection.target),
        1n,
        AssetType.ERC20,
        tokenAAddress,
        NFT_PAYMENT_AMOUNT,
        0n,
        SALT
      ),
      CommitType.NFTOffer
    )
  );
  const nftMatchOfferCommitArgs = await getLatestEventArgs(
    nftOrderbook,
    nftOrderbook.filters.Committed(),
    nftMatchOfferCommitReceipt.blockNumber
  );
  const nftMatchOfferCommitId = nftMatchOfferCommitArgs.commitId as bigint;
  await measureTx(rows, "NFTOrderbook.revealNFTOffer(match)", () =>
    nftOrderbook.connect(client2).revealNFTOffer(
      nftMatchOfferCommitId,
      nftCollection.target,
      1,
      AssetType.ERC20,
      tokenAAddress,
      NFT_PAYMENT_AMOUNT,
      0n,
      SALT
    )
  );

  // Settle the pending NFT trade first (batch of 1)
  await measureTx(rows, "SettlementEngine.performUpkeep (batch=1)", async () => {
    await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW_SECONDS + 1]);
    await ethers.provider.send("evm_mine", []);
    return settlementEngine.connect(client3).performUpkeep("0x");
  });

  // ── Batch of 3 ──────────────────────────────────────────────────
  // Need 3 matched pairs: reuse client1 (seller) vs client2 (buyer) for 3 fungible trades
  const SALT_B3 = [
    ethers.encodeBytes32String("batch3-a"),
    ethers.encodeBytes32String("batch3-b"),
    ethers.encodeBytes32String("batch3-c"),
  ];

  for (const salt of SALT_B3) {
    // maker commit+reveal
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

    // taker commit+reveal
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

  await measureTx(rows, "SettlementEngine.performUpkeep (batch=3)", async () => {
    await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW_SECONDS + 1]);
    await ethers.provider.send("evm_mine", []);
    return settlementEngine.connect(client3).performUpkeep("0x");
  });

  // ── Batch of 5 ──────────────────────────────────────────────────
  const SALT_B5 = [
    ethers.encodeBytes32String("batch5-a"),
    ethers.encodeBytes32String("batch5-b"),
    ethers.encodeBytes32String("batch5-c"),
    ethers.encodeBytes32String("batch5-d"),
    ethers.encodeBytes32String("batch5-e"),
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

  await measureTx(rows, "SettlementEngine.performUpkeep (batch=5)", async () => {
    await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW_SECONDS + 1]);
    await ethers.provider.send("evm_mine", []);
    return settlementEngine.connect(client3).performUpkeep("0x");
  });

  console.log("\nGas summary");
  console.table(rows);

  // Commit+Reveal paired totals
  const pairs: [string, string, string][] = [
    ["FungibleOrderbook.commit(to cancel)",            "FungibleOrderbook.revealOrder(to cancel)",             "FungibleOrderbook: place order (to cancel)"],
    ["FungibleOrderbook.commit(to be taken)",          "FungibleOrderbook.revealOrder(to be taken)",           "FungibleOrderbook: place order (to be taken)"],
    ["FungibleOrderbook.commit(take)",                 "FungibleOrderbook.revealTake",                         "FungibleOrderbook: take order"],
    ["FungibleOrderbook.commit(maker to match)",       "FungibleOrderbook.revealOrder(maker to match)",        "FungibleOrderbook: place order (maker to match)"],
    ["FungibleOrderbook.commit(taker counter order)",  "FungibleOrderbook.revealOrder(taker counter order)",   "FungibleOrderbook: place order (taker counter order)"],
    ["NFTOrderbook.commit listing(to cancel)",         "NFTOrderbook.revealNFTList",                           "NFTOrderbook: list NFT (to cancel)"],
    ["NFTOrderbook.commit offer(to cancel)",           "NFTOrderbook.revealNFTOffer",                          "NFTOrderbook: offer NFT (to cancel)"],
    ["NFTOrderbook.commit listing(to match)",          "NFTOrderbook.revealNFTList(match)",                    "NFTOrderbook: list NFT (to match)"],
    ["NFTOrderbook.commit offer(to match)",             "NFTOrderbook.revealNFTOffer(match)",                   "NFTOrderbook: offer NFT (to match)"],
  ];

  const pairRows: { operation: string; commitGas: string; revealGas: string; totalGas: string }[] = [];

  for (const [commitLabel, revealLabel, friendlyLabel] of pairs) {
    const commitRow = rows.find(r => r.operation === commitLabel);
    const revealRow = rows.find(r => r.operation === revealLabel);
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
    });
  }

  console.log("\nCommit+Reveal paired totals:");
  console.table(pairRows);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});