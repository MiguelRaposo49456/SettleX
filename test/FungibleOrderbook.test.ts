import { expect } from "chai";
import { network } from "hardhat";
import { deploySystem, SETTLEMENT_WINDOW } from "./utils/deploy.js";

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

const OrderStatus = {
    Inactive: 0,
    Matched:  1,
    Active:   2
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

async function advanceTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
}

describe("FungibleOrderbook", function() {
    let admin: any, operator: any, client1: any, client2: any;
    let complianceManager: any, fungibleOrderbook: any, custodian: any, settlementEngine: any;
    let tokenA: any, tokenB: any;
    let settlementEngineSigner: any;

    //Order params
    const AMOUNT  = ethers.parseUnits("100", 18);
    const PRICE   = ethers.parseUnits("2", 18);   // 2 tokenB per tokenA
    const SALT    = ethers.encodeBytes32String("secret");
    const DEPOSIT = ethers.parseUnits("1000", 18);

    beforeEach(async function () {
        ({ admin, client1, client2, complianceManager, fungibleOrderbook, custodian, settlementEngine, tokenA, tokenB }
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
        const tx = await fungibleOrderbook.connect(client).commit(hash, CommitType.Order);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];

        await fungibleOrderbook.connect(client).revealOrder(
            commitId, tokenIn, tokenOut, price, amount, side, partialAllowed, SALT
        );

        // Return the orderId from the OrderPlaced event
        const filter = fungibleOrderbook.filters.OrderPlaced();
        const events = await fungibleOrderbook.queryFilter(filter, receipt.blockNumber);
        return events[events.length - 1].args.orderId;
    }

    //----------------------------------------------Commit---------------------------------------------------

    describe("commit()", function () {

        it("should store an order commit with correct data", async function () {
            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            const pending = await fungibleOrderbook.getPendingCommit(commitId);
            expect(pending.commitHash).to.equal(hash);
            expect(pending.client).to.equal(client1.address);
            expect(pending.revealed).to.be.false;
            expect(pending.commitType).to.equal(CommitType.Order);
        });

        it("should store a take commit with correct data", async function () {
            const hash = computeTakeHash(client1.address, 1n, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            const pending = await fungibleOrderbook.getPendingCommit(commitId);
            expect(pending.commitType).to.equal(CommitType.Take);
        });

        it("should use shorter reveal window for take commits", async function () {
            const orderHash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const takeHash = computeTakeHash(client1.address, 1n, AMOUNT, SALT);

            const orderTx = await fungibleOrderbook.connect(client1).commit(orderHash, CommitType.Order);
            const takeTx  = await fungibleOrderbook.connect(client1).commit(takeHash, CommitType.Take);

            const orderReceipt = await orderTx.wait();
            const takeReceipt  = await takeTx.wait();

            const orderCommitId = orderReceipt.logs[0].args[0];
            const takeCommitId  = takeReceipt.logs[0].args[0];

            const orderPending = await fungibleOrderbook.getPendingCommit(orderCommitId);
            const takePending  = await fungibleOrderbook.getPendingCommit(takeCommitId);

            expect(orderPending.revealDeadline - orderPending.commitBlock).to.equal(20n);
            expect(takePending.revealDeadline  - takePending.commitBlock).to.equal(10n);
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            await expect(fungibleOrderbook.connect(client1).commit(hash, CommitType.Order))
                .to.be.revertedWithCustomError(fungibleOrderbook, "SystemPaused");
        });

        it("should emit Committed event", async function () {
            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            await expect(fungibleOrderbook.connect(client1).commit(hash, CommitType.Order))
                .to.emit(fungibleOrderbook, "Committed");
        });
    });

    //----------------------------------------------Reveal Order---------------------------------------------------

    describe("revealOrder()", function () {

        let commitId: bigint;

        beforeEach(async function () {
            const hash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            commitId = receipt.logs[0].args[0];
        });

        it("should place an order and lock funds on successful reveal", async function () {
            await fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const lockedAmount = await custodian.lockedBalanceOf(client1.address, tokenA.target);
            expect(lockedAmount).to.equal(AMOUNT);
        });

        it("should emit OrderPlaced on successful reveal", async function () {
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.emit(fungibleOrderbook, "OrderPlaced");
        });

        it("should revert if commit not found", async function () {
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                999n, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "CommitNotFound");
        });

        it("should revert if caller is not the commit owner", async function () {
            await expect(fungibleOrderbook.connect(client2).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "NotCommitOwner");
        });

        it("should revert if commit type is Take", async function () {
            const takeHash = computeTakeHash(client1.address, 1n, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client1).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const takeCommitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client1).revealOrder(
                takeCommitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "WrongCommitType");
        });

        it("should revert if already revealed", async function () {
            await fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "CommitAlreadyRevealed");
        });

        it("should revert if reveal deadline has passed", async function () {
            await ethers.provider.send("hardhat_mine", ["0x15"]); // mine 21 blocks
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "CommitExpiredError");
        });

        it("should revert if hash does not match", async function () {
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, false, SALT // partialAllowed differs
            )).to.be.revertedWithCustomError(fungibleOrderbook, "CommitHashMismatch");
        });

        it("should revert on zero amount", async function () {
            const hash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, PRICE, 0n, Side.SELL, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client1).revealOrder(
                newCommitId, tokenB.target, tokenA.target, PRICE, 0n, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "ZeroAmount");
        });

        it("should revert on zero price", async function () {
            const hash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, 0n, AMOUNT, Side.SELL, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client1).revealOrder(
                newCommitId, tokenB.target, tokenA.target, 0n, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "ZeroPrice");
        });

        it("should revert if tokenIn equals tokenOut", async function () {
            const hash = computeOrderHash(
                client1.address, tokenA.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client1).revealOrder(
                newCommitId, tokenA.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "SameToken");
        });

        it("should revert on invalid side", async function () {
            const hash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, PRICE, AMOUNT, 5, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client1).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const newCommitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client1).revealOrder(
                newCommitId, tokenB.target, tokenA.target, PRICE, AMOUNT, 5, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "InvalidSide");
        });

        it("should revert if token is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenA.target);
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "TokenNotAllowed");
        });

        it("should revert if user is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, 2);
            await expect(fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            )).to.be.revertedWithCustomError(fungibleOrderbook, "UserNotAllowed");
        });

        it("should store order in book if no match found", async function () {
            await fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );
            const order = await fungibleOrderbook.getOrder(1n);
            expect(order.status).to.equal(OrderStatus.Active);
            expect(order.amount).to.equal(AMOUNT);
        });

        it("should queue a matched trade and emit OrderMatched", async function () {
            // client1 places SELL
            await fungibleOrderbook.connect(client1).revealOrder(
                commitId, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true, SALT
            );

            // client2 places BUY at same price — should match and queue into the batch
            const buyHash = computeOrderHash(
                client2.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT
            );
            const buyTx = await fungibleOrderbook.connect(client2).commit(buyHash, CommitType.Order);
            const buyReceipt = await buyTx.wait();
            const buyCommitId = buyReceipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client2).revealOrder(
                buyCommitId, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT
            )).to.emit(fungibleOrderbook, "OrderMatched");

            // Trade is queued — orders are still marked active until the batch settles
            const makerOrder = await fungibleOrderbook.getOrder(1n);
            expect(makerOrder.amount).to.be.equal(0);
            expect(makerOrder.status).to.equal(OrderStatus.Matched);
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

        it("should queue a take and update the status of the order right after it matches", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT);

            // Trade is queued — maker order stays active until the batch window expires
            const makerOrder = await fungibleOrderbook.getOrder(makerOrderId);
            expect(makerOrder.status).to.equal(OrderStatus.Matched);
        });

        it("should settle take and deactivate maker after batch window expires", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT);

            await advanceTime(SETTLEMENT_WINDOW + 1);
            await settlementEngine.settleBatch();

            const makerOrder = await fungibleOrderbook.getOrder(makerOrderId);
            expect(makerOrder.amount).to.equal(0);
            expect(makerOrder.status).to.equal(OrderStatus.Inactive);
        });

        it("should revert if commit not found", async function () {
            await expect(fungibleOrderbook.connect(client2).revealTake(999n, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "CommitNotFound");
        });

        it("should revert if caller is not the commit owner", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client1).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "NotCommitOwner");
        });

        it("should revert if commit type is Order", async function () {
            const orderHash = computeOrderHash(
                client2.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client2).commit(orderHash, CommitType.Order);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "WrongCommitType");
        });

        it("should revert if already revealed", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT);
            await expect(fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "CommitAlreadyRevealed");
        });

        it("should revert if reveal deadline has passed", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await ethers.provider.send("hardhat_mine", ["0xb"]); // mine 11 blocks
            await expect(fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "CommitExpiredError");
        });

        it("should revert if hash does not match", async function () {
            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client2).revealTake(
                commitId, makerOrderId, AMOUNT + 1n, SALT // amount differs
            )).to.be.revertedWithCustomError(fungibleOrderbook, "CommitHashMismatch");
        });

        it("should revert if maker order is not active", async function () {
            await fungibleOrderbook.connect(client1).cancelOrder(makerOrderId);

            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "OrderNotActive");
        });

        it("should revert if maker does not allow partials and taker amount is less", async function () {
            const noPartialOrderId = await placeOrder(
                client1, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, false
            );

            const partialAmount = AMOUNT / 2n;
            const takeHash = computeTakeHash(client2.address, noPartialOrderId, partialAmount, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client2).revealTake(commitId, noPartialOrderId, partialAmount, SALT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "PartialFillNotAllowed");
        });

        it("should revert if taker is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client2.address, 2);

            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "UserNotAllowed");
        });

        it("should cancel maker order if maker is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, 2);

            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT);

            const makerOrder = await fungibleOrderbook.getOrder(makerOrderId);
            expect(makerOrder.status).to.equal(OrderStatus.Inactive);
        });

        it("should cancel maker order and revert if token is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenA.target);

            const takeHash = computeTakeHash(client2.address, makerOrderId, AMOUNT, SALT);
            const tx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await fungibleOrderbook.connect(client2).revealTake(commitId, makerOrderId, AMOUNT, SALT);

            const makerOrder = await fungibleOrderbook.getOrder(makerOrderId);
            expect(makerOrder.status).to.equal(OrderStatus.Inactive);
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
            await fungibleOrderbook.connect(client1).cancelOrder(orderId);
            const order = await fungibleOrderbook.getOrder(orderId);
            expect(order.status).to.equal(OrderStatus.Inactive);
        });

        it("should unlock funds on cancel", async function () {
            const lockedBefore = await custodian.lockedBalanceOf(client1.address, tokenA.target);
            await fungibleOrderbook.connect(client1).cancelOrder(orderId);
            const lockedAfter = await custodian.lockedBalanceOf(client1.address, tokenA.target);
            expect(lockedAfter).to.equal(lockedBefore - AMOUNT);
        });

        it("should allow SettlementEngine to cancel", async function () {
            await fungibleOrderbook.connect(settlementEngineSigner).cancelOrder(orderId);
            const order = await fungibleOrderbook.getOrder(orderId);
            expect(order.status).to.equal(OrderStatus.Inactive);
        });

        it("should revert if caller is not owner or SettlementEngine", async function () {
            await expect(fungibleOrderbook.connect(client2).cancelOrder(orderId))
                .to.be.revertedWithCustomError(fungibleOrderbook, "NotOrderOwner");
        });

        it("should revert if order is not active", async function () {
            await fungibleOrderbook.connect(client1).cancelOrder(orderId);
            await expect(fungibleOrderbook.connect(client1).cancelOrder(orderId))
                .to.be.revertedWithCustomError(fungibleOrderbook, "OrderNotActive");
        });

        it("should emit OrderCancelled event", async function () {
            await expect(fungibleOrderbook.connect(client1).cancelOrder(orderId))
                .to.emit(fungibleOrderbook, "OrderCancelled")
                .withArgs(orderId, client1.address);
        });
    });


    //----------------------------------------------Get Order---------------------------------------------------

    describe("getOrder()", function () {

        it("should return correct order data", async function () {
            const orderId = await placeOrder(
                client1, tokenB.target, tokenA.target, PRICE, AMOUNT, Side.SELL, true
            );
            const order = await fungibleOrderbook.getOrder(orderId);
            expect(order.client).to.equal(client1.address);
            expect(order.tokenIn).to.equal(tokenB.target);
            expect(order.tokenOut).to.equal(tokenA.target);
            expect(order.price).to.equal(PRICE);
            expect(order.amount).to.equal(AMOUNT);
            expect(order.side).to.equal(Side.SELL);
            expect(order.status).to.equal(OrderStatus.Active);
            expect(order.partialAllowed).to.be.true;
        });

        it("should return empty order for non-existent id", async function () {
            const order = await fungibleOrderbook.getOrder(999n);
            expect(order.client).to.equal(ethers.ZeroAddress);
            expect(order.status).to.equal(OrderStatus.Inactive);
        });
    });

    //----------------------------------------------Settlement Scenarios---------------------------------------------------

    describe("Settlement scenarios", function () {

        async function placeSellOrder(
            client: any,
            amount: bigint,
            price: bigint,
            partialAllowed: boolean
        ): Promise<bigint> {
            const hash = computeOrderHash(
                client.address, tokenB.target, tokenA.target, price, amount, Side.SELL, partialAllowed, SALT
            );
            const tx = await fungibleOrderbook.connect(client).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];
            await fungibleOrderbook.connect(client).revealOrder(
                commitId, tokenB.target, tokenA.target, price, amount, Side.SELL, partialAllowed, SALT
            );
            const events = await fungibleOrderbook.queryFilter(fungibleOrderbook.filters.OrderPlaced(), receipt.blockNumber);
            return events[events.length - 1].args.orderId;
        }

        async function placeBuyOrder(
            client: any,
            amount: bigint,
            price: bigint,
            partialAllowed: boolean
        ): Promise<bigint> {
            const hash = computeOrderHash(
                client.address, tokenA.target, tokenB.target, price, amount, Side.BUY, partialAllowed, SALT
            );
            const tx = await fungibleOrderbook.connect(client).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];
            await fungibleOrderbook.connect(client).revealOrder(
                commitId, tokenA.target, tokenB.target, price, amount, Side.BUY, partialAllowed, SALT
            );
            const events = await fungibleOrderbook.queryFilter(fungibleOrderbook.filters.OrderPlaced(), receipt.blockNumber);
            return events[events.length - 1].args.orderId;
        }

        async function setupAndMatch(
            sellAmount: bigint,
            buyAmount: bigint,
            price: bigint,
            sellPartial: boolean,
            buyPartial: boolean
        ): Promise<{ makerOrderId: bigint, takerOrderId: bigint }> {
            const makerOrderId = await placeSellOrder(client1, sellAmount, price, sellPartial);
            const takerOrderId = await placeBuyOrder(client2, buyAmount, price, buyPartial);
            return { makerOrderId, takerOrderId };
        }

        it("should emit TradeExecuted on settlementEngine after batch settles", async function () {
            const makerOrderId = await placeSellOrder(client1, AMOUNT, PRICE, true);

            const hash = computeOrderHash(
                client2.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client2).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];
            await fungibleOrderbook.connect(client2).revealOrder(
                commitId, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT
            );

            await advanceTime(SETTLEMENT_WINDOW + 1);
            await expect(settlementEngine.settleBatch())
                .to.emit(settlementEngine, "TradeExecuted");
        });

        it("should partially fill maker when taker amount is smaller, after batch settles", async function () {
            const makerAmount = AMOUNT;
            const takerAmount = AMOUNT / 2n;
            const { makerOrderId, takerOrderId } = await setupAndMatch(
                makerAmount, takerAmount, PRICE, true, true
            );

            await advanceTime(SETTLEMENT_WINDOW + 1);
            await settlementEngine.settleBatch();

            const makerOrder = await fungibleOrderbook.getOrder(makerOrderId);
            const takerOrder = await fungibleOrderbook.getOrder(takerOrderId);
            expect(takerOrder.status).to.equal(OrderStatus.Inactive);
            expect(makerOrder.status).to.equal(OrderStatus.Active);
            expect(makerOrder.amount).to.equal(makerAmount - takerAmount);
        });

        it("should partially fill taker when maker amount is smaller, after batch settles", async function () {
            const makerAmount = AMOUNT / 2n;
            const takerAmount = AMOUNT;
            const { makerOrderId, takerOrderId } = await setupAndMatch(
                makerAmount, takerAmount, PRICE, true, true
            );

            await advanceTime(SETTLEMENT_WINDOW + 1);
            await settlementEngine.settleBatch();

            const makerOrder = await fungibleOrderbook.getOrder(makerOrderId);
            const takerOrder = await fungibleOrderbook.getOrder(takerOrderId);

            expect(makerOrder.status).to.equal(OrderStatus.Inactive);
            expect(takerOrder.status).to.equal(OrderStatus.Active);
            expect(takerOrder.amount).to.equal(takerAmount - makerAmount);
        });

        it("should revert if executeTrade is called by non-OrderBook", async function () {
            await expect(settlementEngine.connect(client1).executeTrade(1n, 2n, 3n))
                .to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });

        it("should revert if executeDirectTrade is called by non-Orderbook", async function () {
            const takerOrder: any = {
                id: 0n,
                client: client2.address,
                pairId: ethers.ZeroHash,
                tokenIn: tokenA.target,
                tokenOut: tokenB.target,
                price: PRICE,
                amount: AMOUNT,
                lockedAmount: AMOUNT,
                side: Side.BUY,
                status: OrderStatus.Active,
                block: 0n,
                partialAllowed: false
            };
            await expect(settlementEngine.connect(client1).executeDirectTrade(1n, takerOrder, 3n))
                .to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });
    });
});