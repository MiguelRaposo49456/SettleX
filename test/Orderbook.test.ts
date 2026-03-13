import { expect } from "chai";
import { network } from "hardhat";
import { deploySystem } from "./utils/deploy.js";

const { ethers } = await network.connect();

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));

const CommitType = {
    Order: 0,
    Take:  1
};

const Side = {
    BUY:  0,
    SELL: 1
};

const PRICE_PRECISION = ethers.parseUnits("1", 18);

//----------------------------------------------off-chain Helpers--------------------------------------------------
function computeOrderHash(
    sender: string,
    tokenIn: string,
    tokenOut: string,
    price: bigint,
    amount: bigint,
    side: number,
    partialAllowed: boolean,
    salt: string
): string {
    return ethers.solidityPackedKeccak256(
        ["address", "address", "address", "uint256", "uint256", "uint8", "bool", "bytes32"],
        [sender, tokenIn, tokenOut, price, amount, side, partialAllowed, salt]
    );
}

function computeTakeHash(
    sender: string,
    makerOrderId: bigint,
    takerAmount: bigint,
    salt: string
): string {
    return ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint256", "bytes32"],
        [sender, makerOrderId, takerAmount, salt]
    );
}



describe("OrderBook", function() {
    let admin: any, operator: any, client1: any, client2: any;
    let complianceManager: any, orderbook: any, custodian: any, settlementEngine: any;
    let tokenA: any, tokenB: any;
    let settlementEngineSigner: any;

    //Order params
    const AMOUNT = ethers.parseUnits("100", 18);
    const PRICE = ethers.parseUnits("2", 18);   // 2 tokenB per tokenA
    const SALT = ethers.encodeBytes32String("secret");
    const DEPOSIT = ethers.parseUnits("1000", 18);

    beforeEach(async function () {
        ({ admin, client1, client2, complianceManager, orderbook, custodian, settlementEngine, tokenA, tokenB }
            = await deploySystem(ethers));

        [, operator] = await ethers.getSigners();
        await complianceManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        // Impersonate SettlementEngine for updateOrderAmount tests
        settlementEngineSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
        await ethers.provider.send("hardhat_setBalance", [
            settlementEngine.target,
            ethers.toQuantity(ethers.parseEther("1.0"))
        ]);

        // Mint tokens to clients
        await tokenA.mint(client1.address, DEPOSIT);
        await tokenA.mint(client2.address, DEPOSIT);
        await tokenB.mint(client1.address, DEPOSIT);
        await tokenB.mint(client2.address, DEPOSIT);

        // Approve custodian
        await tokenA.connect(client1).approve(custodian.target, DEPOSIT);
        await tokenA.connect(client2).approve(custodian.target, DEPOSIT);
        await tokenB.connect(client1).approve(custodian.target, DEPOSIT);
        await tokenB.connect(client2).approve(custodian.target, DEPOSIT);

        // Deposit into custodian
        await custodian.connect(client1).deposit(tokenA.target, DEPOSIT);
        await custodian.connect(client1).deposit(tokenB.target, DEPOSIT);
        await custodian.connect(client2).deposit(tokenA.target, DEPOSIT);
        await custodian.connect(client2).deposit(tokenB.target, DEPOSIT);
    });

    //----------------------------------------------off-chain Helpers---------------------------------------------------
    async function placeOrder(
        client: any,
        tokenIn: string,
        tokenOut: string,
        price: bigint,
        amount: bigint,
        side: number,
        partialAllowed: boolean
    ) {
        const hash = computeOrderHash(
            client.address, tokenIn, tokenOut, price, amount, side, partialAllowed, SALT
        );
        const tx = await orderbook.connect(client).commit(hash, CommitType.Order);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];

        await orderbook.connect(client).revealOrder(
            commitId, tokenIn, tokenOut, price, amount, side, partialAllowed, SALT
        );

        // Return the orderId from the OrderPlaced event
        const filter = orderbook.filters.OrderPlaced();
        const events = await orderbook.queryFilter(filter, receipt.blockNumber);
        return events[events.length - 1].args.orderId;
    }

    //----------------------------------------------Commit---------------------------------------------------

    describe("commit()", function () {

        it("should store an order commit with correct data", async function () {
            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const tx = await orderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            const pending = await orderbook.getPendingCommit(commitId);
            expect(pending.commitHash).to.equal(hash);
            expect(pending.client).to.equal(client1.address);
            expect(pending.revealed).to.be.false;
            expect(pending.expired).to.be.false;
            expect(pending.commitType).to.equal(CommitType.Order);
        });

        it("should store a take commit with correct data", async function () {
            const hash = computeTakeHash(client1.address, 1n, AMOUNT, SALT);
            const tx = await orderbook.connect(client1).commit(hash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            const pending = await orderbook.getPendingCommit(commitId);
            expect(pending.commitType).to.equal(CommitType.Take);
        });

        it("should use shorter reveal window for take commits", async function () {
            const orderHash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const takeHash = computeTakeHash(client1.address, 1n, AMOUNT, SALT);

            const orderTx = await orderbook.connect(client1).commit(orderHash, CommitType.Order);
            const takeTx  = await orderbook.connect(client1).commit(takeHash, CommitType.Take);

            const orderReceipt = await orderTx.wait();
            const takeReceipt  = await takeTx.wait();

            const orderCommitId = orderReceipt.logs[0].args[0];
            const takeCommitId  = takeReceipt.logs[0].args[0];

            const orderPending = await orderbook.getPendingCommit(orderCommitId);
            const takePending  = await orderbook.getPendingCommit(takeCommitId);

            expect(orderPending.revealDeadline - orderPending.commitBlock).to.equal(20n);
            expect(takePending.revealDeadline  - takePending.commitBlock).to.equal(10n);
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            await expect(orderbook.connect(client1).commit(hash, CommitType.Order))
                .to.be.revertedWithCustomError(orderbook, "SystemPaused");
        });

        it("should emit Committed event", async function () {
            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            await expect(orderbook.connect(client1).commit(hash, CommitType.Order))
                .to.emit(orderbook, "Committed");
        });
    });

    //----------------------------------------------Reveal Order---------------------------------------------------

    describe("revealOrder()", function () {

        let commitId: bigint;

        beforeEach(async function () {
            const hash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const tx = await orderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            commitId = receipt.logs[0].args[0];
        });

        it("should place an order and lock funds on successful reveal", async function () {
            await orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const lockedAmount = await custodian.lockedBalanceOf(client1.address, tokenA.target);
            expect(lockedAmount).to.equal(AMOUNT);
        });

        it("should emit OrderPlaced on successful reveal", async function () {
            await expect(orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.emit(orderbook, "OrderPlaced");
        });

        it("should revert if commit not found", async function () {
            await expect(orderbook.connect(client1).revealOrder(
                999n, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "CommitNotFound");
        });

        it("should revert if caller is not the commit owner", async function () {
            await expect(orderbook.connect(client2).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "NotCommitOwner");
        });

        it("should revert if commit type is Take", async function () {
            const takeHash = computeTakeHash(client1.address, 1n, AMOUNT, SALT);
            const tx = await orderbook.connect(client1).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const takeCommitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client1).revealOrder(
                takeCommitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "WrongCommitType");
        });

        it("should revert if already revealed", async function () {
            await orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            await expect(orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "CommitAlreadyRevealed");
        });

        it("should revert if reveal deadline has passed", async function () {
            await ethers.provider.send("hardhat_mine", ["0x15"]); // mine 21 blocks
            await expect(orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "CommitExpiredError");
        });

        it("should revert if hash does not match", async function () {
            await expect(orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, false, SALT // partialAllowed differs
            )).to.be.revertedWithCustomError(orderbook, "CommitHashMismatch");
        });

        it("should revert on zero amount", async function () {
            const hash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, PRICE, 0n, Side.SELL, true, SALT
            );
            const tx = await orderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client1).revealOrder(
                newCommitId, tokenB.target, tokenA.target, PRICE, 0n, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "ZeroAmount");
        });

        it("should revert on zero price", async function () {
            const hash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, 0n, AMOUNT, Side.SELL, true, SALT
            );
            const tx = await orderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client1).revealOrder(
                newCommitId, tokenB.target, tokenA.target, 0n, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "ZeroPrice");
        });

        it("should revert if tokenIn equals tokenOut", async function () {
            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const tx = await orderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client1).revealOrder(
                newCommitId, tokenA.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "SameToken");
        });

        it("should revert on invalid side", async function () {
            const hash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, PRICE, AMOUNT, 5, true, SALT
            );
            const tx = await orderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client1).revealOrder(
                newCommitId, tokenB.target, tokenA.target, PRICE, AMOUNT, 5, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "InvalidSide");
        });

        it("should revert if token is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenA.target);
            await expect(orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "TokenNotAllowed");
        });

        it("should revert if user is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, 2);
            await expect(orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(orderbook, "UserNotAllowed");
        });

        it("should store order in book if no match found", async function () {
            await orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const order = await orderbook.getOrder(1n);
            expect(order.active).to.be.true;
            expect(order.amount).to.equal(AMOUNT);
        });

        it("should fully match two compatible orders", async function () {
            // client1 places SELL
            await orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );

            // client2 places BUY at same price
            const buyHash = computeOrderHash(
                client2.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT
            );
            const buyTx = await orderbook.connect(client2).commit(buyHash, CommitType.Order);
            const buyReceipt = await buyTx.wait();
            const buyCommitId = buyReceipt.logs[0].args[0];

            await expect(orderbook.connect(client2).revealOrder(
                buyCommitId, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT
            )).to.emit(orderbook, "OrderMatched");

            // client1's sell order should be fully filled
            const makerOrder = await orderbook.getOrder(1n);
            expect(makerOrder.active).to.be.false;
        });
    });

    //----------------------------------------------Reveal Take---------------------------------------------------

    describe("revealTake()", function () {

        let makerOrderId: bigint;

        beforeEach(async function () {
            // client1 places a SELL order
            makerOrderId = await placeOrder(
                client1, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true
            );
        });

        it("should execute a take and update maker order", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await orderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT);

            const makerOrder = await orderbook.getOrder(makerOrderId);
            expect(makerOrder.active).to.be.false;
        });

        it("should revert if commit not found", async function () {
            await expect(orderbook.connect(client2).revealTake(999n, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(orderbook, "CommitNotFound");
        });

        it("should revert if caller is not the commit owner", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client1).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(orderbook, "NotCommitOwner");
        });

        it("should revert if commit type is Order", async function () {
            const orderHash = computeOrderHash(
                client2.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT
            );
            const tx = await orderbook.connect(client2).commit(orderHash, CommitType.Order);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(orderbook, "WrongCommitType");
        });

        it("should revert if already revealed", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await orderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT);
            await expect(orderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(orderbook, "CommitAlreadyRevealed");
        });

        it("should revert if reveal deadline has passed", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await ethers.provider.send("hardhat_mine", ["0xb"]); // mine 11 blocks
            await expect(orderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(orderbook, "CommitExpiredError");
        });

        it("should revert if hash does not match", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client2).revealTake(
                commitId, makerOrderId, AMOUNT + 1n, SALT // amount differs
            )).to.be.revertedWithCustomError(orderbook, "CommitHashMismatch");
        });

        it("should revert if maker order is not active", async function () {
            await orderbook.connect(client1).cancelOrder(makerOrderId);

            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(orderbook, "OrderNotActive");
        });

        it("should revert if maker does not allow partials and taker amount is less", async function () {
            // Place a maker order that does NOT allow partials
            const noPartialOrderId = await placeOrder(
                client1, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, false
            );

            const partialAmount = AMOUNT / 2n;
            const takeHash = computeTakeHash(client2.address, noPartialOrderId, partialAmount, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client2).revealTake(commitId, noPartialOrderId, partialAmount, SALT))
                .to.be.revertedWithCustomError(orderbook, "PartialFillNotAllowed");
        });

        it("should revert if taker is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client2.address, 2);

            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(orderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(orderbook, "UserNotAllowed");
        });

        it("should cancel maker order if maker is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, 2);

            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await orderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT);

            const makerOrder = await orderbook.getOrder(makerOrderId);
            expect(makerOrder.active).to.be.false;
        });

        it("should cancel maker order and revert if token is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenA.target);

            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await orderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await orderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT);

            const makerOrder = await orderbook.getOrder(makerOrderId);
            expect(makerOrder.active).to.be.false;
        });
    });

    //----------------------------------------------Cancel Order---------------------------------------------------

    describe("cancelOrder()", function () {

        let orderId: bigint;

        beforeEach(async function () {
            orderId = await placeOrder(
                client1, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true
            );
        });

        it("should allow order owner to cancel", async function () {
            await orderbook.connect(client1).cancelOrder(orderId);
            const order = await orderbook.getOrder(orderId);
            expect(order.active).to.be.false;
        });

        it("should unlock funds on cancel", async function () {
            const lockedBefore = await custodian.lockedBalanceOf(client1.address, tokenA.target);
            await orderbook.connect(client1).cancelOrder(orderId);
            const lockedAfter = await custodian.lockedBalanceOf(client1.address, tokenA.target);
            expect(lockedAfter).to.equal(lockedBefore - AMOUNT);
        });

        it("should allow SettlementEngine to cancel", async function () {
            await orderbook.connect(settlementEngineSigner).cancelOrder(orderId);
            const order = await orderbook.getOrder(orderId);
            expect(order.active).to.be.false;
        });

        it("should revert if caller is not owner or SettlementEngine", async function () {
            await expect(orderbook.connect(client2).cancelOrder(orderId))
                .to.be.revertedWithCustomError(orderbook, "NotOrderOwner");
        });

        it("should revert if order is not active", async function () {
            await orderbook.connect(client1).cancelOrder(orderId);
            await expect(orderbook.connect(client1).cancelOrder(orderId))
                .to.be.revertedWithCustomError(orderbook, "OrderNotActive");
        });

        it("should emit OrderCancelled event", async function () {
            await expect(orderbook.connect(client1).cancelOrder(orderId))
                .to.emit(orderbook, "OrderCancelled")
                .withArgs(orderId, client1.address);
        });
    });

    //----------------------------------------------Expire Commit---------------------------------------------------

    describe("expireCommit()", function () {

        let commitId: bigint;

        beforeEach(async function () {
            const hash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const tx = await orderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            commitId = receipt.logs[0].args[0];
        });

        it("should expire a commit after the reveal window", async function () {
            await ethers.provider.send("hardhat_mine", ["0x15"]); // mine 21 blocks
            await orderbook.connect(client1).expireCommit(commitId);
            const pending = await orderbook.getPendingCommit(commitId);
            expect(pending.expired).to.be.true;
        });

        it("should revert if still within reveal window", async function () {
            await expect(orderbook.connect(client1).expireCommit(commitId))
                .to.be.revertedWithCustomError(orderbook, "RevealWindowOpen");
        });

        it("should revert if commit not found", async function () {
            await expect(orderbook.connect(client1).expireCommit(999n))
                .to.be.revertedWithCustomError(orderbook, "CommitNotFound");
        });

        it("should revert if already revealed", async function () {
            await orderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            await ethers.provider.send("hardhat_mine", ["0x15"]);
            await expect(orderbook.connect(client1).expireCommit(commitId))
                .to.be.revertedWithCustomError(orderbook, "CommitAlreadyRevealed");
        });

        it("should revert if already expired", async function () {
            await ethers.provider.send("hardhat_mine", ["0x15"]);
            await orderbook.connect(client1).expireCommit(commitId);
            await expect(orderbook.connect(client1).expireCommit(commitId))
                .to.be.revertedWithCustomError(orderbook, "CommitExpiredError");
        });

        it("should emit CommitExpired event", async function () {
            await ethers.provider.send("hardhat_mine", ["0x15"]);
            await expect(orderbook.connect(client1).expireCommit(commitId))
                .to.emit(orderbook, "CommitExpired")
                .withArgs(commitId, client1.address);
        });
    });

    //----------------------------------------------Update Order Amount-------------------------------------------------

    describe("updateOrderAmount()", function () {

        let orderId: bigint;

        beforeEach(async function () {
            orderId = await placeOrder(
                client1, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true
            );
        });

        it("should revert if caller is not the SettlementEngine", async function () {
            await expect(orderbook.connect(client1).updateOrderAmount(orderId, AMOUNT / 2n))
                .to.be.revertedWithCustomError(orderbook, "NotSettlementEngine");
        });

        it("should update order amount and keep order active on partial fill", async function () {
            const remaining = AMOUNT / 2n;
            await orderbook.connect(settlementEngineSigner).updateOrderAmount(orderId, remaining);
            const order = await orderbook.getOrder(orderId);
            expect(order.amount).to.equal(remaining);
            expect(order.active).to.be.true;
        });

        it("should mark order inactive on full fill", async function () {
            await orderbook.connect(settlementEngineSigner).updateOrderAmount(orderId, 0n);
            const order = await orderbook.getOrder(orderId);
            expect(order.active).to.be.false;
        });

        it("should emit OrderPartiallyFilled on partial fill", async function () {
            const remaining = AMOUNT / 2n;
            await expect(orderbook.connect(settlementEngineSigner).updateOrderAmount(orderId, remaining))
                .to.emit(orderbook, "OrderPartiallyFilled");
        });
    });

    //----------------------------------------------Get Order---------------------------------------------------

    describe("getOrder()", function () {

        it("should return correct order data", async function () {
            const orderId = await placeOrder(
                client1, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true
            );
            const order = await orderbook.getOrder(orderId);
            expect(order.client).to.equal(client1.address);
            expect(order.tokenIn).to.equal(tokenB.target);
            expect(order.tokenOut).to.equal(tokenA.target);
            expect(order.price).to.equal(PRICE);
            expect(order.amount).to.equal(AMOUNT);
            expect(order.side).to.equal(Side.SELL);
            expect(order.active).to.be.true;
            expect(order.partialAllowed).to.be.true;
        });

        it("should return empty order for non-existent id", async function () {
            const order = await orderbook.getOrder(999n);
            expect(order.client).to.equal(ethers.ZeroAddress);
            expect(order.active).to.be.false;
        });
    });
});