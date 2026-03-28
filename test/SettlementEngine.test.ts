import { expect } from "chai";
import { network } from "hardhat";
import { deploySystem } from "./utils/deploy.js";

const { ethers } = await network.connect();

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));

// Mirrors the on-chain enum
const AssetType = { ERC20: 0, ERC721: 1 };
const FungibleCommitType = { Order: 0, Take: 1 };
const NFTCommitType = { NFTList: 0, NFTOffer: 1 };
const Side = { BUY: 0, SELL: 1 };
const PRICE = ethers.parseUnits("1", 18);
const SALT  = ethers.encodeBytes32String("salt");

async function buildOrder(client: string, tokenIn: string, tokenOut: string, amount: bigint, active = true) {
    return {
        id: 0n,
        client: client,
        side: Side.BUY,
        active: active,
        partialAllowed: false,
        pairId: ethers.keccak256(ethers.solidityPacked(["address", "address"], [tokenIn, tokenOut])),
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        price: PRICE,
        amount: amount,
        block: BigInt(await ethers.provider.getBlockNumber()),
    };
}

describe("SettlementEngine", function () {

    let admin: any, operator: any, maker: any, taker: any, thirdParty: any;
    let complianceManager: any, fungibleOrderbook: any, nftOrderbook: any;
    let custodian: any, settlementEngine: any;
    let tokenA: any, tokenB: any;
    let nftCollection: any, otherNFTCollection: any;

    // Impersonated signers that pass onlyAuthorizedOrderBook
    let fungibleOBSigner: any, nftOBSigner: any;

    const DEPOSIT = ethers.parseUnits("10000", 18);
    const TRADE_AMOUNT = ethers.parseUnits("100",   18);
    const NFT_TOKEN_ID = 1n;
    const OFFER_NFT_ID = 2n;

    beforeEach(async function () {
        ({admin, complianceManager, fungibleOrderbook, nftOrderbook,
            custodian, settlementEngine, tokenA, tokenB,
            nftCollection, otherNFTCollection} = await deploySystem(ethers));

        const signers = await ethers.getSigners();
        operator = signers[1];
        maker = signers[2];
        taker = signers[3];
        thirdParty = signers[4];

        await complianceManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        // Fund the impersonated callers with ETH so they can send txs
        for (const addr of [fungibleOrderbook.target, nftOrderbook.target]) {
            await ethers.provider.send("hardhat_setBalance", [
                addr, ethers.toQuantity(ethers.parseEther("1.0")),
            ]);
        }
        fungibleOBSigner = await ethers.getImpersonatedSigner(fungibleOrderbook.target);
        nftOBSigner = await ethers.getImpersonatedSigner(nftOrderbook.target);

        // Mint & deposit ERC-20 for both sides
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

    //-----------------------------------------------Helper functions------------------------------------------------
    async function _createFungibleOrder(
        client: any,
        tokenIn: string,
        tokenOut: string,
        amount: bigint,
        side: number = Side.BUY,
        price: bigint = PRICE
    ): Promise<bigint> {
        const hash = ethers.solidityPackedKeccak256(
            ["address", "address", "address", "uint256", "uint256", "uint8", "bool", "bytes32"],
            [client.address, tokenIn, tokenOut, price, amount, side, false, SALT]
        );
        const tx = await fungibleOrderbook.connect(client).commit(hash, FungibleCommitType.Order);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];

        await fungibleOrderbook.connect(client).revealOrder(
            commitId, tokenIn, tokenOut, price, amount, side, false, SALT
        );

        const events = await fungibleOrderbook.queryFilter(
            fungibleOrderbook.filters.OrderPlaced(), receipt.blockNumber
        );
        return events[events.length - 1].args.orderId;
    }

    async function _createListing(
        client: any,
        paymentToken: string,
        paymentAmount: bigint
    ): Promise<bigint> {
        const SALT = ethers.encodeBytes32String("salt");
        const hash = ethers.solidityPackedKeccak256(
            ["address","address","uint256","uint8","address","uint256","uint256","bytes32"],
            [client.address, nftCollection.target, NFT_TOKEN_ID, AssetType.ERC20,
             paymentToken, paymentAmount, 0n, SALT]
        );
        const tx = await nftOrderbook.connect(client).commit(hash, NFTCommitType.NFTList);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];
        await nftOrderbook.connect(client).revealNFTList(
            commitId, nftCollection.target, NFT_TOKEN_ID,
            AssetType.ERC20, paymentToken, paymentAmount, 0n, SALT
        );
        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTListed(), receipt.blockNumber);
        return events[events.length - 1].args.listingId;
    }

    async function _createOffer(
        client: any,
        offerToken: string,
        offerAmount: bigint,
        targetTokenId: bigint = NFT_TOKEN_ID
    ): Promise<bigint> {
        const SALT = ethers.encodeBytes32String("salt");
        const hash = ethers.solidityPackedKeccak256(
            ["address","address","uint256","uint8","address","uint256","uint256","bytes32"],
            [client.address, nftCollection.target, targetTokenId, AssetType.ERC20,
            offerToken, offerAmount, 0n, SALT]
        );
        const tx = await nftOrderbook.connect(client).commit(hash, NFTCommitType.NFTOffer);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];
        await nftOrderbook.connect(client).revealNFTOffer(
            commitId, nftCollection.target, targetTokenId,
            AssetType.ERC20, offerToken, offerAmount, 0n, SALT
        );
        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTOfferMade(), receipt.blockNumber);
        return events[events.length - 1].args.offerId;
    }

    async function _createNFTListing(
        client: any,
        desiredCollection: string,
        desiredTokenId: bigint
    ): Promise<bigint> {
        const SALT = ethers.encodeBytes32String("salt");
        const hash = ethers.solidityPackedKeccak256(
            ["address","address","uint256","uint8","address","uint256","uint256","bytes32"],
            [client.address, nftCollection.target, NFT_TOKEN_ID, AssetType.ERC721,
             desiredCollection, 0n, desiredTokenId, SALT]
        );
        const tx = await nftOrderbook.connect(client).commit(hash, NFTCommitType.NFTList);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];
        await nftOrderbook.connect(client).revealNFTList(
            commitId, nftCollection.target, NFT_TOKEN_ID,
            AssetType.ERC721, desiredCollection, 0n, desiredTokenId, SALT
        );
        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTListed(), receipt.blockNumber);
        return events[events.length - 1].args.listingId;
    }

    async function _createNFTOffer(
        client: any,
        offerCollection: string,
        offerTokenId: bigint,
        targetTokenId: bigint = NFT_TOKEN_ID
    ): Promise<bigint> {
        const SALT = ethers.encodeBytes32String("salt");
        const hash = ethers.solidityPackedKeccak256(
            ["address","address","uint256","uint8","address","uint256","uint256","bytes32"],
            [client.address, nftCollection.target, targetTokenId, AssetType.ERC721,
            offerCollection, 0n, offerTokenId, SALT]
        );
        const tx = await nftOrderbook.connect(client).commit(hash, NFTCommitType.NFTOffer);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];
        await nftOrderbook.connect(client).revealNFTOffer(
            commitId, nftCollection.target, targetTokenId,
            AssetType.ERC721, offerCollection, 0n, offerTokenId, SALT
        );
        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTOfferMade(), receipt.blockNumber);
        return events[events.length - 1].args.offerId;
    }

    //----------------------------------------------Access Control--------------------------------------------------

    describe("Access control", function () {

        it("should revert executeNFTTrade when called by non-orderbook address", async function () {
            await expect(
                settlementEngine.connect(thirdParty).executeNFTTrade(1n, 1n)
            ).to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });

        it("should revert executeTrade when called by non-orderbook address", async function () {
            await expect(
                settlementEngine.connect(thirdParty).executeTrade(1n, 1n)
            ).to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });

        it("should revert executeDirectTrade when called by non-orderbook address", async function () {
            const order = await buildOrder(taker.address, tokenA.target, tokenB.target, TRADE_AMOUNT);
            await expect(
                settlementEngine.connect(thirdParty).executeDirectTrade(1n, order)
            ).to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });

        it("should revert initialize if called again", async function () {
            await expect(
                settlementEngine.connect(admin).initialize(
                    fungibleOrderbook.target, nftOrderbook.target, custodian.target
                )
            ).to.be.revertedWithCustomError(settlementEngine, "AlreadyInitialized");
        });

        it("should revert initialize if called by non-admin", async function () {
            const fresh = await ethers.deployContract("SettlementEngine", [complianceManager.target]);
            await expect(
                fresh.connect(thirdParty).initialize(
                    fungibleOrderbook.target, nftOrderbook.target, custodian.target
                )
            ).to.be.revertedWithCustomError(fresh, "NotAdmin");
        });
    });


    //----------------------------------------------executeNFTTrade — ERC-20 payment-------------------------------

    describe("executeNFTTrade() — ERC-20 payment", function () {

        let listingId: bigint;
        let offerId: bigint;

        beforeEach(async function () {
            await nftCollection.connect(maker).approve(custodian.target, NFT_TOKEN_ID);
            await custodian.connect(maker).depositNFT(nftCollection.target, NFT_TOKEN_ID);

            listingId = await _createListing(maker, tokenA.target, TRADE_AMOUNT);

            // Deposit offer NFT
            await otherNFTCollection.connect(taker).approve(custodian.target, OFFER_NFT_ID);
            await custodian.connect(taker).depositNFT(otherNFTCollection.target, OFFER_NFT_ID);

            // Create offer for a DIFFERENT tokenId so it doesn't auto-match the listing above
            offerId = await _createOffer(taker, tokenA.target, TRADE_AMOUNT, NFT_TOKEN_ID + 99n);
        });

        it("should transfer NFT from seller to buyer and ERC-20 from buyer to seller", async function () {
            const sellerTokenABefore = await custodian.balanceOf(maker.address, tokenA.target);

            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);

            // Seller received the ERC-20 payment
            const sellerTokenAAfter = await custodian.balanceOf(maker.address, tokenA.target);
            expect(sellerTokenAAfter).to.equal(sellerTokenABefore + TRADE_AMOUNT);

            const { held } = await custodian.nftBalanceOf(taker.address, nftCollection.target, NFT_TOKEN_ID);
            expect(held).to.be.true;
        });

        it("should refund overpayment to buyer when offer exceeds ask", async function () {
            const overpay = TRADE_AMOUNT * 2n;

            // Mint and deposit extra tokens so taker can cover the larger offer
            await tokenA.mint(taker.address, TRADE_AMOUNT);
            await tokenA.connect(taker).approve(custodian.target, TRADE_AMOUNT);
            await custodian.connect(taker).deposit(tokenA.target, TRADE_AMOUNT);

            // Create a new offer at 2x the listing price — locking happens inside revealNFTOffer
            const higherOfferId = await _createOffer(taker, tokenA.target, overpay, NFT_TOKEN_ID + 99n);

            const takerFreeBefore = await custodian.balanceOf(taker.address, tokenA.target);
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, higherOfferId);
            const takerFreeAfter = await custodian.balanceOf(taker.address, tokenA.target);

            // Free balance increases by the refunded overpayment
            expect(takerFreeAfter - takerFreeBefore).to.equal(overpay - TRADE_AMOUNT);
        });

        it("should deactivate both listing and offer after trade", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);

            const listing = await nftOrderbook.getNFTListing(listingId);
            const offer   = await nftOrderbook.getNFTOffer(offerId);
            expect(listing.active).to.be.false;
            expect(offer.active).to.be.false;
        });

        it("should emit NFTTradeExecuted", async function () {
            await expect(
                settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId)
            ).to.emit(settlementEngine, "NFTTradeExecuted")
             .withArgs(listingId, offerId, nftCollection.target, NFT_TOKEN_ID);
        });

        it("should revert if listing is not active", async function () {
            await nftOrderbook.connect(maker).cancelNFTListing(listingId);
            await expect(
                settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId)
            ).to.be.revertedWithCustomError(settlementEngine, "ListingNotActive");
        });

        it("should revert if offer is not active", async function () {
            await nftOrderbook.connect(taker).cancelNFTOffer(offerId);
            await expect(
                settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId)
            ).to.be.revertedWithCustomError(settlementEngine, "OfferNotActive");
        });

        it("should cancel both sides when collection is blacklisted at settlement time", async function () {
            await complianceManager.connect(operator).blacklistToken(nftCollection.target);

            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);

            const listing = await nftOrderbook.getNFTListing(listingId);
            const offer   = await nftOrderbook.getNFTOffer(offerId);
            expect(listing.active).to.be.false;
            expect(offer.active).to.be.false;
        });

        it("should emit TokenBlacklisted when collection is blacklisted at settlement", async function () {
            await complianceManager.connect(operator).blacklistToken(nftCollection.target);
            await expect(
                settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId)
            ).to.emit(settlementEngine, "TokenBlacklisted");
        });

        it("should cancel listing only when seller is blacklisted at settlement time", async function () {
            await complianceManager.connect(operator).setUserStatus(maker.address, 2);

            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);

            const listing = await nftOrderbook.getNFTListing(listingId);
            const offer   = await nftOrderbook.getNFTOffer(offerId);
            expect(listing.active).to.be.false;
            expect(offer.active).to.be.true; // offer stays open
        });

        it("should cancel offer only when buyer is blacklisted at settlement time", async function () {
            await complianceManager.connect(operator).setUserStatus(taker.address, 2);

            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);

            const listing = await nftOrderbook.getNFTListing(listingId);
            const offer   = await nftOrderbook.getNFTOffer(offerId);
            expect(listing.active).to.be.true; // listing stays open
            expect(offer.active).to.be.false;
        });
    });


    //----------------------------------------------executeNFTTrade — NFT-for-NFT----------------------------------

    describe("executeNFTTrade() — NFT-for-NFT", function () {

        let listingId: bigint;
        let offerId: bigint;

        beforeEach(async function () {
            await custodian.connect(maker).depositNFT(nftCollection.target, NFT_TOKEN_ID);
            await custodian.connect(taker).depositNFT(otherNFTCollection.target, OFFER_NFT_ID);

            listingId = await _createNFTListing(maker, otherNFTCollection.target, OFFER_NFT_ID);
            offerId = await _createNFTOffer(taker, otherNFTCollection.target, OFFER_NFT_ID, NFT_TOKEN_ID + 99n);
        });

        it("should swap both NFTs between parties", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);

            const { held: takerHasListingNFT } = await custodian.nftBalanceOf(taker.address, nftCollection.target, NFT_TOKEN_ID);
            expect(takerHasListingNFT).to.be.true;

            const { held: makerHasOfferNFT } = await custodian.nftBalanceOf(maker.address, otherNFTCollection.target, OFFER_NFT_ID);
            expect(makerHasOfferNFT).to.be.true;
        });

        it("should deactivate both sides after NFT-for-NFT trade", async function () {
            await settlementEngine.connect(nftOBSigner).executeNFTTrade(listingId, offerId);

            expect((await nftOrderbook.getNFTListing(listingId)).active).to.be.false;
            expect((await nftOrderbook.getNFTOffer(offerId)).active).to.be.false;
        });
    });


    //----------------------------------------------_executeTrade (fungible) via executeDirectTrade----------------

    describe("executeTrade() — fungible", function () {

        let makerOrderId: bigint;
        let takerOrderId: bigint;

        beforeEach(async function () {
            const PRICE  = ethers.parseUnits("1", 18);

            makerOrderId = await _createFungibleOrder(maker, tokenA.target, tokenB.target, TRADE_AMOUNT, Side.BUY,  PRICE);
            takerOrderId = await _createFungibleOrder(taker, tokenB.target, tokenA.target, TRADE_AMOUNT, Side.BUY, PRICE);
        });

        it("should transfer funds between both parties", async function () {
            const makerTokenABefore = await custodian.balanceOf(maker.address, tokenA.target);
            const takerTokenBBefore = await custodian.balanceOf(taker.address, tokenB.target);

            await settlementEngine.connect(fungibleOBSigner).executeTrade(makerOrderId, takerOrderId);

            expect(await custodian.balanceOf(maker.address, tokenA.target)).to.equal(makerTokenABefore + TRADE_AMOUNT);
            expect(await custodian.balanceOf(taker.address, tokenB.target)).to.equal(takerTokenBBefore + TRADE_AMOUNT);
        });

        it("should emit TradeExecuted with both order IDs", async function () {
            await expect(
                settlementEngine.connect(fungibleOBSigner).executeTrade(makerOrderId, takerOrderId)
            ).to.emit(settlementEngine, "TradeExecuted")
            .withArgs(makerOrderId, takerOrderId, TRADE_AMOUNT);
        });

        it("should cancel taker and emit OrderNotActive when maker is inactive", async function () {
            await fungibleOrderbook.connect(maker).cancelOrder(makerOrderId);

            await expect(
                settlementEngine.connect(fungibleOBSigner).executeTrade(makerOrderId, takerOrderId)
            ).to.emit(settlementEngine, "OrderNotActive").withArgs(makerOrderId);

            expect((await fungibleOrderbook.getOrder(takerOrderId)).active).to.be.false;
        });

        it("should cancel both and emit TokenBlacklisted when token is blacklisted at settlement", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenA.target);

            await expect(
                settlementEngine.connect(fungibleOBSigner).executeTrade(makerOrderId, takerOrderId)
            ).to.emit(settlementEngine, "TokenBlacklisted");

            expect((await fungibleOrderbook.getOrder(makerOrderId)).active).to.be.false;
            expect((await fungibleOrderbook.getOrder(takerOrderId)).active).to.be.false;
        });

        it("should cancel maker and emit UserBlacklisted when maker is blacklisted at settlement", async function () {
            await complianceManager.connect(operator).setUserStatus(maker.address, 2);

            await expect(
                settlementEngine.connect(fungibleOBSigner).executeTrade(makerOrderId, takerOrderId)
            ).to.emit(settlementEngine, "UserBlacklisted").withArgs(maker.address);

            expect((await fungibleOrderbook.getOrder(makerOrderId)).active).to.be.false;
            expect((await fungibleOrderbook.getOrder(takerOrderId)).active).to.be.true;
        });

        it("should cancel taker and emit UserBlacklisted when taker is blacklisted at settlement", async function () {
            await complianceManager.connect(operator).setUserStatus(taker.address, 2);

            await expect(
                settlementEngine.connect(fungibleOBSigner).executeTrade(makerOrderId, takerOrderId)
            ).to.emit(settlementEngine, "UserBlacklisted").withArgs(taker.address);

            expect((await fungibleOrderbook.getOrder(makerOrderId)).active).to.be.true;
            expect((await fungibleOrderbook.getOrder(takerOrderId)).active).to.be.false;
        });

        it("should handle partial fill — larger maker reduced by taker amount", async function () {
            const largeAmount = TRADE_AMOUNT * 3n;
            const largeMakerOrderId = await _createFungibleOrder(maker, tokenA.target, tokenB.target, largeAmount);

            await settlementEngine.connect(fungibleOBSigner).executeTrade(largeMakerOrderId, takerOrderId);

            const updated = await fungibleOrderbook.getOrder(largeMakerOrderId);
            expect(updated.amount).to.equal(largeAmount - TRADE_AMOUNT);
            expect(updated.active).to.be.true;
        });
    });

    //----------------------------------------------Pause----------------------------------------------------------

    describe("whenNotPaused", function () {

        it("should revert executeNFTTrade when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(
                settlementEngine.connect(nftOBSigner).executeNFTTrade(1n, 1n)
            ).to.be.revertedWithCustomError(settlementEngine, "SystemPaused");
        });

        it("should revert executeTrade when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(
                settlementEngine.connect(fungibleOBSigner).executeTrade(1n, 1n)
            ).to.be.revertedWithCustomError(settlementEngine, "SystemPaused");
        });
    });
});