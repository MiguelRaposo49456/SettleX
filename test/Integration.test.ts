import { expect } from "chai";
import { network } from "hardhat";
import { deploySystem } from "./utils/deploy.js";

const { ethers } = await network.connect();

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));

const CommitType = { Order: 0, Take: 1, NFTList: 0, NFTOffer: 1 };
const Side       = { BUY: 0, SELL: 1 };
const Status     = { Inactive: 0, Matched: 1, Active: 2 };
const NFTStatus  = { Inactive: 0, Active: 1 };
const UserStatus = { Allowed: 0, BlacklistedWithWithdrawal: 1, Blacklisted: 2 };
const AssetType  = { ERC20: 0, ERC721: 1 };

const PRICE_PRECISION = ethers.parseUnits("1", 18);
const DEPOSIT         = ethers.parseUnits("10000", 18);
const SALT            = ethers.encodeBytes32String("secret");
const SETTLEMENT_WINDOW = 300; // 5 minutes

//----------------------------------------------Token amounts------------------------------------------------------
//                      Price = 2 tokenA per tokenB
//   SELL: give 100 tokenB (amountOut), want 200 tokenA (amountIn)
//   BUY:  give 200 tokenA (amountOut), want 100 tokenB (amountIn)
const SELL_AMOUNT_OUT = ethers.parseUnits("100", 18);
const SELL_AMOUNT_IN  = ethers.parseUnits("200", 18);
const BUY_AMOUNT_OUT  = ethers.parseUnits("200", 18);
const BUY_AMOUNT_IN   = ethers.parseUnits("100", 18);

//----------------------------------------------Off-chain Helpers--------------------------------------------------

function computeOrderHash(
    sender: string,
    tokenIn: string, tokenOut: string,
    amountIn: bigint, amountOut: bigint,
    side: number, partialAllowed: boolean, salt: string
): string {
    return ethers.solidityPackedKeccak256(
        ["address","address","address","uint256","uint256","uint8","bool","bytes32"],
        [sender, tokenIn, tokenOut, amountIn, amountOut, side, partialAllowed, salt]
    );
}

function computeTakeHash(
    sender: string, makerOrderId: bigint, takerAmount: bigint, salt: string
): string {
    return ethers.solidityPackedKeccak256(
        ["address","uint256","uint256","bytes32"],
        [sender, makerOrderId, takerAmount, salt]
    );
}

function computeNFTListHash(
    sender: string, collection: string, tokenId: bigint,
    paymentType: number, paymentToken: string,
    paymentAmount: bigint, paymentTokenId: bigint, salt: string
): string {
    return ethers.solidityPackedKeccak256(
        ["address","address","uint256","uint8","address","uint256","uint256","bytes32"],
        [sender, collection, tokenId, paymentType, paymentToken, paymentAmount, paymentTokenId, salt]
    );
}

function computeNFTOfferHash(
    sender: string, collection: string, tokenId: bigint,
    offerType: number, offerToken: string,
    offerAmount: bigint, offerTokenId: bigint, salt: string
): string {
    return ethers.solidityPackedKeccak256(
        ["address","address","uint256","uint8","address","uint256","uint256","bytes32"],
        [sender, collection, tokenId, offerType, offerToken, offerAmount, offerTokenId, salt]
    );
}

//----------------------------------------------Test Suite--------------------------------------------------

