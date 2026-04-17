import { expect } from "chai";
import { network } from "hardhat";
import { deploySystem, SETTLEMENT_WINDOW } from "./utils/deploy.js";

const { ethers } = await network.connect();

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));

const CommitType = {
    NFTList:  0,
    NFTOffer: 1
};

const AssetType = {
    ERC20:  0,
    ERC721: 1
};

const NFTStatus = {
    Inactive: 0,
    Active:   1
};

//----------------------------------------------Off-chain Helpers--------------------------------------------------

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

async function advanceTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
}

//----------------------------------------------Test Suite--------------------------------------------------

describe("NFTOrderbook", function () {
    let admin: any, operator: any, seller: any, buyer: any, thirdParty: any;
    let complianceManager: any, nftOrderbook: any, custodian: any, settlementEngine: any;
    let nftCollection: any, otherNFTCollection: any, paymentToken: any, otherPaymentToken: any;
    let settlementEngineSigner: any;

    // Common constants
    const TOKEN_ID        = 1n;
    const OTHER_TOKEN_ID  = 2n;
    const OFFER_TOKEN_ID  = 10n;
    const PAYMENT_AMOUNT  = ethers.parseUnits("100", 18);
    const SALT            = ethers.encodeBytes32String("secret");
    const TOKEN_DEPOSIT   = ethers.parseUnits("10000", 18);

    //-----------------------------------------------Helpers--------------------------------------------------
    async function listNFTForERC20(
        client: any,
        collection: string,
        tokenId: bigint,
        paymentToken: string,
        paymentAmount: bigint
    ): Promise<bigint> {
        const hash = computeNFTListHash(
            client.address, collection, tokenId,
            AssetType.ERC20, paymentToken, paymentAmount, 0n,
            SALT
        );
        const tx = await nftOrderbook.connect(client).commit(hash, CommitType.NFTList);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];

        await nftOrderbook.connect(client).revealNFTList(
            commitId, collection, tokenId,
            AssetType.ERC20, paymentToken, paymentAmount, 0n,
            SALT
        );

        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTListed(), receipt.blockNumber);
        return events[events.length - 1].args.listingId;
    }

    async function listNFTForNFT(
        client: any,
        collection: string,
        tokenId: bigint,
        desiredCollection: string,
        desiredTokenId: bigint
    ): Promise<bigint> {
        const hash = computeNFTListHash(
            client.address, collection, tokenId,
            AssetType.ERC721, desiredCollection, 0n, desiredTokenId,
            SALT
        );
        const tx = await nftOrderbook.connect(client).commit(hash, CommitType.NFTList);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];

        await nftOrderbook.connect(client).revealNFTList(
            commitId, collection, tokenId,
            AssetType.ERC721, desiredCollection, 0n, desiredTokenId,
            SALT
        );

        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTListed(), receipt.blockNumber);
        return events[events.length - 1].args.listingId;
    }

    async function makeERC20Offer(
        client: any,
        collection: string,
        tokenId: bigint,
        offerToken: string,
        offerAmount: bigint
    ): Promise<bigint> {
        const hash = computeNFTOfferHash(
            client.address, collection, tokenId,
            AssetType.ERC20, offerToken, offerAmount, 0n,
            SALT
        );
        const tx = await nftOrderbook.connect(client).commit(hash, CommitType.NFTOffer);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];

        await nftOrderbook.connect(client).revealNFTOffer(
            commitId, collection, tokenId,
            AssetType.ERC20, offerToken, offerAmount, 0n,
            SALT
        );

        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTOfferMade(), receipt.blockNumber);
        return events[events.length - 1].args.offerId;
    }

    async function makeNFTOffer(
        client: any,
        collection: string,
        tokenId: bigint,
        offerCollection: string,
        offerTokenId: bigint
    ): Promise<bigint> {
        const hash = computeNFTOfferHash(
            client.address, collection, tokenId,
            AssetType.ERC721, offerCollection, 0n, offerTokenId,
            SALT
        );
        const tx = await nftOrderbook.connect(client).commit(hash, CommitType.NFTOffer);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];

        await nftOrderbook.connect(client).revealNFTOffer(
            commitId, collection, tokenId,
            AssetType.ERC721, offerCollection, 0n, offerTokenId,
            SALT
        );

        const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTOfferMade(), receipt.blockNumber);
        return events[events.length - 1].args.offerId;
    }

    beforeEach(async function () {
        let tokenA: any, tokenB: any;
        ({
            admin,
            complianceManager, nftOrderbook, custodian, settlementEngine,
            tokenA, tokenB,
            nftCollection, otherNFTCollection,
        } = await deploySystem(ethers));

        // Alias ERC-20 tokens to semantic names used throughout the tests
        paymentToken      = tokenA;
        otherPaymentToken = tokenB;

        const signers = await ethers.getSigners();
        operator   = signers[1];
        seller     = signers[2];
        buyer      = signers[3];
        thirdParty = signers[4];

        await complianceManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        // Impersonate SettlementEngine so tests can call SE-only functions
        settlementEngineSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
        await ethers.provider.send("hardhat_setBalance", [
            settlementEngine.target,
            ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        // Mint ERC-20 payment tokens to seller and buyer
        await paymentToken.mint(seller.address, TOKEN_DEPOSIT);
        await paymentToken.mint(buyer.address, TOKEN_DEPOSIT);
        await otherPaymentToken.mint(buyer.address, TOKEN_DEPOSIT);

        // Approve and deposit ERC-20 into custodian
        await paymentToken.connect(seller).approve(custodian.target, TOKEN_DEPOSIT);
        await paymentToken.connect(buyer).approve(custodian.target, TOKEN_DEPOSIT);
        await otherPaymentToken.connect(buyer).approve(custodian.target, TOKEN_DEPOSIT);

        await custodian.connect(seller).deposit(paymentToken.target, TOKEN_DEPOSIT);
        await custodian.connect(buyer).deposit(paymentToken.target, TOKEN_DEPOSIT);
        await custodian.connect(buyer).deposit(otherPaymentToken.target, TOKEN_DEPOSIT);

        // Mint NFTs to the right parties
        await nftCollection.mint(seller.address, TOKEN_ID);
        await nftCollection.mint(buyer.address, OTHER_TOKEN_ID);
        await otherNFTCollection.mint(buyer.address, OFFER_TOKEN_ID);

        // Approve NFTs to custodian
        await nftCollection.connect(seller).approve(custodian.target, TOKEN_ID);
        await nftCollection.connect(buyer).approve(custodian.target, OTHER_TOKEN_ID);
        await otherNFTCollection.connect(buyer).approve(custodian.target, OFFER_TOKEN_ID);

        await custodian.connect(seller).depositNFT(nftCollection.target, TOKEN_ID);
        await custodian.connect(buyer).depositNFT(nftCollection.target, OTHER_TOKEN_ID);
        await custodian.connect(buyer).depositNFT(otherNFTCollection.target, OFFER_TOKEN_ID);
    });


    //----------------------------------------------commit()---------------------------------------------------

    describe("commit()", function () {

        it("should store an NFTList commit with correct metadata", async function () {
            const hash = computeNFTListHash(
                seller.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const tx = await nftOrderbook.connect(seller).commit(hash, CommitType.NFTList);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            const pending = await nftOrderbook.getPendingCommit(commitId);
            expect(pending.commitHash).to.equal(hash);
            expect(pending.client).to.equal(seller.address);
            expect(pending.revealed).to.be.false;
            expect(pending.commitType).to.equal(CommitType.NFTList);
            expect(pending.revealDeadline - pending.commitBlock).to.equal(20n);
        });

        it("should store an NFTOffer commit with correct metadata", async function () {
            const hash = computeNFTOfferHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const tx = await nftOrderbook.connect(buyer).commit(hash, CommitType.NFTOffer);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            const pending = await nftOrderbook.getPendingCommit(commitId);
            expect(pending.commitType).to.equal(CommitType.NFTOffer);
        });

        it("should increment commit IDs sequentially", async function () {
            const hash1 = computeNFTListHash(
                seller.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const hash2 = computeNFTOfferHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );

            const tx1 = await nftOrderbook.connect(seller).commit(hash1, CommitType.NFTList);
            const tx2 = await nftOrderbook.connect(buyer).commit(hash2, CommitType.NFTOffer);
            const receipt1 = await tx1.wait();
            const receipt2 = await tx2.wait();

            expect(receipt2.logs[0].args[0]).to.equal(receipt1.logs[0].args[0] + 1n);
        });

        it("should emit Committed event with correct args", async function () {
            const hash = computeNFTListHash(
                seller.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            await expect(nftOrderbook.connect(seller).commit(hash, CommitType.NFTList))
                .to.emit(nftOrderbook, "Committed")
                .withArgs(0n, seller.address, BigInt(await ethers.provider.getBlockNumber()) + 1n);
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            const hash = computeNFTListHash(
                seller.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            await expect(nftOrderbook.connect(seller).commit(hash, CommitType.NFTList))
                .to.be.revertedWithCustomError(nftOrderbook, "SystemPaused");
        });
    });


    //----------------------------------------------revealNFTList()---------------------------------------------------

    describe("revealNFTList()", function () {

        let commitId: bigint;

        beforeEach(async function () {
            const hash = computeNFTListHash(
                seller.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const tx = await nftOrderbook.connect(seller).commit(hash, CommitType.NFTList);
            const receipt = await tx.wait();
            commitId = receipt.logs[0].args[0];
        });

        it("should create an active listing and lock the NFT", async function () {
            await nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );

            const listingId = await nftOrderbook.getActiveListing(nftCollection.target, TOKEN_ID);
            expect(listingId).to.not.equal(0n);

            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.seller).to.equal(seller.address);
            expect(listing.collection).to.equal(nftCollection.target);
            expect(listing.tokenId).to.equal(TOKEN_ID);
            expect(listing.paymentType).to.equal(AssetType.ERC20);
            expect(listing.paymentToken).to.equal(paymentToken.target);
            expect(listing.paymentAmount).to.equal(PAYMENT_AMOUNT);
            expect(listing.status).to.equal(NFTStatus.Active);
        });

        it("should emit NFTListed event", async function () {
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.emit(nftOrderbook, "NFTListed")
              .withArgs(1n, seller.address, nftCollection.target, TOKEN_ID);
        });

        it("should mark commit as revealed", async function () {
            await nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const pending = await nftOrderbook.getPendingCommit(commitId);
            expect(pending.revealed).to.be.true;
        });

        it("should revert if commit not found", async function () {
            await expect(nftOrderbook.connect(seller).revealNFTList(
                999n, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitNotFound");
        });

        it("should revert if caller is not commit owner", async function () {
            await expect(nftOrderbook.connect(buyer).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "NotCommitOwner");
        });

        it("should revert if commit type is NFTOffer instead of NFTList", async function () {
            const offerHash = computeNFTOfferHash(
                seller.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const tx = await nftOrderbook.connect(seller).commit(offerHash, CommitType.NFTOffer);
            const receipt = await tx.wait();
            const offerCommitId = receipt.logs[0].args[0];

            await expect(nftOrderbook.connect(seller).revealNFTList(
                offerCommitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "WrongCommitType");
        });

        it("should revert if already revealed", async function () {
            await nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitAlreadyRevealed");
        });

        it("should revert if revealed on the same block as commit", async function () {
            await ethers.provider.send("evm_setAutomine", [false]);

            try {
                const hash = computeNFTListHash(
                    seller.address, nftCollection.target, TOKEN_ID,
                    AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
                );

                const predictedId = await nftOrderbook.connect(seller).commit.staticCall(hash, CommitType.NFTList);

                await nftOrderbook.connect(seller).commit(hash, CommitType.NFTList);

                const revealTx = nftOrderbook.connect(seller).revealNFTList(
                    predictedId,
                    nftCollection.target,
                    TOKEN_ID,
                    AssetType.ERC20,
                    paymentToken.target,
                    PAYMENT_AMOUNT,
                    0n,
                    SALT
                );

                await expect(revealTx).to.be.revertedWithCustomError(
                    nftOrderbook,
                    "CommitAndRevealOnSameBlock"
                );

            } finally {
                await ethers.provider.send("evm_setAutomine", [true]);
                await ethers.provider.send("evm_mine");
            }
        });

        it("should revert if reveal deadline has passed", async function () {
            await ethers.provider.send("hardhat_mine", ["0x16"]);
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitExpiredError");
        });

        it("should effectively expire the commit once the block deadline is crossed", async function () {
            await ethers.provider.send("hardhat_mine", ["0x16"]);

            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitExpiredError");
        });

        it("should revert if hash does not match (wrong tokenId)", async function () {
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, OTHER_TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitHashMismatch");
        });

        it("should revert if hash does not match (wrong paymentAmount)", async function () {
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT + 1n, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitHashMismatch");
        });

        it("should revert if hash does not match (wrong salt)", async function () {
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n,
                ethers.encodeBytes32String("wrong")
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitHashMismatch");
        });

        it("should revert if NFT collection is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(nftCollection.target);
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CollectionNotAllowed");
        });

        it("should revert if ERC-20 payment token is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(paymentToken.target);
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "TokenNotAllowed");
        });

        it("should NOT revert on payment token blacklist check when payment type is ERC721", async function () {
            await complianceManager.connect(operator).blacklistToken(paymentToken.target);

            const hash = computeNFTListHash(
                seller.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC721, otherNFTCollection.target, 0n, OFFER_TOKEN_ID, SALT
            );
            const tx = await nftOrderbook.connect(seller).commit(hash, CommitType.NFTList);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await nftOrderbook.connect(seller).revealNFTList(
                newCommitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC721, otherNFTCollection.target, 0n, OFFER_TOKEN_ID, SALT
            );
        });

        it("should revert if seller is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(seller.address, 2);
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "UserNotAllowed");
        });

        it("should set the active listing index correctly", async function () {
            await nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const activeListingId = await nftOrderbook.getActiveListing(nftCollection.target, TOKEN_ID);
            expect(activeListingId).to.equal(1n);
        });

        it("should queue a trade and emit NFTTradeMatched when a compatible offer already exists", async function () {
            await makeERC20Offer(buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT);

            // NFTTradeMatched fires at queue time (from the orderbook)
            await expect(nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.emit(nftOrderbook, "NFTTradeMatched").withArgs(1n, 1n);
        });

        it("should emit NFTTradeExecuted on settlementEngine after batch settles", async function () {
            await makeERC20Offer(buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT);

            await nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );

            await advanceTime(SETTLEMENT_WINDOW + 1);
            await expect(settlementEngine.settleBatch())
                .to.emit(settlementEngine, "NFTTradeExecuted");
        });

        it("should NOT match if offer amount is below listing price", async function () {
            await makeERC20Offer(buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT - 1n);

            await nftOrderbook.connect(seller).revealNFTList(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );

            const listing = await nftOrderbook.getNFTListing(
                await nftOrderbook.getActiveListing(nftCollection.target, TOKEN_ID)
            );
            expect(listing.status).to.equal(NFTStatus.Active);
        });
    });


    //----------------------------------------------revealNFTOffer()---------------------------------------------------

    describe("revealNFTOffer()", function () {

        let commitId: bigint;

        beforeEach(async function () {
            const hash = computeNFTOfferHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const tx = await nftOrderbook.connect(buyer).commit(hash, CommitType.NFTOffer);
            const receipt = await tx.wait();
            commitId = receipt.logs[0].args[0];
        });

        it("should create an active ERC-20 offer and lock payment funds", async function () {
            const lockedBefore = await custodian.lockedBalanceOf(buyer.address, paymentToken.target);

            await nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );

            const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTOfferMade());
            const offerId = events[events.length - 1].args.offerId;
            const offer = await nftOrderbook.getNFTOffer(offerId);

            expect(offer.buyer).to.equal(buyer.address);
            expect(offer.collection).to.equal(nftCollection.target);
            expect(offer.tokenId).to.equal(TOKEN_ID);
            expect(offer.offerType).to.equal(AssetType.ERC20);
            expect(offer.offerToken).to.equal(paymentToken.target);
            expect(offer.offerAmount).to.equal(PAYMENT_AMOUNT);
            expect(offer.status).to.equal(NFTStatus.Active);

            const lockedAfter = await custodian.lockedBalanceOf(buyer.address, paymentToken.target);
            expect(lockedAfter).to.equal(lockedBefore + PAYMENT_AMOUNT);
        });

        it("should lock the NFT when offer type is ERC721", async function () {
            const hash = computeNFTOfferHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC721, otherNFTCollection.target, 0n, OFFER_TOKEN_ID, SALT
            );
            const tx = await nftOrderbook.connect(buyer).commit(hash, CommitType.NFTOffer);
            const receipt = await tx.wait();
            const nftCommitId = receipt.logs[0].args[0];

            await nftOrderbook.connect(buyer).revealNFTOffer(
                nftCommitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC721, otherNFTCollection.target, 0n, OFFER_TOKEN_ID, SALT
            );

            const custodianBalance = await otherNFTCollection.ownerOf(OFFER_TOKEN_ID);
            expect(custodianBalance).to.equal(custodian.target);
        });

        it("should emit NFTOfferMade event", async function () {
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.emit(nftOrderbook, "NFTOfferMade")
              .withArgs(1n, buyer.address, nftCollection.target, TOKEN_ID);
        });

        it("should mark commit as revealed", async function () {
            await nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const pending = await nftOrderbook.getPendingCommit(commitId);
            expect(pending.revealed).to.be.true;
        });

        it("should revert if commit not found", async function () {
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                999n, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitNotFound");
        });

        it("should revert if caller is not commit owner", async function () {
            await expect(nftOrderbook.connect(seller).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "NotCommitOwner");
        });

        it("should revert if commit type is NFTList instead of NFTOffer", async function () {
            const listHash = computeNFTListHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const tx = await nftOrderbook.connect(buyer).commit(listHash, CommitType.NFTList);
            const receipt = await tx.wait();
            const listCommitId = receipt.logs[0].args[0];

            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                listCommitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "WrongCommitType");
        });

        it("should revert if already revealed", async function () {
            await nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitAlreadyRevealed");
        });

        it("should revert if reveal deadline has passed", async function () {
            await ethers.provider.send("hardhat_mine", ["0x15"]);
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitExpiredError");
        });

        it("should revert if hash does not match (wrong amount)", async function () {
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT - 1n, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitHashMismatch");
        });

        it("should revert if hash does not match (wrong offerType)", async function () {
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC721, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CommitHashMismatch");
        });

        it("should revert if buyer is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(buyer.address, 2);
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "UserNotAllowed");
        });

        it("should revert if NFT collection is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(nftCollection.target);
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "CollectionNotAllowed");
        });

        it("should revert if ERC-20 offer token is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(paymentToken.target);
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.be.revertedWithCustomError(nftOrderbook, "TokenNotAllowed");
        });

        it("should NOT revert offer token blacklist when offer type is ERC721", async function () {
            await complianceManager.connect(operator).blacklistToken(paymentToken.target);

            const hash = computeNFTOfferHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC721, otherNFTCollection.target, 0n, OFFER_TOKEN_ID, SALT
            );
            const tx = await nftOrderbook.connect(buyer).commit(hash, CommitType.NFTOffer);
            const receipt = await tx.wait();
            const nftCommitId = receipt.logs[0].args[0];

            await nftOrderbook.connect(buyer).revealNFTOffer(
                nftCommitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC721, otherNFTCollection.target, 0n, OFFER_TOKEN_ID, SALT
            );
        });

        it("should queue a trade and emit NFTTradeMatched when a compatible listing already exists", async function () {
            await listNFTForERC20(seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT);

            // NFTTradeMatched fires at queue time (from the orderbook)
            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            )).to.emit(nftOrderbook, "NFTTradeMatched");
        });

        it("should emit NFTTradeExecuted on settlementEngine after batch settles", async function () {
            await listNFTForERC20(seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT);

            await nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );

            await advanceTime(SETTLEMENT_WINDOW + 1);
            await expect(settlementEngine.settleBatch())
                .to.emit(settlementEngine, "NFTTradeExecuted");
        });

        it("should NOT match when no active listing exists for the NFT", async function () {
            await nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );

            const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTTradeMatched());
            expect(events.length).to.equal(0);
        });

        it("should match offer against listing even when offer exceeds listing price", async function () {
            await listNFTForERC20(seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT);

            const higherAmount = PAYMENT_AMOUNT * 2n;
            const hash = computeNFTOfferHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, higherAmount, 0n, SALT
            );
            const tx = await nftOrderbook.connect(buyer).commit(hash, CommitType.NFTOffer);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await expect(nftOrderbook.connect(buyer).revealNFTOffer(
                newCommitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, higherAmount, 0n, SALT
            )).to.emit(nftOrderbook, "NFTTradeMatched");
        });
    });


    //----------------------------------------------cancelNFTListing()---------------------------------------------------

    describe("cancelNFTListing()", function () {

        let listingId: bigint;

        beforeEach(async function () {
            listingId = await listNFTForERC20(
                seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );
        });

        it("should allow seller to cancel their listing", async function () {
            await nftOrderbook.connect(seller).cancelNFTListing(listingId);
            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.status).to.equal(NFTStatus.Inactive);
        });

        it("should unlock the NFT back to the seller on cancel", async function () {
            await nftOrderbook.connect(seller).cancelNFTListing(listingId);

            const [held, locked] = await custodian.nftBalanceOf(
                seller.address,
                nftCollection.target,
                TOKEN_ID
            );

            expect(held).to.be.true;
            expect(locked).to.be.false;

            expect(await nftCollection.ownerOf(TOKEN_ID)).to.equal(custodian.target);
        });

        it("should clear the active listing index on cancel", async function () {
            await nftOrderbook.connect(seller).cancelNFTListing(listingId);
            const activeListingId = await nftOrderbook.getActiveListing(nftCollection.target, TOKEN_ID);
            expect(activeListingId).to.equal(0n);
        });

        it("should allow SettlementEngine to cancel a listing", async function () {
            await nftOrderbook.connect(settlementEngineSigner).cancelNFTListing(listingId);
            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.status).to.equal(NFTStatus.Inactive);
        });

        it("should revert if caller is neither seller nor SettlementEngine", async function () {
            await expect(nftOrderbook.connect(buyer).cancelNFTListing(listingId))
                .to.be.revertedWithCustomError(nftOrderbook, "NotOrderOwner");
        });

        it("should revert if listing is not active", async function () {
            await nftOrderbook.connect(seller).cancelNFTListing(listingId);
            await expect(nftOrderbook.connect(seller).cancelNFTListing(listingId))
                .to.be.revertedWithCustomError(nftOrderbook, "NotActive");
        });

        it("should revert for non-existent listing ID", async function () {
            await expect(nftOrderbook.connect(seller).cancelNFTListing(999n))
                .to.be.revertedWithCustomError(nftOrderbook, "NotActive");
        });

        it("should emit NFTListingCancelled event", async function () {
            await expect(nftOrderbook.connect(seller).cancelNFTListing(listingId))
                .to.emit(nftOrderbook, "NFTListingCancelled")
                .withArgs(listingId, seller.address);
        });
    });


    //----------------------------------------------cancelNFTOffer()---------------------------------------------------

    describe("cancelNFTOffer()", function () {

        let offerId: bigint;

        beforeEach(async function () {
            offerId = await makeERC20Offer(
                buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );
        });

        it("should allow buyer to cancel their ERC-20 offer", async function () {
            await nftOrderbook.connect(buyer).cancelNFTOffer(offerId);
            const offer = await nftOrderbook.getNFTOffer(offerId);
            expect(offer.status).to.equal(NFTStatus.Inactive);
        });

        it("should unlock ERC-20 funds back to buyer on cancel", async function () {
            const lockedBefore = await custodian.lockedBalanceOf(buyer.address, paymentToken.target);
            await nftOrderbook.connect(buyer).cancelNFTOffer(offerId);
            const lockedAfter = await custodian.lockedBalanceOf(buyer.address, paymentToken.target);
            expect(lockedAfter).to.equal(lockedBefore - PAYMENT_AMOUNT);
        });

        it("should move NFT from locked to held in custodian when cancelling an ERC721 offer", async function () {
            const nftOfferId = await makeNFTOffer(buyer, nftCollection.target, TOKEN_ID, otherNFTCollection.target, OFFER_TOKEN_ID);

            await nftOrderbook.connect(buyer).cancelNFTOffer(nftOfferId);

            const [held, locked] = await custodian.nftBalanceOf(
                buyer.address,
                otherNFTCollection.target,
                OFFER_TOKEN_ID
            );

            expect(held).to.be.true;
            expect(locked).to.be.false;

            expect(await otherNFTCollection.ownerOf(OFFER_TOKEN_ID)).to.equal(custodian.target);
        });

        it("should allow SettlementEngine to cancel an offer", async function () {
            await nftOrderbook.connect(settlementEngineSigner).cancelNFTOffer(offerId);
            const offer = await nftOrderbook.getNFTOffer(offerId);
            expect(offer.status).to.equal(NFTStatus.Inactive);
        });

        it("should revert if caller is neither buyer nor SettlementEngine", async function () {
            await expect(nftOrderbook.connect(seller).cancelNFTOffer(offerId))
                .to.be.revertedWithCustomError(nftOrderbook, "NotOrderOwner");
        });

        it("should revert if offer is not active", async function () {
            await nftOrderbook.connect(buyer).cancelNFTOffer(offerId);
            await expect(nftOrderbook.connect(buyer).cancelNFTOffer(offerId))
                .to.be.revertedWithCustomError(nftOrderbook, "NotActive");
        });

        it("should revert for non-existent offer ID", async function () {
            await expect(nftOrderbook.connect(buyer).cancelNFTOffer(999n))
                .to.be.revertedWithCustomError(nftOrderbook, "NotActive");
        });

        it("should emit NFTOfferCancelled event", async function () {
            await expect(nftOrderbook.connect(buyer).cancelNFTOffer(offerId))
                .to.emit(nftOrderbook, "NFTOfferCancelled")
                .withArgs(offerId, buyer.address);
        });
    });


    //----------------------------------------------deactivateListing() / deactivateOffer()----------------------------

    describe("deactivateListing() / deactivateOffer()", function () {

        it("should allow SettlementEngine to deactivate a listing", async function () {
            const listingId = await listNFTForERC20(
                seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );
            await nftOrderbook.connect(settlementEngineSigner).deactivateListing(listingId);
            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.status).to.equal(NFTStatus.Inactive);
        });

        it("should revert if non-SettlementEngine tries to deactivate a listing", async function () {
            const listingId = await listNFTForERC20(
                seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );
            await expect(nftOrderbook.connect(seller).deactivateListing(listingId))
                .to.be.revertedWithCustomError(nftOrderbook, "NotSettlementEngine");
        });

        it("should allow SettlementEngine to deactivate an offer", async function () {
            const offerId = await makeERC20Offer(
                buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );
            await nftOrderbook.connect(settlementEngineSigner).deactivateOffer(offerId);
            const offer = await nftOrderbook.getNFTOffer(offerId);
            expect(offer.status).to.equal(NFTStatus.Inactive);
        });

        it("should revert if non-SettlementEngine tries to deactivate an offer", async function () {
            const offerId = await makeERC20Offer(
                buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );
            await expect(nftOrderbook.connect(buyer).deactivateOffer(offerId))
                .to.be.revertedWithCustomError(nftOrderbook, "NotSettlementEngine");
        });
    });


    //----------------------------------------------Matching Logic Edge Cases---------------------------------------------------

    describe("Matching logic edge cases", function () {

        it("should pick the highest ERC-20 offer when multiple exist below listing price", async function () {
            await makeERC20Offer(buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT / 2n);
            await makeERC20Offer(buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT / 4n);

            const listingId = await listNFTForERC20(
                seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );

            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.status).to.equal(NFTStatus.Active);
        });

        it("should pick the highest ERC-20 offer when multiple meet the listing price", async function () {
            const lowOffer  = PAYMENT_AMOUNT;
            const highOffer = PAYMENT_AMOUNT * 2n;

            await paymentToken.mint(buyer.address, TOKEN_DEPOSIT);
            await paymentToken.connect(buyer).approve(custodian.target, TOKEN_DEPOSIT);
            await custodian.connect(buyer).deposit(paymentToken.target, TOKEN_DEPOSIT);

            const hash1 = computeNFTOfferHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, lowOffer, 0n, SALT
            );
            const tx1 = await nftOrderbook.connect(buyer).commit(hash1, CommitType.NFTOffer);
            const r1 = await tx1.wait();
            await nftOrderbook.connect(buyer).revealNFTOffer(
                r1.logs[0].args[0], nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, lowOffer, 0n, SALT
            );

            const SALT2 = ethers.encodeBytes32String("secret2");
            const hash2 = computeNFTOfferHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, highOffer, 0n, SALT2
            );
            const tx2 = await nftOrderbook.connect(buyer).commit(hash2, CommitType.NFTOffer);
            const r2 = await tx2.wait();
            await nftOrderbook.connect(buyer).revealNFTOffer(
                r2.logs[0].args[0], nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, highOffer, 0n, SALT2
            );

            const tx3 = await nftOrderbook.connect(seller).commit(
                computeNFTListHash(
                    seller.address, nftCollection.target, TOKEN_ID,
                    AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
                ),
                CommitType.NFTList
            );
            const r3 = await tx3.wait();
            await nftOrderbook.connect(seller).revealNFTList(
                r3.logs[0].args[0], nftCollection.target, TOKEN_ID,
                AssetType.ERC20, paymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );

            const matchEvent = (await nftOrderbook.queryFilter(nftOrderbook.filters.NFTTradeMatched()))[0];
            expect(matchEvent.args.offerId).to.equal(2n);
        });

        it("should match NFT-for-NFT immediately on the first compatible offer regardless of amount", async function () {
            await makeNFTOffer(
                buyer, nftCollection.target, TOKEN_ID, otherNFTCollection.target, OFFER_TOKEN_ID
            );

            const listingId = await listNFTForNFT(
                seller, nftCollection.target, TOKEN_ID, otherNFTCollection.target, OFFER_TOKEN_ID
            );

            // Trade is queued — listing stays active until batch settles
            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.status).to.equal(NFTStatus.Active);

            await advanceTime(SETTLEMENT_WINDOW + 1);
            await settlementEngine.settleBatch();

            expect((await nftOrderbook.getNFTListing(listingId)).status).to.equal(NFTStatus.Inactive);
        });

        it("should NOT match NFT-for-NFT if desired tokenId differs", async function () {
            const WRONG_TOKEN_ID = 99n;
            await otherNFTCollection.mint(buyer.address, WRONG_TOKEN_ID);
            await otherNFTCollection.connect(buyer).approve(custodian.target, WRONG_TOKEN_ID);
            await custodian.connect(buyer).depositNFT(otherNFTCollection.target, WRONG_TOKEN_ID);

            await makeNFTOffer(
                buyer, nftCollection.target, TOKEN_ID, otherNFTCollection.target, WRONG_TOKEN_ID
            );

            const listingId = await listNFTForNFT(
                seller, nftCollection.target, TOKEN_ID, otherNFTCollection.target, OFFER_TOKEN_ID
            );

            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.status).to.equal(NFTStatus.Active);
        });

        it("should NOT match if offer payment token differs from listing payment token", async function () {
            const hash = computeNFTOfferHash(
                buyer.address, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, otherPaymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );
            const tx = await nftOrderbook.connect(buyer).commit(hash, CommitType.NFTOffer);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];
            await nftOrderbook.connect(buyer).revealNFTOffer(
                commitId, nftCollection.target, TOKEN_ID,
                AssetType.ERC20, otherPaymentToken.target, PAYMENT_AMOUNT, 0n, SALT
            );

            const listingId = await listNFTForERC20(
                seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );

            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.status).to.equal(NFTStatus.Active);
        });

        it("should NOT match if offer type mismatches listing type (ERC20 offer vs ERC721 listing)", async function () {
            const listingId = await listNFTForNFT(
                seller, nftCollection.target, TOKEN_ID, otherNFTCollection.target, OFFER_TOKEN_ID
            );

            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.status).to.equal(NFTStatus.Active);
        });

        it("should skip inactive offers during listing match scan", async function () {
            const offerId = await makeERC20Offer(
                buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );

            await nftOrderbook.connect(buyer).cancelNFTOffer(offerId);

            const listingId = await listNFTForERC20(
                seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );

            const listing = await nftOrderbook.getNFTListing(listingId);
            expect(listing.status).to.equal(NFTStatus.Active);
        });

        it("should not match offer against a cancelled listing", async function () {
            const listingId = await listNFTForERC20(
                seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );

            await nftOrderbook.connect(seller).cancelNFTListing(listingId);

            const offerId = await makeERC20Offer(
                buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );

            const offer = await nftOrderbook.getNFTOffer(offerId);
            expect(offer.status).to.equal(NFTStatus.Active);

            const events = await nftOrderbook.queryFilter(nftOrderbook.filters.NFTTradeMatched());
            expect(events.length).to.equal(0);
        });
    });


    //----------------------------------------------View Functions---------------------------------------------------

    describe("View functions", function () {

        it("getNFTListing() should return correct listing data", async function () {
            const listingId = await listNFTForERC20(
                seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );
            const listing = await nftOrderbook.getNFTListing(listingId);

            expect(listing.listingId).to.equal(listingId);
            expect(listing.seller).to.equal(seller.address);
            expect(listing.collection).to.equal(nftCollection.target);
            expect(listing.tokenId).to.equal(TOKEN_ID);
            expect(listing.paymentType).to.equal(AssetType.ERC20);
            expect(listing.paymentToken).to.equal(paymentToken.target);
            expect(listing.paymentAmount).to.equal(PAYMENT_AMOUNT);
            expect(listing.paymentTokenId).to.equal(0n);
            expect(listing.status).to.equal(NFTStatus.Active);
        });

        it("getNFTOffer() should return correct offer data", async function () {
            const offerId = await makeERC20Offer(
                buyer, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );
            const offer = await nftOrderbook.getNFTOffer(offerId);

            expect(offer.offerId).to.equal(offerId);
            expect(offer.buyer).to.equal(buyer.address);
            expect(offer.collection).to.equal(nftCollection.target);
            expect(offer.tokenId).to.equal(TOKEN_ID);
            expect(offer.offerType).to.equal(AssetType.ERC20);
            expect(offer.offerToken).to.equal(paymentToken.target);
            expect(offer.offerAmount).to.equal(PAYMENT_AMOUNT);
            expect(offer.status).to.equal(NFTStatus.Active);
        });

        it("getNFTListing() should return empty struct for non-existent id", async function () {
            const listing = await nftOrderbook.getNFTListing(999n);
            expect(listing.seller).to.equal(ethers.ZeroAddress);
            expect(listing.status).to.equal(NFTStatus.Inactive);
        });

        it("getNFTOffer() should return empty struct for non-existent id", async function () {
            const offer = await nftOrderbook.getNFTOffer(999n);
            expect(offer.buyer).to.equal(ethers.ZeroAddress);
            expect(offer.status).to.equal(NFTStatus.Inactive);
        });

        it("getActiveListing() should return 0 when no listing exists", async function () {
            expect(await nftOrderbook.getActiveListing(nftCollection.target, TOKEN_ID)).to.equal(0n);
        });

        it("getActiveListing() should return 0 after listing is cancelled", async function () {
            const listingId = await listNFTForERC20(
                seller, nftCollection.target, TOKEN_ID, paymentToken.target, PAYMENT_AMOUNT
            );
            await nftOrderbook.connect(seller).cancelNFTListing(listingId);
            expect(await nftOrderbook.getActiveListing(nftCollection.target, TOKEN_ID)).to.equal(0n);
        });

        it("getPendingCommit() should return empty struct for non-existent id", async function () {
            const pending = await nftOrderbook.getPendingCommit(999n);
            expect(pending.client).to.equal(ethers.ZeroAddress);
        });
    });
});