import { expect } from "chai";
import { network } from "hardhat";
import { deploySystem } from "./utils/deploy.js";

const { ethers } = await network.connect();

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));

const AssetType      = { ERC20: 0, ERC721: 1 };
const CommitType     = { Order: 0, Take: 1 };
const NFTCommitType  = { NFTList: 0, NFTOffer: 1 };
const Side           = { BUY: 0, SELL: 1 };

const PRICE          = ethers.parseUnits("1", 18);   // 1:1 price
const SALT           = ethers.encodeBytes32String("salt");
const SETTLEMENT_WINDOW = 60; // seconds, must match deploySystem

describe("SettlementEngine", function () {

    let admin: any, operator: any, maker: any, taker: any, thirdParty: any;
    let complianceManager: any, fungibleOrderbook: any, nftOrderbook: any;
    let custodian: any, settlementEngine: any;
    let tokenA: any, tokenB: any;
    let nftCollection: any, otherNFTCollection: any;
    let nftOBSigner: any;

    const DEPOSIT      = ethers.parseUnits("10000", 18);
    const AMOUNT       = ethers.parseUnits("100", 18);
    const NFT_TOKEN_ID = 1n;
    const OFFER_NFT_ID = 2n;

    beforeEach(async function () {
        ({ admin, complianceManager, fungibleOrderbook, nftOrderbook,
           custodian, settlementEngine, tokenA, tokenB,
           nftCollection, otherNFTCollection } = await deploySystem(ethers));

        const signers = await ethers.getSigners();
        operator   = signers[1];
        maker      = signers[2];
        taker      = signers[3];
        thirdParty = signers[4];

        await complianceManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        // Give the NFT orderbook ETH so it can send txs as an impersonated signer
        await ethers.provider.send("hardhat_setBalance", [
            nftOrderbook.target, ethers.toQuantity(ethers.parseEther("1.0")),
        ]);
        nftOBSigner = await ethers.getImpersonatedSigner(nftOrderbook.target);

        // Fund both traders with ERC-20 tokens
        for (const user of [maker, taker]) {
            await tokenA.mint(user.address, DEPOSIT);
            await tokenB.mint(user.address, DEPOSIT);
            await tokenA.connect(user).approve(custodian.target, DEPOSIT);
            await tokenB.connect(user).approve(custodian.target, DEPOSIT);
            await custodian.connect(user).deposit(tokenA.target, DEPOSIT);
            await custodian.connect(user).deposit(tokenB.target, DEPOSIT);
        }

        // Mint NFTs
        await nftCollection.mint(maker.address, NFT_TOKEN_ID);
        await otherNFTCollection.mint(taker.address, OFFER_NFT_ID);
        await nftCollection.connect(maker).approve(custodian.target, NFT_TOKEN_ID);
        await otherNFTCollection.connect(taker).approve(custodian.target, OFFER_NFT_ID);
    });


    // ─────────────────────────────── Helpers ────────────────────────────────

    /**
     * Place a fungible order through the full commit-reveal flow.
     * Returns the orderId emitted by OrderPlaced.
     */
    async function placeOrder(
        client: any,
        tokenIn: string,
        tokenOut: string,
        amount: bigint,
        side: number = Side.BUY,
        price: bigint = PRICE,
        partialAllowed: boolean = false
    ): Promise<bigint> {
        const hash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint8", "bool", "bytes32"],
            [client.address, tokenIn, tokenOut, price, amount, side, partialAllowed, SALT]
        );

        const commitTx      = await fungibleOrderbook.connect(client).commit(hash, CommitType.Order);
        const commitReceipt = await commitTx.wait();
        const commitId      = commitReceipt.logs[0].args[0];

        // Reveal must happen in a later block than commit
        await ethers.provider.send("evm_mine", []);

        await fungibleOrderbook.connect(client).revealOrder(
            commitId, tokenIn, tokenOut, price, amount, side, partialAllowed, SALT
        );

        const events = await fungibleOrderbook.queryFilter(
            fungibleOrderbook.filters.OrderPlaced()
        );
        return events[events.length - 1].args.orderId;
    }

    /**
     * Place a maker order, then a matching taker order.
     * The taker's revealOrder triggers _matchIncoming internally,
     * which calls settlementEngine.executeTrade automatically — no manual queuing needed.
     * Returns both order IDs.
     */
    async function placeAndMatch(
        makerAmount: bigint,
        takerAmount: bigint,
        price: bigint = PRICE,
        partialAllowed: boolean = false
    ): Promise<{ makerOrderId: bigint; takerOrderId: bigint }> {
        // maker sells tokenA, wants tokenB
        const makerOrderId = await placeOrder(
            maker, tokenB.target, tokenA.target, makerAmount, Side.SELL, price, partialAllowed
        );
        // taker buys tokenA, pays tokenB — this triggers the match internally
        const takerOrderId = await placeOrder(
            taker, tokenA.target, tokenB.target, takerAmount, Side.BUY, price, partialAllowed
        );
        return { makerOrderId, takerOrderId };
    }

    /** Advance time past the settlement window and settle */
    async function expireAndSettle() {
        await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
        await ethers.provider.send("evm_mine", []);
        await settlementEngine.connect(thirdParty).settleBatch();
    }

    /** Create an ERC-20 listing on the NFT orderbook */
    async function createListing(
        client: any,
        paymentToken: string,
        paymentAmount: bigint
    ): Promise<bigint> {
        const hash = ethers.solidityPackedKeccak256(
            ["address", "address", "uint256", "uint8", "address", "uint256", "uint256", "bytes32"],
            [client.address, nftCollection.target, NFT_TOKEN_ID, AssetType.ERC20,
             paymentToken, paymentAmount, 0n, SALT]
        );
        const tx      = await nftOrderbook.connect(client).commit(hash, NFTCommitType.NFTList);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];
        await nftOrderbook.connect(client).revealNFTList(
            commitId, nftCollection.target, NFT_TOKEN_ID,
            AssetType.ERC20, paymentToken, paymentAmount, 0n, SALT
        );
        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTListed());
        return events[events.length - 1].args.listingId;
    }

    /** Create an ERC-20 offer on the NFT orderbook */
    async function createOffer(
        client: any,
        offerToken: string,
        offerAmount: bigint,
        targetTokenId: bigint = NFT_TOKEN_ID
    ): Promise<bigint> {
        const hash = ethers.solidityPackedKeccak256(
            ["address", "address", "uint256", "uint8", "address", "uint256", "uint256", "bytes32"],
            [client.address, nftCollection.target, targetTokenId, AssetType.ERC20,
             offerToken, offerAmount, 0n, SALT]
        );
        const tx      = await nftOrderbook.connect(client).commit(hash, NFTCommitType.NFTOffer);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];
        await nftOrderbook.connect(client).revealNFTOffer(
            commitId, nftCollection.target, targetTokenId,
            AssetType.ERC20, offerToken, offerAmount, 0n, SALT
        );
        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTOfferMade());
        return events[events.length - 1].args.offerId;
    }


    // ─────────────────────────── Batch lifecycle ─────────────────────────────

    describe("Batch lifecycle", function () {

        it("should start at batch 1 after initialization", async function () {
            expect(await settlementEngine.currentBatchId()).to.equal(1n);
        });

        it("should record batchOpenedAt on initialization", async function () {
            expect(await settlementEngine.batchOpenedAt()).to.be.gt(0n);
        });

        it("should have a trade in the batch after two matching orders are placed", async function () {
            const batchId = await settlementEngine.currentBatchId();
            await placeAndMatch(AMOUNT, AMOUNT);
            const { fungible } = await settlementEngine.getBatchSize(batchId);
            expect(fungible).to.equal(1n);
        });

        it("should open a new batch after settlement", async function () {
            const batchIdBefore = await settlementEngine.currentBatchId();
            await placeAndMatch(AMOUNT, AMOUNT);
            await expireAndSettle();
            expect(await settlementEngine.currentBatchId()).to.equal(batchIdBefore + 1n);
            expect(await settlementEngine.lastSettledBatchId()).to.equal(batchIdBefore);
        });

        it("should emit BatchSettled with the correct trade count", async function () {
            const batchId = await settlementEngine.currentBatchId();
            await placeAndMatch(AMOUNT, AMOUNT);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "BatchSettled")
                .withArgs(batchId, 1n, 0n);
        });

        it("should roll to a new batch when maxBatchSize is reached", async function () {
            await settlementEngine.connect(operator).setMaxBatchSize(1);

            const firstBatchId = await settlementEngine.currentBatchId();

            // First match fills batch 1, second match rolls to batch 2
            await placeAndMatch(AMOUNT, AMOUNT);
            await placeAndMatch(AMOUNT, AMOUNT);

            expect(await settlementEngine.currentBatchId()).to.equal(firstBatchId + 1n);

            const { fungible: first  } = await settlementEngine.getBatchSize(firstBatchId);
            const { fungible: second } = await settlementEngine.getBatchSize(firstBatchId + 1n);
            expect(first).to.equal(1n);
            expect(second).to.equal(1n);
        });

        it("should settle the oldest batch first (FIFO)", async function () {
            await settlementEngine.connect(operator).setMaxBatchSize(1);

            // Two matches → lands in batch 1 and batch 2 respectively
            await placeAndMatch(AMOUNT, AMOUNT);
            await placeAndMatch(AMOUNT, AMOUNT);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            // settleBatch always picks lastSettledBatchId + 1, so batch 1 settles first
            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "BatchSettled")
                .withArgs(1n, 1n, 0n);

            expect(await settlementEngine.lastSettledBatchId()).to.equal(1n);
        });

        it("timeUntilSettlement returns 0 after window expires", async function () {
            await placeAndMatch(AMOUNT, AMOUNT);
            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);
            expect(await settlementEngine.timeUntilSettlement()).to.equal(0n);
        });

        it("timeUntilSettlement returns a positive value before window expires", async function () {
            expect(await settlementEngine.timeUntilSettlement()).to.be.gt(0n);
        });
    });


    // ──────────────────────────── Access control ─────────────────────────────

    describe("Access control", function () {

        it("should revert settleBatch when paused", async function () {
            await placeAndMatch(AMOUNT, AMOUNT);
            await complianceManager.connect(operator).pause();
            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);
            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.be.revertedWithCustomError(settlementEngine, "SystemPaused");
        });

        it("should revert settleBatch when window has not expired", async function () {
            await placeAndMatch(AMOUNT, AMOUNT);
            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.be.revertedWithCustomError(settlementEngine, "WindowNotExpired");
        });

        it("should revert settleBatch when batch is empty", async function () {
            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);
            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.be.revertedWithCustomError(settlementEngine, "WindowNotExpired");
        });

        it("should revert initialize if called again", async function () {
            await expect(
                settlementEngine.connect(admin).initialize(
                    fungibleOrderbook.target, nftOrderbook.target, custodian.target
                )
            ).to.be.revertedWithCustomError(settlementEngine, "AlreadyInitialized");
        });

        it("should revert initialize if called by non-admin", async function () {
            const fresh = await ethers.deployContract("SettlementEngine", [
                complianceManager.target, SETTLEMENT_WINDOW, 10
            ]);
            await expect(
                fresh.connect(thirdParty).initialize(
                    fungibleOrderbook.target, nftOrderbook.target, custodian.target
                )
            ).to.be.revertedWithCustomError(fresh, "NotAdmin");
        });

        it("should revert executeNFTTrade when called by non-orderbook", async function () {
            await expect(settlementEngine.connect(thirdParty).executeNFTTrade(1n, 1n))
                .to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });
    });


    // ──────────────────────────── Operator config ─────────────────────────────

    describe("Operator config", function () {

        it("should allow operator to update settlement window", async function () {
            await expect(settlementEngine.connect(operator).setSettlementWindow(120))
                .to.emit(settlementEngine, "SettlementWindowUpdated")
                .withArgs(SETTLEMENT_WINDOW, 120);
            expect(await settlementEngine.settlementWindowSeconds()).to.equal(120);
        });

        it("should revert setSettlementWindow when called by non-operator", async function () {
            await expect(settlementEngine.connect(thirdParty).setSettlementWindow(120))
                .to.be.revertedWithCustomError(settlementEngine, "NotOperator");
        });

        it("should revert setSettlementWindow below MIN_SETTLEMENT_WINDOW", async function () {
            await expect(settlementEngine.connect(operator).setSettlementWindow(0))
                .to.be.revertedWithCustomError(settlementEngine, "WindowTooShort");
        });

        it("should allow operator to update max batch size", async function () {
            const oldSize = await settlementEngine.maxBatchSize();
            await expect(settlementEngine.connect(operator).setMaxBatchSize(50))
                .to.emit(settlementEngine, "MaxBatchSizeUpdated")
                .withArgs(oldSize, 50);
            expect(await settlementEngine.maxBatchSize()).to.equal(50);
        });

        it("should revert setMaxBatchSize when called by non-operator", async function () {
            await expect(settlementEngine.connect(thirdParty).setMaxBatchSize(10))
                .to.be.revertedWithCustomError(settlementEngine, "NotOperator");
        });

        it("should revert setMaxBatchSize above MAX_BATCH_SIZE", async function () {
            await expect(settlementEngine.connect(operator).setMaxBatchSize(101))
                .to.be.revertedWithCustomError(settlementEngine, "BatchSizeOutOfBounds");
        });

        it("should revert setMaxBatchSize below MIN_BATCH_SIZE", async function () {
            await expect(settlementEngine.connect(operator).setMaxBatchSize(0))
                .to.be.revertedWithCustomError(settlementEngine, "BatchSizeOutOfBounds");
        });
    });


    // ──────────────────────────── Chainlink Automation ───────────────────────────

    describe("Chainlink Automation", function () {

        it("checkUpkeep returns false when batch is empty", async function () {
            const [upkeepNeeded] = await settlementEngine.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.false;
        });

        it("checkUpkeep returns false when window has not expired", async function () {
            await placeAndMatch(AMOUNT, AMOUNT);
            const [upkeepNeeded] = await settlementEngine.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.false;
        });

        it("checkUpkeep returns true when window expired and batch is non-empty", async function () {
            await placeAndMatch(AMOUNT, AMOUNT);
            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);
            const [upkeepNeeded] = await settlementEngine.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.true;
        });

        it("performUpkeep settles the batch", async function () {
            const batchId = await settlementEngine.currentBatchId();
            await placeAndMatch(AMOUNT, AMOUNT);
            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);
            await expect(settlementEngine.connect(thirdParty).performUpkeep("0x"))
                .to.emit(settlementEngine, "BatchSettled")
                .withArgs(batchId, 1n, 0n);
        });

        it("performUpkeep reverts when window has not expired", async function () {
            await placeAndMatch(AMOUNT, AMOUNT);
            await expect(settlementEngine.connect(thirdParty).performUpkeep("0x"))
                .to.be.revertedWithCustomError(settlementEngine, "WindowNotExpired");
        });
    });


    // ───────────────────────── Fungible settlement ───────────────────────────

    describe("Fungible trade settlement", function () {

        it("should NOT move funds at match time — only after settlement", async function () {
            const makerTokenBBefore = await custodian.balanceOf(maker.address, tokenB.target);
            await placeAndMatch(AMOUNT, AMOUNT);
            // maker sold tokenA and should receive tokenB, but not yet
            expect(await custodian.balanceOf(maker.address, tokenB.target)).to.equal(makerTokenBBefore);
        });

        it("should move funds to both parties after settlement", async function () {
            const makerTokenBBefore = await custodian.balanceOf(maker.address, tokenB.target);
            const takerTokenABefore = await custodian.balanceOf(taker.address, tokenA.target);

            await placeAndMatch(AMOUNT, AMOUNT);
            await expireAndSettle();

            // maker sold tokenA, received tokenB
            expect(await custodian.balanceOf(maker.address, tokenB.target)).to.equal(makerTokenBBefore + AMOUNT);
            // taker bought tokenA, paid tokenB
            expect(await custodian.balanceOf(taker.address, tokenA.target)).to.equal(takerTokenABefore + AMOUNT);
        });

        it("should emit TradeExecuted with correct IDs and amount after settlement", async function () {
            const { makerOrderId, takerOrderId } = await placeAndMatch(AMOUNT, AMOUNT);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "TradeExecuted")
                .withArgs(makerOrderId, takerOrderId, AMOUNT);
        });

        it("should settle multiple trades queued in the same batch", async function () {
            const batchId = await settlementEngine.currentBatchId();
            await placeAndMatch(AMOUNT, AMOUNT);
            await placeAndMatch(AMOUNT, AMOUNT);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "BatchSettled")
                .withArgs(batchId, 2n, 0n);
        });

        it("should partially fill maker — maker stays active with reduced amount", async function () {
            const makerAmount = AMOUNT;
            const takerAmount = AMOUNT / 2n;

            // partialAllowed = true so the maker accepts a partial fill
            const { makerOrderId } = await placeAndMatch(makerAmount, takerAmount, PRICE, true);
            await expireAndSettle();

            const makerOrder = await fungibleOrderbook.getOrder(makerOrderId);
            expect(makerOrder.active).to.be.true;
            expect(makerOrder.amount).to.equal(makerAmount - takerAmount);
        });

        it("should fully deactivate both orders when amounts match exactly", async function () {
            const { makerOrderId, takerOrderId } = await placeAndMatch(AMOUNT, AMOUNT);
            await expireAndSettle();

            expect((await fungibleOrderbook.getOrder(makerOrderId)).active).to.be.false;
            expect((await fungibleOrderbook.getOrder(takerOrderId)).active).to.be.false;
        });
    });


    // ────────────────────── Compliance checks at settlement ──────────────────

    describe("Compliance checks at settlement", function () {

        it("should emit TradeFailed and cancel taker when maker cancels during window", async function () {
            const { makerOrderId, takerOrderId } = await placeAndMatch(AMOUNT, AMOUNT);

            await fungibleOrderbook.connect(maker).cancelOrder(makerOrderId);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "TradeFailed");

            expect((await fungibleOrderbook.getOrder(takerOrderId)).active).to.be.false;
        });

        it("should emit OrderNotActive when maker order is cancelled before settlement", async function () {
            const { makerOrderId } = await placeAndMatch(AMOUNT, AMOUNT);
            await fungibleOrderbook.connect(maker).cancelOrder(makerOrderId);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "OrderNotActive")
                .withArgs(makerOrderId);
        });

        it("should cancel both orders when a token is blacklisted during window", async function () {
            const { makerOrderId, takerOrderId } = await placeAndMatch(AMOUNT, AMOUNT);
            await complianceManager.connect(operator).blacklistToken(tokenA.target);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "TokenBlacklisted");

            expect((await fungibleOrderbook.getOrder(makerOrderId)).active).to.be.false;
            expect((await fungibleOrderbook.getOrder(takerOrderId)).active).to.be.false;
        });

        it("should cancel maker only when maker is blacklisted during window", async function () {
            const { makerOrderId, takerOrderId } = await placeAndMatch(AMOUNT, AMOUNT);
            await complianceManager.connect(operator).setUserStatus(maker.address, 2);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "UserBlacklisted")
                .withArgs(maker.address);

            expect((await fungibleOrderbook.getOrder(makerOrderId)).active).to.be.false;
            expect((await fungibleOrderbook.getOrder(takerOrderId)).active).to.be.true;
        });

        it("should cancel taker only when taker is blacklisted during window", async function () {
            const { makerOrderId, takerOrderId } = await placeAndMatch(AMOUNT, AMOUNT);
            await complianceManager.connect(operator).setUserStatus(taker.address, 2);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "UserBlacklisted")
                .withArgs(taker.address);

            expect((await fungibleOrderbook.getOrder(makerOrderId)).active).to.be.true;
            expect((await fungibleOrderbook.getOrder(takerOrderId)).active).to.be.false;
        });

        it("should continue settling good trades after one trade fails in the same batch", async function () {
            // This match will fail — maker cancels during window
            const { makerOrderId: badMakerId } = await placeAndMatch(AMOUNT, AMOUNT);
            // This match should succeed
            await placeAndMatch(AMOUNT, AMOUNT);

            await fungibleOrderbook.connect(maker).cancelOrder(badMakerId);

            const makerTokenBBefore = await custodian.balanceOf(maker.address, tokenB.target);

            await expireAndSettle();

            // The second trade still settled, so maker received tokenB from it
            expect(await custodian.balanceOf(maker.address, tokenB.target)).to.be.gt(makerTokenBBefore);
        });
    });


    // ────────────────────── NFT — ERC-20 payment ─────────────────────────────

    describe("NFT trade settlement — ERC-20 payment", function () {

        let listingId: bigint;
        let offerId: bigint;

        beforeEach(async function () {
            await custodian.connect(maker).depositNFT(nftCollection.target, NFT_TOKEN_ID);
            listingId = await createListing(maker, tokenA.target, AMOUNT);

            await custodian.connect(taker).depositNFT(otherNFTCollection.target, OFFER_NFT_ID);
            offerId = await createOffer(taker, tokenA.target, AMOUNT);
        });

        it("should NOT move assets at queue time", async function () {
            const makerTokenABefore = await custodian.balanceOf(maker.address, tokenA.target);
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);
            expect(await custodian.balanceOf(maker.address, tokenA.target)).to.equal(makerTokenABefore);
        });

        it("should transfer NFT to buyer and ERC-20 to seller after settlement", async function () {
            const makerTokenABefore = await custodian.balanceOf(maker.address, tokenA.target);
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);
            await expireAndSettle();

            expect(await custodian.balanceOf(maker.address, tokenA.target)).to.equal(makerTokenABefore + AMOUNT);
            const { held } = await custodian.nftBalanceOf(taker.address, nftCollection.target, NFT_TOKEN_ID);
            expect(held).to.be.true;
        });

        it("should refund overpayment to buyer after settlement", async function () {
            const overpay = AMOUNT * 2n;
            await tokenA.mint(taker.address, AMOUNT);
            await tokenA.connect(taker).approve(custodian.target, AMOUNT);
            await custodian.connect(taker).deposit(tokenA.target, AMOUNT);

            const highOfferId = await createOffer(taker, tokenA.target, overpay);
            const takerTokenABefore = await custodian.balanceOf(taker.address, tokenA.target);

            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, highOfferId);
            await expireAndSettle();

            // Taker paid AMOUNT and got (overpay - AMOUNT) refunded
            const takerTokenAAfter = await custodian.balanceOf(taker.address, tokenA.target);
            expect(takerTokenAAfter - takerTokenABefore).to.equal(overpay - AMOUNT);
        });

        it("should deactivate both listing and offer after settlement", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);
            await expireAndSettle();

            expect((await nftOrderbook.getNFTListing(listingId)).active).to.be.false;
            expect((await nftOrderbook.getNFTOffer(offerId)).active).to.be.false;
        });

        it("should emit NFTTradeExecuted after settlement", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "NFTTradeExecuted")
                .withArgs(listingId, offerId, nftCollection.target, NFT_TOKEN_ID);
        });

        it("should emit NFTTradeFailed when listing is cancelled during window", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);
            await nftOrderbook.connect(maker).cancelNFTListing(listingId);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "NFTTradeFailed");
        });

        it("should emit NFTTradeFailed when offer is cancelled during window", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);
            await nftOrderbook.connect(taker).cancelNFTOffer(offerId);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "NFTTradeFailed");
        });

        it("should cancel both sides when NFT collection is blacklisted during window", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);
            await complianceManager.connect(operator).blacklistToken(nftCollection.target);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "TokenBlacklisted");

            expect((await nftOrderbook.getNFTListing(listingId)).active).to.be.false;
            expect((await nftOrderbook.getNFTOffer(offerId)).active).to.be.false;
        });

        it("should cancel listing only when seller is blacklisted during window", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);
            await complianceManager.connect(operator).setUserStatus(maker.address, 2);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "UserBlacklisted")
                .withArgs(maker.address);

            expect((await nftOrderbook.getNFTListing(listingId)).active).to.be.false;
            expect((await nftOrderbook.getNFTOffer(offerId)).active).to.be.true;
        });

        it("should cancel offer only when buyer is blacklisted during window", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);
            await complianceManager.connect(operator).setUserStatus(taker.address, 2);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "UserBlacklisted")
                .withArgs(taker.address);

            expect((await nftOrderbook.getNFTListing(listingId)).active).to.be.true;
            expect((await nftOrderbook.getNFTOffer(offerId)).active).to.be.false;
        });

        it("should settle a mixed fungible + NFT batch correctly", async function () {
            const batchId = await settlementEngine.currentBatchId();

            // Fungible trade — queued automatically by the orderbook internals
            await placeAndMatch(AMOUNT, AMOUNT);
            // NFT trade — queued via the impersonated NFT orderbook signer
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);

            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(settlementEngine.connect(thirdParty).settleBatch())
                .to.emit(settlementEngine, "BatchSettled")
                .withArgs(batchId, 1n, 1n);
        });
    });


    // ──────────────────────── whenNotPaused guards ───────────────────────────

    describe("whenNotPaused", function () {

        it("should revert executeNFTTrade when paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(settlementEngine.connect(nftOBSigner).executeNFTTrade(1n, 1n))
                .to.be.revertedWithCustomError(settlementEngine, "SystemPaused");
        });

        it("should revert performUpkeep when paused", async function () {
            await placeAndMatch(AMOUNT, AMOUNT);
            await ethers.provider.send("evm_increaseTime", [SETTLEMENT_WINDOW + 1]);
            await ethers.provider.send("evm_mine", []);
            await complianceManager.connect(operator).pause();
            await expect(settlementEngine.connect(thirdParty).performUpkeep("0x"))
                .to.be.revertedWithCustomError(settlementEngine, "SystemPaused");
        });
    });
});