describe("Integration Tests — Full System", function () {

    let admin: any, operator: any, client1: any, client2: any, client3: any;
    let complianceManager: any, fungibleOrderbook: any, nftOrderbook: any;
    let custodian: any, settlementEngine: any;
    let tokenA: any, tokenB: any, nftCollection: any;

    //---------------------------------------------Helpers------------------------------------------------------

    /**
     * SELL: client gives tokenB (amountOut), wants tokenA (amountIn)
     * tokenIn  = tokenA
     * tokenOut = tokenB
     */
    async function placeSell(
        client: any,
        amountOut: bigint,
        amountIn: bigint,
        partial = true,
        salt = SALT
    ): Promise<bigint> {
        const hash = computeOrderHash(
            client.address,
            tokenA.target, tokenB.target,
            amountIn, amountOut,
            Side.SELL, partial, salt
        );
        const tx = await fungibleOrderbook.connect(client).commit(hash, CommitType.Order);
        const r  = await tx.wait();
        await fungibleOrderbook.connect(client).revealOrder(
            r.logs[0].args[0],
            tokenA.target, tokenB.target,
            amountIn, amountOut,
            Side.SELL, partial, salt
        );
        const events = await fungibleOrderbook.queryFilter(
            fungibleOrderbook.filters.OrderPlaced(), r.blockNumber
        );
        return events[events.length - 1].args.orderId;
    }

    /**
     * BUY: client gives tokenA (amountOut), wants tokenB (amountIn)
     * tokenIn  = tokenB
     * tokenOut = tokenA
     */
    async function placeBuy(
        client: any,
        amountOut: bigint,
        amountIn: bigint,
        partial = true,
        salt = SALT
    ): Promise<bigint> {
        const hash = computeOrderHash(
            client.address,
            tokenB.target, tokenA.target,
            amountIn, amountOut,
            Side.BUY, partial, salt
        );
        const tx = await fungibleOrderbook.connect(client).commit(hash, CommitType.Order);
        const r  = await tx.wait();
        await fungibleOrderbook.connect(client).revealOrder(
            r.logs[0].args[0],
            tokenB.target, tokenA.target,
            amountIn, amountOut,
            Side.BUY, partial, salt
        );
        const events = await fungibleOrderbook.queryFilter(
            fungibleOrderbook.filters.OrderPlaced(), r.blockNumber
        );
        return events[events.length - 1].args.orderId;
    }

    async function revealTake(
        client: any, makerOrderId: bigint, takerAmount: bigint, salt = SALT
    ): Promise<void> {
        const hash = computeTakeHash(client.address, makerOrderId, takerAmount, salt);
        const tx = await fungibleOrderbook.connect(client).commit(hash, CommitType.Take);
        const r  = await tx.wait();
        await fungibleOrderbook.connect(client).revealTake(
            r.logs[0].args[0], makerOrderId, takerAmount, salt
        );
    }

    async function listNFT(
        client: any, tokenId: bigint, paymentAmount: bigint, salt = SALT
    ): Promise<bigint> {
        const hash = computeNFTListHash(
            client.address, nftCollection.target, tokenId,
            AssetType.ERC20, tokenA.target, paymentAmount, 0n, salt
        );
        const tx = await nftOrderbook.connect(client).commit(hash, CommitType.NFTList);
        const r  = await tx.wait();
        await nftOrderbook.connect(client).revealNFTList(
            r.logs[0].args[0], nftCollection.target, tokenId,
            AssetType.ERC20, tokenA.target, paymentAmount, 0n, salt
        );
        const events = await nftOrderbook.queryFilter(
            nftOrderbook.filters.NFTListed(), r.blockNumber
        );
        return events[events.length - 1].args.listingId;
    }

    async function makeNFTOffer(
        client: any, tokenId: bigint, offerAmount: bigint, salt = SALT
    ): Promise<bigint> {
        const hash = computeNFTOfferHash(
            client.address, nftCollection.target, tokenId,
            AssetType.ERC20, tokenA.target, offerAmount, 0n, salt
        );
        const tx = await nftOrderbook.connect(client).commit(hash, CommitType.NFTOffer);
        const r  = await tx.wait();
        await nftOrderbook.connect(client).revealNFTOffer(
            r.logs[0].args[0], nftCollection.target, tokenId,
            AssetType.ERC20, tokenA.target, offerAmount, 0n, salt
        );
        const events = await nftOrderbook.queryFilter(
            nftOrderbook.filters.NFTOfferMade(), r.blockNumber
        );
        return events[events.length - 1].args.offerId;
    }

    async function expireWindow(): Promise<void> {
        await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
        await ethers.provider.send("evm_mine", []);
    }

    async function settle(): Promise<void> {
        await expireWindow();
        await settlementEngine.connect(client3).settleBatch();
    }

    // ─────────────────────────────────────────────────────────────────────────

    beforeEach(async function () {
        ({ admin, client1, client2, complianceManager, fungibleOrderbook, nftOrderbook,
           custodian, settlementEngine, tokenA, tokenB, nftCollection }
            = await deploySystem(ethers));

        [, , , operator, client3] = await ethers.getSigners();
        await complianceManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        for (const client of [client1, client2, client3]) {
            await tokenA.mint(client.address, DEPOSIT);
            await tokenB.mint(client.address, DEPOSIT);
            await tokenA.connect(client).approve(custodian.target, DEPOSIT);
            await tokenB.connect(client).approve(custodian.target, DEPOSIT);
            await custodian.connect(client).deposit(tokenA.target, DEPOSIT);
            await custodian.connect(client).deposit(tokenB.target, DEPOSIT);
        }

        // Mint and deposit NFTs
        await nftCollection.mint(client1.address, 1);
        await nftCollection.mint(client2.address, 2);
        await nftCollection.connect(client1).approve(custodian.target, 1);
        await nftCollection.connect(client2).approve(custodian.target, 2);
        await custodian.connect(client1).depositNFT(nftCollection.target, 1);
        await custodian.connect(client2).depositNFT(nftCollection.target, 2);
    });


    //------------------------ 1. DEPOSIT → ORDER → MATCH → SETTLE — end-to-end money flow ------------------------------

    describe("Full fungible trade lifecycle — deposit to settlement", function () {

        it("exact match: both orders fully filled, tokens land in correct balances", async function () {
            const c1TokenABefore = await custodian.balanceOf(client1.address, tokenA.target);
            const c2TokenBBefore = await custodian.balanceOf(client2.address, tokenB.target);

            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            const buyId  = await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);

            // Both should be Matched during the window
            expect((await fungibleOrderbook.getOrder(sellId)).status).to.equal(Status.Matched);
            expect((await fungibleOrderbook.getOrder(buyId)).status).to.equal(Status.Matched);

            await settle();

            expect((await fungibleOrderbook.getOrder(sellId)).status).to.equal(Status.Inactive);
            expect((await fungibleOrderbook.getOrder(buyId)).status).to.equal(Status.Inactive);

            // client1 (seller) gave tokenB, received tokenA
            expect(await custodian.balanceOf(client1.address, tokenA.target))
                .to.equal(c1TokenABefore + SELL_AMOUNT_IN);

            // client2 (buyer) gave tokenA, received tokenB
            expect(await custodian.balanceOf(client2.address, tokenB.target))
                .to.equal(c2TokenBBefore + BUY_AMOUNT_IN);
        });

        it("locked balances are zero after full settlement — no funds stuck", async function () {
            await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);
            await settle();

            expect(await custodian.lockedBalanceOf(client1.address, tokenB.target)).to.equal(0n);
            expect(await custodian.lockedBalanceOf(client2.address, tokenA.target)).to.equal(0n);
        });

        it("partial fill: taker smaller than maker — maker stays Active with reduced amount", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);

            // Buyer gives half the tokenA, wants half the tokenB
            const buyId = await placeBuy(
                client2, BUY_AMOUNT_OUT / 2n, BUY_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("half")
            );

            await settle();

            expect((await fungibleOrderbook.getOrder(buyId)).status).to.equal(Status.Inactive);
            const seller = await fungibleOrderbook.getOrder(sellId);
            expect(seller.status).to.equal(Status.Active);
            // Half was consumed — normalised amount halved
            expect(seller.amount).to.be.gt(0n);
        });

        it("partial fill: maker smaller than taker — taker stays Active", async function () {
            // Small sell: 50 tokenB for 100 tokenA
            const sellId = await placeSell(
                client1, SELL_AMOUNT_OUT / 2n, SELL_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("smallsell")
            );
            const buyId = await placeBuy(client2, BUY_AMOUNT_OUT, BUY_AMOUNT_IN);

            await settle();

            expect((await fungibleOrderbook.getOrder(sellId)).status).to.equal(Status.Inactive);
            const buyer = await fungibleOrderbook.getOrder(buyId);
            expect(buyer.status).to.equal(Status.Active);
            expect(buyer.amount).to.be.gt(0n);
        });

        it("one buyer sweeps two sell orders at the same price in FIFO order", async function () {
            const sell1 = await placeSell(
                client1, SELL_AMOUNT_OUT / 2n, SELL_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("s1")
            );
            const sell2 = await placeSell(
                client1, SELL_AMOUNT_OUT / 2n, SELL_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("s2")
            );
            const buyId = await placeBuy(client2, BUY_AMOUNT_OUT, BUY_AMOUNT_IN);

            await settle();

            expect((await fungibleOrderbook.getOrder(sell1)).status).to.equal(Status.Inactive);
            expect((await fungibleOrderbook.getOrder(sell2)).status).to.equal(Status.Inactive);
            expect((await fungibleOrderbook.getOrder(buyId)).status).to.equal(Status.Inactive);
        });

        it("no match when prices don't cross — neither order queued", async function () {
            // Sell 100 tokenB, want 400 tokenA (price = 4)
            await placeSell(
                client1, SELL_AMOUNT_OUT, ethers.parseUnits("400", 18),
                true, ethers.encodeBytes32String("highsell")
            );
            // Buy 100 tokenB, give 100 tokenA (price = 1)
            await placeBuy(
                client2, ethers.parseUnits("100", 18), BUY_AMOUNT_IN,
                true, ethers.encodeBytes32String("lowbuy")
            );

            const [upkeepNeeded] = await settlementEngine.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.false;
        });
    });


    //----------------------------------- 2. TAKE (revealTake) flow ----------------------------------------------

    describe("revealTake direct trade lifecycle", function () {

        it("full take: maker fully filled, seller receives tokenA", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            const c1Before = await custodian.balanceOf(client1.address, tokenA.target);

            const makerNormAmount = (await fungibleOrderbook.getOrder(sellId)).amount;
            await revealTake(client2, sellId, makerNormAmount);
            await settle();

            expect((await fungibleOrderbook.getOrder(sellId)).status).to.equal(Status.Inactive);
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.be.gt(c1Before);
        });

        it("partial take: maker amount reduced, remaining stays Active", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            const makerNorm = (await fungibleOrderbook.getOrder(sellId)).amount;
            const halfNorm  = makerNorm / 2n;

            await revealTake(client2, sellId, halfNorm);
            await settle();

            const maker = await fungibleOrderbook.getOrder(sellId);
            expect(maker.status).to.equal(Status.Active);
            expect(maker.amount).to.equal(makerNorm - halfNorm);
        });

        it("take with partial not allowed reverts PartialFillNotAllowed", async function () {
            const sellId = await placeSell(
                client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN,
                false // partialAllowed = false
            );
            const makerNorm = (await fungibleOrderbook.getOrder(sellId)).amount;
            const half = makerNorm / 2n;

            const hash = computeTakeHash(client2.address, sellId, half, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(hash, CommitType.Take);
            const r  = await tx.wait();

            await expect(
                fungibleOrderbook.connect(client2).revealTake(r.logs[0].args[0], sellId, half, SALT)
            ).to.be.revertedWithCustomError(fungibleOrderbook, "PartialFillNotAllowed");
        });
    });


    //------------------------------------ 3. NFT trade lifecycle ----------------------------------------------

    describe("Full NFT trade lifecycle", function () {

        it("NFT ERC-20 trade: NFT goes to buyer, payment goes to seller", async function () {
            const paymentAmount = ethers.parseUnits("500", 18);
            await listNFT(client1, 1n, paymentAmount);
            await makeNFTOffer(client2, 1n, paymentAmount);

            const c1Before = await custodian.balanceOf(client1.address, tokenA.target);
            await settle();

            const { held } = await custodian.nftBalanceOf(client2.address, nftCollection.target, 1n);
            expect(held).to.be.true;
            expect(await custodian.balanceOf(client1.address, tokenA.target))
                .to.equal(c1Before + paymentAmount);
        });

        it("listing and offer both Inactive after settlement", async function () {
            const paymentAmount = ethers.parseUnits("500", 18);
            const listingId = await listNFT(client1, 1n, paymentAmount);
            const offerId   = await makeNFTOffer(client2, 1n, paymentAmount);
            await settle();

            expect((await nftOrderbook.getNFTListing(listingId)).status).to.equal(NFTStatus.Inactive);
            expect((await nftOrderbook.getNFTOffer(offerId)).status).to.equal(NFTStatus.Inactive);
        });

        it("overpayment: buyer refunded the difference", async function () {
            const askPrice   = ethers.parseUnits("500", 18);
            const offerPrice = ethers.parseUnits("800", 18);

            await listNFT(client1, 1n, askPrice);
            await makeNFTOffer(client2, 1n, offerPrice, ethers.encodeBytes32String("bigOffer"));
            await settle();

            // Buyer locked 800, paid 500, got back 300 → locked should be 0
            expect(await custodian.lockedBalanceOf(client2.address, tokenA.target)).to.equal(0n);
            // Available reduced by the ask price
            expect(await custodian.balanceOf(client2.address, tokenA.target))
                .to.equal(DEPOSIT - askPrice);
        });

        it("NFT offer cancelled returns locked payment", async function () {
            const paymentAmount = ethers.parseUnits("500", 18);
            const offerId = await makeNFTOffer(client2, 1n, paymentAmount);
            const lockedBefore = await custodian.lockedBalanceOf(client2.address, tokenA.target);

            await nftOrderbook.connect(client2).cancelNFTOffer(offerId);

            expect(await custodian.lockedBalanceOf(client2.address, tokenA.target)).to.equal(0n);
            expect(lockedBefore).to.equal(paymentAmount);
        });

        it("NFT listing cancelled returns NFT to seller", async function () {
            const listingId = await listNFT(client1, 1n, ethers.parseUnits("500", 18));
            await nftOrderbook.connect(client1).cancelNFTListing(listingId);

            const { held, locked } = await custodian.nftBalanceOf(
                client1.address, nftCollection.target, 1n
            );
            expect(held).to.be.true;
            expect(locked).to.be.false;
        });
    });


    //------------------------------ 4. COMPLIANCE — end-to-end enforcement ------------------------------------------

    describe("Compliance enforcement across contracts", function () {

        it("blacklisted user cannot deposit", async function () {
            await complianceManager.connect(operator).setUserStatus(
                client1.address, UserStatus.Blacklisted
            );
            await tokenA.mint(client1.address, DEPOSIT);
            await tokenA.connect(client1).approve(custodian.target, DEPOSIT);
            await expect(
                custodian.connect(client1).deposit(tokenA.target, DEPOSIT)
            ).to.be.revertedWithCustomError(custodian, "UserNotAllowed");
        });

        it("blacklisted user cannot place an order", async function () {
            await complianceManager.connect(operator).setUserStatus(
                client1.address, UserStatus.Blacklisted
            );
            const hash = computeOrderHash(
                client1.address,
                tokenA.target, tokenB.target,
                SELL_AMOUNT_IN, SELL_AMOUNT_OUT,
                Side.SELL, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Order);
            const r  = await tx.wait();
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                r.logs[0].args[0],
                tokenA.target, tokenB.target,
                SELL_AMOUNT_IN, SELL_AMOUNT_OUT,
                Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "UserNotAllowed");
        });

        it("blacklisted token cannot be used in an order", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenA.target);
            const hash = computeOrderHash(
                client1.address,
                tokenA.target, tokenB.target,
                SELL_AMOUNT_IN, SELL_AMOUNT_OUT,
                Side.SELL, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Order);
            const r  = await tx.wait();
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                r.logs[0].args[0],
                tokenA.target, tokenB.target,
                SELL_AMOUNT_IN, SELL_AMOUNT_OUT,
                Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "TokenNotAllowed");
        });

        it("maker blacklisted after match — cancelled at settlement, taker reinstated", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            const buyId  = await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);

            await complianceManager.connect(operator).setUserStatus(
                client1.address, UserStatus.Blacklisted
            );
            await settle();

            expect((await fungibleOrderbook.getOrder(sellId)).status).to.equal(Status.Inactive);
            const buyer = await fungibleOrderbook.getOrder(buyId);
            expect(buyer.status).to.equal(Status.Active);
            expect(buyer.amount).to.equal(BUY_AMOUNT_OUT);
        });

        it("taker blacklisted after match — taker cancelled, maker reinstated", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            const buyId  = await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);

            await complianceManager.connect(operator).setUserStatus(
                client2.address, UserStatus.Blacklisted
            );
            await settle();

            expect((await fungibleOrderbook.getOrder(buyId)).status).to.equal(Status.Inactive);
            const seller = await fungibleOrderbook.getOrder(sellId);
            expect(seller.status).to.equal(Status.Active);
            expect(seller.amount).to.equal(SELL_AMOUNT_OUT);
        });

        it("token blacklisted after match — both orders cancelled, locked funds released", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            const buyId  = await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);

            await complianceManager.connect(operator).blacklistToken(tokenA.target);

            await settle();

            expect((await fungibleOrderbook.getOrder(sellId)).status).to.equal(Status.Inactive);
            expect((await fungibleOrderbook.getOrder(buyId)).status).to.equal(Status.Inactive);
            expect(await custodian.lockedBalanceOf(client1.address, tokenB.target)).to.equal(0n);
            expect(await custodian.lockedBalanceOf(client2.address, tokenA.target)).to.equal(0n);
        });

        it("system pause blocks all three contracts simultaneously", async function () {
            await complianceManager.connect(operator).pause();

            await expect(
                custodian.connect(client1).deposit(tokenA.target, ethers.parseUnits("1", 18))
            ).to.be.revertedWithCustomError(custodian, "SystemPaused");

            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target,
                SELL_AMOUNT_IN, SELL_AMOUNT_OUT, Side.SELL, true, SALT
            );
            await expect(
                fungibleOrderbook.connect(client1).commit(hash, CommitType.Order)
            ).to.be.revertedWithCustomError(fungibleOrderbook, "SystemPaused");

            await expect(
                settlementEngine.connect(client3).settleBatch()
            ).to.be.revertedWithCustomError(settlementEngine, "SystemPaused");
        });

        it("unpause restores full functionality", async function () {
            await complianceManager.connect(operator).pause();
            await complianceManager.connect(operator).unpause();

            const extraDeposit = ethers.parseUnits("1", 18);
            await tokenA.mint(client1.address, extraDeposit);
            await tokenA.connect(client1).approve(custodian.target, extraDeposit);

            await expect(
                custodian.connect(client1).deposit(tokenA.target, extraDeposit)
            ).to.not.be.revert(ethers);
        });

        it("BlacklistedWithWithdrawal: cannot place orders but can withdraw", async function () {
            await complianceManager.connect(operator).setUserStatus(
                client1.address, UserStatus.BlacklistedWithWithdrawal
            );
            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target,
                SELL_AMOUNT_IN, SELL_AMOUNT_OUT, Side.SELL, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Order);
            const r  = await tx.wait();
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                r.logs[0].args[0], tokenA.target, tokenB.target,
                SELL_AMOUNT_IN, SELL_AMOUNT_OUT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "UserNotAllowed");

            await expect(
                custodian.connect(client1).withdraw(tokenA.target, ethers.parseUnits("1", 18), false)
            ).to.not.be.revert(ethers);
        });

        it("NFT seller blacklisted after queuing — listing cancelled, buyer offer untouched", async function () {
            const paymentAmount = ethers.parseUnits("500", 18);
            const listingId = await listNFT(client1, 1n, paymentAmount);
            const offerId   = await makeNFTOffer(client2, 1n, paymentAmount);

            await complianceManager.connect(operator).setUserStatus(
                client1.address, UserStatus.Blacklisted
            );
            await expireWindow();
            await expect(settlementEngine.connect(client3).settleBatch())
                .to.emit(settlementEngine, "UserBlacklisted")
                .withArgs(client1.address);

            expect((await nftOrderbook.getNFTListing(listingId)).status).to.equal(NFTStatus.Inactive);
            // Offer stays active — buyer was not at fault
            expect((await nftOrderbook.getNFTOffer(offerId)).status).to.equal(NFTStatus.Active);
        });
    });


    //---------------------------------- 5. BATCH WINDOW AND MULTI-BATCH MECHANICS ------------------------------------------

    describe("Batch window and multi-batch mechanics", function () {

        it("two consecutive batch windows settle independently", async function () {
            const sell1 = await placeSell(
                client1, SELL_AMOUNT_OUT / 2n, SELL_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("b1s")
            );
            const buy1 = await placeBuy(
                client2, BUY_AMOUNT_OUT / 2n, BUY_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("b1b")
            );
            await settle();
            expect((await fungibleOrderbook.getOrder(sell1)).status).to.equal(Status.Inactive);
            expect((await fungibleOrderbook.getOrder(buy1)).status).to.equal(Status.Inactive);

            const sell2 = await placeSell(
                client1, SELL_AMOUNT_OUT / 2n, SELL_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("b2s")
            );
            const buy2 = await placeBuy(
                client2, BUY_AMOUNT_OUT / 2n, BUY_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("b2b")
            );
            await settle();
            expect((await fungibleOrderbook.getOrder(sell2)).status).to.equal(Status.Inactive);
            expect((await fungibleOrderbook.getOrder(buy2)).status).to.equal(Status.Inactive);
        });

        it("cannot settle before window expires", async function () {
            await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);
            await expect(
                settlementEngine.connect(client3).settleBatch()
            ).to.be.revertedWithCustomError(settlementEngine, "WindowNotExpired");
        });

        it("one failed trade in batch does not block others", async function () {
            // Trade 1 — maker will be cancelled mid-window
            const sell1 = await placeSell(
                client1, SELL_AMOUNT_OUT / 2n, SELL_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("fail")
            );
            await placeBuy(
                client2, BUY_AMOUNT_OUT / 2n, BUY_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("failbuy")
            );

            // Trade 2 — valid
            const sell2 = await placeSell(
                client1, SELL_AMOUNT_OUT / 2n, SELL_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("good")
            );
            const buy2 = await placeBuy(
                client2, BUY_AMOUNT_OUT / 2n, BUY_AMOUNT_IN / 2n,
                true, ethers.encodeBytes32String("goodbuy")
            );

            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sell1);

            await expireWindow();
            const tx = await settlementEngine.connect(client3).settleBatch();
            const receipt = await tx.wait();

            const batchEvent = receipt.logs
                .map((l: any) => { try { return settlementEngine.interface.parseLog(l); } catch { return null; } })
                .find((e: any) => e?.name === "BatchSettled");

            expect(batchEvent.args.tradesSettled).to.equal(1n);
            expect((await fungibleOrderbook.getOrder(sell2)).status).to.equal(Status.Inactive);
            expect((await fungibleOrderbook.getOrder(buy2)).status).to.equal(Status.Inactive);
        });

        it("fungible and NFT trades in same batch both settle", async function () {
            await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);

            const paymentAmount = ethers.parseUnits("500", 18);
            await listNFT(client1, 1n, paymentAmount);
            await makeNFTOffer(client2, 1n, paymentAmount);

            const batchId = await settlementEngine.currentBatchId();
            const { fungible, nft } = await settlementEngine.getBatchSize(batchId);
            expect(fungible).to.equal(1n);
            expect(nft).to.equal(1n);

            await settle();

            const { held } = await custodian.nftBalanceOf(client2.address, nftCollection.target, 1n);
            expect(held).to.be.true;
            expect(await custodian.lockedBalanceOf(client1.address, tokenB.target)).to.equal(0n);
        });

        it("operator-adjusted shorter window is respected", async function () {
            const shortWindow = 60n;
            await settlementEngine.connect(operator).setSettlementWindow(shortWindow);

            await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);

            await expect(
                settlementEngine.connect(client3).settleBatch()
            ).to.be.revertedWithCustomError(settlementEngine, "WindowNotExpired");

            await ethers.provider.send("evm_increaseTime", [Number(shortWindow) + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(
                settlementEngine.connect(client3).settleBatch()
            ).to.emit(settlementEngine, "BatchSettled");
        });
    });


    //----------------------------------- 6. CUSTODIAN — balance invariants -----------------------------------------------

    describe("Custodian balance invariants", function () {

        it("contract token balance covers all client available + locked", async function () {
            await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);

            const c1Avail  = await custodian.balanceOf(client1.address, tokenB.target);
            const c1Locked = await custodian.lockedBalanceOf(client1.address, tokenB.target);
            expect(await tokenB.balanceOf(custodian.target)).to.be.gte(c1Avail + c1Locked);
        });

        it("no funds leak: net tokenB change equals exactly what was traded", async function () {
            const { available: c1AvBefore, locked: c1LkBefore } =
                await custodian.fullBalanceOf(client1.address, tokenB.target);

            await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);
            await settle();

            const { available: c1AvAfter, locked: c1LkAfter } =
                await custodian.fullBalanceOf(client1.address, tokenB.target);

            expect(c1AvAfter + c1LkAfter)
                .to.equal(c1AvBefore + c1LkBefore - SELL_AMOUNT_OUT);
        });

        it("cancelled order returns exact locked amount — no residue in custodian", async function () {
            const buyId = await placeBuy(client2, BUY_AMOUNT_OUT, BUY_AMOUNT_IN);
            const locked    = await custodian.lockedBalanceOf(client2.address, tokenA.target);
            const available = await custodian.balanceOf(client2.address, tokenA.target);

            await fungibleOrderbook.connect(client2).cancelOrder(buyId);

            expect(await custodian.lockedBalanceOf(client2.address, tokenA.target)).to.equal(0n);
            expect(await custodian.balanceOf(client2.address, tokenA.target))
                .to.equal(available + locked);
        });

        it("full deposit → order → cancel → withdraw round-trip: zero residue", async function () {
            const extra = ethers.parseUnits("1000", 18);
            await tokenA.mint(client3.address, extra);
            await tokenA.connect(client3).approve(custodian.target, extra);
            await custodian.connect(client3).deposit(tokenA.target, extra);

            const buyId = await placeBuy(
                client3, extra / 2n, ethers.parseUnits("250", 18),
                true, ethers.encodeBytes32String("roundtrip")
            );
            await fungibleOrderbook.connect(client3).cancelOrder(buyId);

            const available = await custodian.balanceOf(client3.address, tokenA.target);
            await expect(
                custodian.connect(client3).withdraw(tokenA.target, available, false)
            ).to.not.be.revert(ethers);

            expect(await custodian.balanceOf(client3.address, tokenA.target)).to.equal(0n);
        });
    });


    //------------------------------------ 7. CONTRACT WIRING — access control -----------------------------------------------

    describe("Contract wiring and access control across boundaries", function () {

        it("EOA cannot call lockFunds on custodian", async function () {
            await expect(
                custodian.connect(client1).lockFunds(client1.address, tokenA.target, SELL_AMOUNT_OUT)
            ).to.be.revertedWithCustomError(custodian, "NotOrderbook");
        });

        it("EOA cannot call internalTransfer on custodian", async function () {
            await expect(
                custodian.connect(client1).internalTransfer(
                    client1.address, client2.address, tokenA.target, SELL_AMOUNT_OUT
                )
            ).to.be.revertedWithCustomError(custodian, "NotSettlementEngine");
        });

        it("EOA cannot call updateOrder on fungible orderbook", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            await expect(
                fungibleOrderbook.connect(client1).updateOrder(sellId, false)
            ).to.be.revertedWithCustomError(fungibleOrderbook, "NotSettlementEngine");
        });

        it("EOA cannot call reinstateOrder on fungible orderbook", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            await placeBuy(client2, BUY_AMOUNT_OUT, BUY_AMOUNT_IN); // puts sell into Matched
            await expect(
                fungibleOrderbook.connect(client1).reinstateOrder(sellId, SELL_AMOUNT_IN)
            ).to.be.revertedWithCustomError(fungibleOrderbook, "NotSettlementEngine");
        });

        it("EOA cannot deactivate NFT listing", async function () {
            const listingId = await listNFT(client1, 1n, ethers.parseUnits("500", 18));
            await expect(
                nftOrderbook.connect(client1).deactivateListing(listingId)
            ).to.be.revertedWithCustomError(nftOrderbook, "NotSettlementEngine");
        });

        it("EOA cannot call executeTrade on settlement engine", async function () {
            await expect(
                settlementEngine.connect(client1).executeTrade(1n, 2n, SELL_AMOUNT_OUT)
            ).to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });

        it("EOA cannot call executeNFTTrade on settlement engine", async function () {
            await expect(
                settlementEngine.connect(client1).executeNFTTrade(1n, 2n)
            ).to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });

        it("non-operator cannot adjust settlement window", async function () {
            await expect(
                settlementEngine.connect(client1).setSettlementWindow(120n)
            ).to.be.revertedWithCustomError(settlementEngine, "NotOperator");
        });
    });


    //--------------------------- 8. REINSTATEMENT — failed trade restores correct state ---------------------------------

    describe("Reinstatement — failed trade leaves system consistent", function () {

        it("reinstated taker re-matches in the next batch", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            const buyId  = await placeBuy(client2,  BUY_AMOUNT_OUT,  BUY_AMOUNT_IN);

            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sellId);

            await settle(); // trade fails — taker reinstated

            expect((await fungibleOrderbook.getOrder(buyId)).status).to.equal(Status.Active);

            const sell2 = await placeSell(
                client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN,
                true, ethers.encodeBytes32String("resell")
            );
            await settle();

            expect((await fungibleOrderbook.getOrder(buyId)).status).to.equal(Status.Inactive);
            expect((await fungibleOrderbook.getOrder(sell2)).status).to.equal(Status.Inactive);
        });

        it("after failed trade: seller locked = 0, buyer locked > 0 (reinstated)", async function () {
            const sellId = await placeSell(client1, SELL_AMOUNT_OUT, SELL_AMOUNT_IN);
            await placeBuy(client2, BUY_AMOUNT_OUT, BUY_AMOUNT_IN);

            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sellId);

            expect(await custodian.lockedBalanceOf(client1.address, tokenB.target)).to.equal(0n);

            await settle();

            expect(await custodian.lockedBalanceOf(client2.address, tokenA.target)).to.be.gt(0n);
        });
    });


    //------------------------------------------- 9. EDGE CASES -------------------------------------------------------------

    describe("Cross-contract edge cases", function () {

        it("NFT listing cancelled before settlement — NFTTradeFailed emitted, batch continues", async function () {
            await listNFT(client1, 1n, ethers.parseUnits("500", 18));
            await makeNFTOffer(client2, 1n, ethers.parseUnits("500", 18));
            await nftOrderbook.connect(client1).cancelNFTListing(1n);

            await expireWindow();
            await expect(settlementEngine.connect(client3).settleBatch())
                .to.emit(settlementEngine, "NFTTradeFailed");
        });

        it("BlacklistedWithWithdrawal user can cancel orders and recover locked funds", async function () {
            const buyId = await placeBuy(client2, BUY_AMOUNT_OUT, BUY_AMOUNT_IN);
            const lockedBefore = await custodian.lockedBalanceOf(client2.address, tokenA.target);

            await complianceManager.connect(operator).setUserStatus(
                client2.address, UserStatus.BlacklistedWithWithdrawal
            );
            await fungibleOrderbook.connect(client2).cancelOrder(buyId);

            expect(await custodian.lockedBalanceOf(client2.address, tokenA.target)).to.equal(0n);
            expect(lockedBefore).to.be.gt(0n);
        });

        it("lastSettledBatchId increments correctly across two settlements", async function () {
            await placeSell(client1, SELL_AMOUNT_OUT / 2n, SELL_AMOUNT_IN / 2n, true, ethers.encodeBytes32String("i1s"));
            await placeBuy(client2,  BUY_AMOUNT_OUT  / 2n, BUY_AMOUNT_IN  / 2n, true, ethers.encodeBytes32String("i1b"));
            await settle();
            expect(await settlementEngine.lastSettledBatchId()).to.equal(1n);

            await placeSell(client1, SELL_AMOUNT_OUT / 2n, SELL_AMOUNT_IN / 2n, true, ethers.encodeBytes32String("i2s"));
            await placeBuy(client2,  BUY_AMOUNT_OUT  / 2n, BUY_AMOUNT_IN  / 2n, true, ethers.encodeBytes32String("i2b"));
            await settle();
            expect(await settlementEngine.lastSettledBatchId()).to.equal(2n);
        });
    });
});