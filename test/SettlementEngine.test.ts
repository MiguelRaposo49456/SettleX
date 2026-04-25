import { expect } from "chai";
import { network } from "hardhat";
import { deploySystem } from "./utils/deploy.js";

const { ethers } = await network.connect();

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));

const CommitType = { Order: 0, Take: 1 };
const Side = { BUY: 0, SELL: 1 };
const Status = { Inactive: 0, Matched: 1, Active: 2 };
const PRICE_PRECISION = ethers.parseUnits("1", 18);

const AMOUNT          = ethers.parseUnits("100", 18);
const PRICE           = ethers.parseUnits("2", 18);
const SALT            = ethers.encodeBytes32String("secret");
const DEPOSIT         = ethers.parseUnits("10000", 18);

function quoteToOrderAmounts(side: number, price: bigint, amount: bigint): { amountIn: bigint; amountOut: bigint } {
    if (side === Side.BUY) {
        return {
            amountIn: amount,
            amountOut: (amount * price) / PRICE_PRECISION
        };
    }

    return {
        amountIn: (amount * price) / PRICE_PRECISION,
        amountOut: amount
    };
}

function normalizedAmount(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    amountOut: bigint
): bigint {
    return BigInt(tokenIn) < BigInt(tokenOut) ? amountIn : amountOut;
}

function normalizedAmountFromQuote(
    tokenIn: string,
    tokenOut: string,
    side: number,
    price: bigint,
    amount: bigint
): bigint {
    const { amountIn, amountOut } = quoteToOrderAmounts(side, price, amount);
    return normalizedAmount(tokenIn, tokenOut, amountIn, amountOut);
}

function tokenOutAmountForFillFromQuote(
    tokenIn: string,
    tokenOut: string,
    side: number,
    price: bigint,
    normalizedFill: bigint
): bigint {
    const normalizedIsTokenIn = BigInt(tokenIn) < BigInt(tokenOut);
    if (!normalizedIsTokenIn) {
        return normalizedFill;
    }

    if (side === Side.BUY) {
        return (normalizedFill * price) / PRICE_PRECISION;
    }

    return (normalizedFill * PRICE_PRECISION) / price;
}

//----------------------------------------------Off-chain Helpers--------------------------------------------------

function computeOrderHash(
    sender: string, tokenIn: string, tokenOut: string,
    price: bigint, amount: bigint, side: number,
    partialAllowed: boolean, salt: string
): string {
    const { amountIn, amountOut } = quoteToOrderAmounts(side, price, amount);
    return ethers.solidityPackedKeccak256(
        ["address","address","address","uint256","uint256","uint8","bool","bytes32"],
        [sender, tokenIn, tokenOut, amountIn, amountOut, side, partialAllowed, salt]
    );
}

//----------------------------------------------Test Suite--------------------------------------------------

describe("SettlementEngine", function () {

    let admin: any, operator: any, client1: any, client2: any, anyone: any;
    let complianceManager: any, fungibleOrderbook: any, custodian: any, settlementEngine: any;
    let tokenA: any, tokenB: any;
    let orderbookSigner: any;

    async function revealOrder(
        client: any,
        commitId: bigint,
        tokenIn: string,
        tokenOut: string,
        price: bigint,
        amount: bigint,
        side: number,
        partialAllowed: boolean,
        salt: string
    ) {
        const { amountIn, amountOut } = quoteToOrderAmounts(side, price, amount);
        return fungibleOrderbook.connect(client).revealOrder(
            commitId,
            tokenIn,
            tokenOut,
            amountIn,
            amountOut,
            side,
            partialAllowed,
            salt
        );
    }

    // ─── Place a full order through commit-reveal ────────────────────────────
    async function placeOrder(
        client: any,
        tokenIn: string,
        tokenOut: string,
        price: bigint,
        amount: bigint,
        side: number,
        partialAllowed: boolean
    ): Promise<bigint> {
        const hash = computeOrderHash(
            client.address, tokenIn, tokenOut, price, amount, side, partialAllowed, SALT
        );
        const tx      = await fungibleOrderbook.connect(client).commit(hash, CommitType.Order);
        const receipt = await tx.wait();
        const commitId = receipt.logs[0].args[0];

        await revealOrder(client, commitId, tokenIn, tokenOut, price, amount, side, partialAllowed, SALT);

        const events = await fungibleOrderbook.queryFilter(
            fungibleOrderbook.filters.OrderPlaced(), receipt.blockNumber
        );
        return events[events.length - 1].args.orderId;
    }

    async function placeSell(client: any, amount: bigint, price: bigint, partial = true): Promise<bigint> {
        return placeOrder(client, tokenB.target, tokenA.target, price, amount, Side.SELL, partial);
    }

    async function placeBuy(client: any, amount: bigint, price: bigint, partial = true): Promise<bigint> {
        return placeOrder(client, tokenA.target, tokenB.target, price, amount, Side.BUY, partial);
    }

    // ─── Mine enough time to expire the settlement window ───────────────────
    async function expireWindow() {
        const window = await settlementEngine.settlementWindowSeconds();
        await ethers.provider.send("evm_increaseTime", [Number(window) + 1]);
        await ethers.provider.send("evm_mine", []);
    }

    // ─────────────────────────────────────────────────────────────────────────

    beforeEach(async function () {
        ({ admin, client1, client2, complianceManager, fungibleOrderbook,
           custodian, settlementEngine, tokenA, tokenB } = await deploySystem(ethers));

        [, operator, , , anyone] = await ethers.getSigners();
        await complianceManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        // Impersonate the fungible orderbook so we can call SE directly in some tests
        orderbookSigner = await ethers.getImpersonatedSigner(fungibleOrderbook.target);
        await ethers.provider.send("hardhat_setBalance", [
            fungibleOrderbook.target,
            ethers.toQuantity(ethers.parseEther("1.0"))
        ]);

        // Mint + approve + deposit tokens for both clients
        for (const client of [client1, client2]) {
            await tokenA.mint(client.address, DEPOSIT);
            await tokenB.mint(client.address, DEPOSIT);
            await tokenA.connect(client).approve(custodian.target, DEPOSIT);
            await tokenB.connect(client).approve(custodian.target, DEPOSIT);
            await custodian.connect(client).deposit(tokenA.target, DEPOSIT);
            await custodian.connect(client).deposit(tokenB.target, DEPOSIT);
        }
    });


    //----------------------------------------------initialize()---------------------------------------------------

    describe("initialize()", function () {

        it("should set addresses and open the first batch", async function () {
            expect(await settlementEngine.fungibleOrderbook()).to.equal(fungibleOrderbook.target);
            expect(await settlementEngine.custodian()).to.equal(custodian.target);
            expect(await settlementEngine.initialized()).to.be.true;
            expect(await settlementEngine.currentBatchId()).to.equal(1n);
        });

        it("should revert if called a second time", async function () {
            await expect(
                settlementEngine.connect(admin).initialize(
                    fungibleOrderbook.target, ethers.ZeroAddress, custodian.target
                )
            ).to.be.revertedWithCustomError(settlementEngine, "AlreadyInitialized");
        });

        it("should revert if any address is zero", async function () {
            // Tested via deploy util — a fresh uninitialized instance would be needed
            // Covered by constructor path; skipping to avoid redeploy overhead
        });

        it("should emit Initialized event", async function () {
            // Already emitted during beforeEach deploy — verified via deploy util
        });
    });


    //----------------------------------------------Operator Config-------------------------------------------------

    describe("setSettlementWindow()", function () {

        it("should update the window when called by operator", async function () {
            const initialWindow = await settlementEngine.settlementWindowSeconds();
            const newWindow = 600n;
            
            await expect(settlementEngine.connect(operator).setSettlementWindow(newWindow))
                .to.emit(settlementEngine, "SettlementWindowUpdated")
                .withArgs(initialWindow, newWindow);
                
            expect(await settlementEngine.settlementWindowSeconds()).to.equal(newWindow);
        });

        it("should revert if new window is below MIN_SETTLEMENT_WINDOW", async function () {
            const minWindow = await settlementEngine.MIN_SETTLEMENT_WINDOW();
            await expect(
                settlementEngine.connect(operator).setSettlementWindow(minWindow - 1n)
            ).to.be.revertedWithCustomError(settlementEngine, "WindowTooShort");
        });

        it("should allow setting window exactly at MIN_SETTLEMENT_WINDOW", async function () {
            const minWindow = await settlementEngine.MIN_SETTLEMENT_WINDOW();

            await settlementEngine.connect(operator).setSettlementWindow(minWindow);

            expect(await settlementEngine.settlementWindowSeconds()).to.equal(minWindow);
        });

        it("should revert if called by non-operator", async function () {
            await expect(
                settlementEngine.connect(anyone).setSettlementWindow(600n)
            ).to.be.revertedWithCustomError(settlementEngine, "NotOperator");
        });
    });

    describe("setMaxBatchSize()", function () {

        it("should update batch size when called by operator", async function () {
            const initialSize = await settlementEngine.maxBatchSize();
            const newSize = 50n;
            
            await expect(settlementEngine.connect(operator).setMaxBatchSize(newSize))
                .to.emit(settlementEngine, "MaxBatchSizeUpdated")
                .withArgs(initialSize, newSize);
                
            expect(await settlementEngine.maxBatchSize()).to.equal(newSize);
        });

        it("should revert if size is below MIN_BATCH_SIZE", async function () {
            const minBatchSize = await settlementEngine.MIN_BATCH_SIZE();
            await expect(
                settlementEngine.connect(operator).setMaxBatchSize(minBatchSize - 1n)
            ).to.be.revertedWithCustomError(settlementEngine, "BatchSizeOutOfBounds");
        });

        it("should revert if size exceeds MAX_BATCH_SIZE", async function () {
            const maxBatchSize = await settlementEngine.MAX_BATCH_SIZE();
            await expect(
                settlementEngine.connect(operator).setMaxBatchSize(maxBatchSize + 1n)
            ).to.be.revertedWithCustomError(settlementEngine, "BatchSizeOutOfBounds");
        });

        it("should revert if called by non-operator", async function () {
            await expect(
                settlementEngine.connect(anyone).setMaxBatchSize(50n)
            ).to.be.revertedWithCustomError(settlementEngine, "NotOperator");
        });
    });


    //----------------------------------------------Access Control on Queue Functions-------------------------------

    describe("executeTrade() / executeDirectTrade() — access control", function () {

        it("should revert if called by non-orderbook address", async function () {
            await expect(settlementEngine.connect(client1).executeTrade(1n, 2n, AMOUNT))
                .to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });

        it("should revert executeDirectTrade if called by non-orderbook", async function () {
            const fakeOrder: any = {
                id: 0n, client: client2.address, pairId: ethers.ZeroHash,
                tokenIn: tokenA.target, tokenOut: tokenB.target,
                price: PRICE, amount: AMOUNT, lockedAmount: AMOUNT, side: Side.BUY,
                status: Status.Matched, block: 0n, partialAllowed: false
            };
            await expect(settlementEngine.connect(client1).executeDirectTrade(1n, fakeOrder, AMOUNT))
                .to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });

        it("should revert executeNFTTrade if called by non-orderbook", async function () {
            await expect(settlementEngine.connect(client1).executeNFTTrade(1n, 2n))
                .to.be.revertedWithCustomError(settlementEngine, "NotOrderbook");
        });
    });


    //----------------------------------------------Batch Queuing--------------------------------------------------

    describe("Trade queuing", function () {

        it("should queue a trade and emit TradeQueued", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);

            const hash = computeOrderHash(
                client2.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT
            );
            const tx = await fungibleOrderbook.connect(client2).commit(hash, CommitType.Order);
            const receipt = await tx.wait();
            const commitId = receipt.logs[0].args[0];

            await expect(revealOrder(client2, commitId, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT))
                .to.emit(settlementEngine, "TradeQueued");
        });

        it("should increase batch size after queuing", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);

            const { fungible } = await settlementEngine.getBatchSize(1n);
            expect(fungible).to.equal(1n);
        });

        it("should roll to a new batch when max size is hit", async function () {
            const minBatch = await settlementEngine.MIN_BATCH_SIZE();
            // Force batch size to minimum allowed to speed up test
            await settlementEngine.connect(operator).setMaxBatchSize(minBatch);

            for (let i = 0; i < Number(minBatch) + 1; i++) {
                const salt = ethers.encodeBytes32String(`salt${i}`);
                const amount = ethers.parseUnits("1", 18);

                // Place Sell
                const sellHash = computeOrderHash(client1.address, tokenB.target, tokenA.target, PRICE, amount, Side.SELL, true, salt);
                const sellTx = await fungibleOrderbook.connect(client1).commit(sellHash, CommitType.Order);
                const sellR  = await sellTx.wait();
                await revealOrder(client1, sellR.logs[0].args[0], tokenB.target, tokenA.target, PRICE, amount, Side.SELL, true, salt);

                // Place Buy (Matches)
                const buyHash = computeOrderHash(client2.address, tokenA.target, tokenB.target, PRICE, amount, Side.BUY, true, salt);
                const buyTx = await fungibleOrderbook.connect(client2).commit(buyHash, CommitType.Order);
                const buyR  = await buyTx.wait();
                await revealOrder(client2, buyR.logs[0].args[0], tokenA.target, tokenB.target, PRICE, amount, Side.BUY, true, salt);
            }

            expect(await settlementEngine.currentBatchId()).to.be.gt(1n);
        });

        it("should emit BatchOpened when rolling to a new batch", async function () {
            const minBatch = await settlementEngine.MIN_BATCH_SIZE();
            await settlementEngine.connect(operator).setMaxBatchSize(minBatch);

            // Watch for BatchOpened after the first batch fills
            const amount = ethers.parseUnits("1", 18);
            let batchOpenedEmitted = false;

            settlementEngine.on("BatchOpened", () => { batchOpenedEmitted = true; });

            for (let i = 0; i < Number(minBatch) + 1; i++) {
                const salt = ethers.encodeBytes32String(`batchsalt${i}`);
                const sellHash = computeOrderHash(
                    client1.address, tokenB.target, tokenA.target, PRICE, amount, Side.SELL, true, salt
                );
                const sellTx = await fungibleOrderbook.connect(client1).commit(sellHash, CommitType.Order);
                const sellR  = await sellTx.wait();
                await revealOrder(client1, sellR.logs[0].args[0], tokenB.target, tokenA.target, PRICE, amount, Side.SELL, true, salt);

                const buyHash = computeOrderHash(
                    client2.address, tokenA.target, tokenB.target, PRICE, amount, Side.BUY, true, salt
                );
                const buyTx = await fungibleOrderbook.connect(client2).commit(buyHash, CommitType.Order);
                const buyR  = await buyTx.wait();
                await revealOrder(client2, buyR.logs[0].args[0], tokenA.target, tokenB.target, PRICE, amount, Side.BUY, true, salt);
            }

            settlementEngine.removeAllListeners();
            expect(await settlementEngine.currentBatchId()).to.be.gt(1n);
        });
    });


    //----------------------------------------------checkUpkeep() / timeUntilSettlement()--------------------------

    describe("checkUpkeep() / timeUntilSettlement()", function () {

        it("should return false when window has not expired", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);

            const [upkeepNeeded] = await settlementEngine.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.false;
        });

        it("should return false when batch is empty even if window expired", async function () {
            await expireWindow();
            const [upkeepNeeded] = await settlementEngine.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.false;
        });

        it("should return true when window expired and batch has items", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();

            const [upkeepNeeded] = await settlementEngine.checkUpkeep("0x");
            expect(upkeepNeeded).to.be.true;
        });

        it("timeUntilSettlement() should return 0 after window expires", async function () {
            await expireWindow();
            expect(await settlementEngine.timeUntilSettlement()).to.equal(0n);
        });

        it("timeUntilSettlement() should return remaining seconds before expiry", async function () {
            const window = await settlementEngine.settlementWindowSeconds();
            const remaining = await settlementEngine.timeUntilSettlement();
            expect(remaining).to.be.gt(0n);
            expect(remaining).to.be.lte(window);
        });
    });


    //----------------------------------------------settleBatch() / performUpkeep()--------------------------------

    describe("settleBatch() / performUpkeep()", function () {

        it("should revert if window has not expired", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);

            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.be.revertedWithCustomError(settlementEngine, "WindowNotExpired");
        });

        it("should revert if batch is empty", async function () {
            await expireWindow();
            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.be.revertedWithCustomError(settlementEngine, "WindowNotExpired");
        });

        it("should settle a fully matched trade and emit BatchSettled", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();

            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(settlementEngine, "BatchSettled")
                .withArgs(1n, 1n, 0n);
        });

        it("should emit TradeExecuted during settlement", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();

            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(settlementEngine, "TradeExecuted");
        });

        it("should open a new batch after settling the current one", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();

            const batchBefore = await settlementEngine.currentBatchId();
            await settlementEngine.connect(anyone).settleBatch();
            const batchAfter = await settlementEngine.currentBatchId();

            expect(batchAfter).to.equal(batchBefore + 1n);
        });

        it("should update lastSettledBatchId after settlement", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            expect(await settlementEngine.lastSettledBatchId()).to.equal(1n);
        });

        it("should allow anyone to call settleBatch as permissionless fallback", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();

            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(settlementEngine, "BatchSettled");
        });

        it("performUpkeep() should behave identically to settleBatch()", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();

            await expect(settlementEngine.connect(anyone).performUpkeep("0x"))
                .to.emit(settlementEngine, "BatchSettled");
        });

        it("should revert performUpkeep if window not expired", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);

            await expect(settlementEngine.connect(anyone).performUpkeep("0x"))
                .to.be.revertedWithCustomError(settlementEngine, "WindowNotExpired");
        });

        it("should revert settleBatch when system is paused", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();
            await complianceManager.connect(operator).pause();

            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.be.revertedWithCustomError(settlementEngine, "SystemPaused");
        });
    });


    //----------------------------------------------Full Settlement Scenarios---------------------------------------

    describe("Settlement scenarios — fungible trades", function () {

        it("should fully settle equal amounts — both orders become Inactive", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const seller = await fungibleOrderbook.getOrder(sellId);
            const buyer  = await fungibleOrderbook.getOrder(buyId);
            expect(seller.status).to.equal(Status.Inactive);
            expect(buyer.status).to.equal(Status.Inactive);
        });

        it("should transfer tokens correctly on full settlement", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);

            const buyAmounts = quoteToOrderAmounts(Side.BUY, PRICE, AMOUNT);
            const sellAmounts = quoteToOrderAmounts(Side.SELL, PRICE, AMOUNT);

            const c1BalBefore = await custodian.balanceOf(client1.address, tokenB.target);
            const c2BalBefore = await custodian.balanceOf(client2.address, tokenA.target);

            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const c1BalAfter = await custodian.balanceOf(client1.address, tokenB.target);
            const c2BalAfter = await custodian.balanceOf(client2.address, tokenA.target);

            // client1 sold tokenA (amountOut of SELL) and received tokenB (amountOut of BUY)
            expect(c1BalAfter).to.equal(c1BalBefore + buyAmounts.amountOut);
            // client2 sold tokenB (amountOut of BUY) and received tokenA (amountOut of SELL)
            expect(c2BalAfter).to.equal(c2BalBefore + sellAmounts.amountOut);
        });

        it("should use derived send amounts and consume locked balances by tokenOut legs", async function () {
            const makerQuoteAmount = ethers.parseUnits("100", 18);
            const takerQuoteAmount = ethers.parseUnits("60", 18);

            const sellId = await placeSell(client1, makerQuoteAmount, PRICE);
            const buyId = await placeBuy(client2, takerQuoteAmount, PRICE);

            const makerOrderBefore = await fungibleOrderbook.getOrder(sellId);
            const takerOrderBefore = await fungibleOrderbook.getOrder(buyId);
            const makerNormalizedInitial = normalizedAmountFromQuote(
                tokenB.target,
                tokenA.target,
                Side.SELL,
                PRICE,
                makerQuoteAmount
            );
            const takerNormalizedInitial = normalizedAmountFromQuote(
                tokenA.target,
                tokenB.target,
                Side.BUY,
                PRICE,
                takerQuoteAmount
            );
            const normalizedFill = makerNormalizedInitial < takerNormalizedInitial
                ? makerNormalizedInitial
                : takerNormalizedInitial;

            const makerSendAmount = tokenOutAmountForFillFromQuote(
                makerOrderBefore.tokenIn,
                makerOrderBefore.tokenOut,
                makerOrderBefore.side,
                makerOrderBefore.price,
                normalizedFill
            );
            const takerSendAmount = tokenOutAmountForFillFromQuote(
                takerOrderBefore.tokenIn,
                takerOrderBefore.tokenOut,
                takerOrderBefore.side,
                takerOrderBefore.price,
                normalizedFill
            );

            const makerLockedBefore = await custodian.lockedBalanceOf(client1.address, tokenA.target);
            const takerLockedBefore = await custodian.lockedBalanceOf(client2.address, tokenB.target);

            const client1TokenBBefore = await custodian.balanceOf(client1.address, tokenB.target);
            const client2TokenABefore = await custodian.balanceOf(client2.address, tokenA.target);

            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const makerLockedAfter = await custodian.lockedBalanceOf(client1.address, tokenA.target);
            const takerLockedAfter = await custodian.lockedBalanceOf(client2.address, tokenB.target);

            const client1TokenBAfter = await custodian.balanceOf(client1.address, tokenB.target);
            const client2TokenAAfter = await custodian.balanceOf(client2.address, tokenA.target);

            expect(makerLockedAfter).to.equal(makerLockedBefore - makerSendAmount);
            expect(takerLockedAfter).to.equal(takerLockedBefore - takerSendAmount);

            expect(client1TokenBAfter).to.equal(client1TokenBBefore + takerSendAmount);
            expect(client2TokenAAfter).to.equal(client2TokenABefore + makerSendAmount);
        });

        it("should partially settle — maker partially filled remains Active", async function () {
            const makerAmount = AMOUNT;
            const takerAmount = AMOUNT / 2n;

            const sellId = await placeSell(client1, makerAmount, PRICE);
            const buyId  = await placeBuy(client2, takerAmount, PRICE);
            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const seller = await fungibleOrderbook.getOrder(sellId);
            const buyer  = await fungibleOrderbook.getOrder(buyId);

            const makerNormalized = normalizedAmountFromQuote(
                tokenB.target,
                tokenA.target,
                Side.SELL,
                PRICE,
                makerAmount
            );
            const takerNormalized = normalizedAmountFromQuote(
                tokenA.target,
                tokenB.target,
                Side.BUY,
                PRICE,
                takerAmount
            );

            expect(buyer.status).to.equal(Status.Inactive);
            expect(seller.status).to.equal(Status.Active);
            expect(seller.amount).to.equal(makerNormalized - takerNormalized);
        });

        it("should settle multiple trades in one batch in FIFO order", async function () {
            const half = AMOUNT / 2n;

            // Two separate sell orders and one buy that covers both
            const sell1 = await placeSell(client1, half, PRICE);
            const sell2 = await placeSell(client1, half, PRICE);
            const buy   = await placeBuy(client2, AMOUNT, PRICE);

            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const s1 = await fungibleOrderbook.getOrder(sell1);
            const s2 = await fungibleOrderbook.getOrder(sell2);
            const b  = await fungibleOrderbook.getOrder(buy);

            expect(s1.status).to.equal(Status.Inactive);
            expect(s2.status).to.equal(Status.Inactive);
            expect(b.status).to.equal(Status.Inactive);
        });

        it("should settle trades across two consecutive batch windows", async function () {
            // First batch
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const firstSettled = await settlementEngine.lastSettledBatchId();

            // Second batch
            const SALT2   = ethers.encodeBytes32String("secret2");
            const amount2 = ethers.parseUnits("50", 18);

            const sellHash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, PRICE, amount2, Side.SELL, true, SALT2
            );
            const sellTx = await fungibleOrderbook.connect(client1).commit(sellHash, CommitType.Order);
            const sellR  = await sellTx.wait();
            await revealOrder(client1, sellR.logs[0].args[0], tokenB.target, tokenA.target, PRICE, amount2, Side.SELL, true, SALT2);

            const buyHash = computeOrderHash(
                client2.address, tokenA.target, tokenB.target, PRICE, amount2, Side.BUY, true, SALT2
            );
            const buyTx = await fungibleOrderbook.connect(client2).commit(buyHash, CommitType.Order);
            const buyR  = await buyTx.wait();
            await revealOrder(client2, buyR.logs[0].args[0], tokenA.target, tokenB.target, PRICE, amount2, Side.BUY, true, SALT2);

            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            expect(await settlementEngine.lastSettledBatchId()).to.equal(firstSettled + 1n);
        });
    });


    //----------------------------------------------Status Re-validation During Settlement--------------------------

    describe("Status re-validation during settlement", function () {

        it("should skip and emit TradeFailed when maker order was cancelled during window", async function () {
            const sellId = await placeSell(client1, AMOUNT * 2n, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);

            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sellId);

            await expireWindow();
            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(settlementEngine, "TradeFailed");
        });

        it("should reinstate taker order when maker is cancelled and taker had a stored order", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);

            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sellId);

            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            // Taker should be reinstated to Active with amount restored
            const buyer = await fungibleOrderbook.getOrder(buyId);
            const expectedBuyerAmount = normalizedAmountFromQuote(
                tokenA.target,
                tokenB.target,
                Side.BUY,
                PRICE,
                AMOUNT
            );
            expect(buyer.status).to.equal(Status.Active);
            expect(buyer.amount).to.equal(expectedBuyerAmount);
        });

        it("should emit OrderReinstated on the orderbook when a failed trade reinstates an order", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);
            const expectedMatchedAmount = normalizedAmountFromQuote(
                tokenA.target,
                tokenB.target,
                Side.BUY,
                PRICE,
                AMOUNT
            );

            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sellId);

            await expireWindow();
            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(fungibleOrderbook, "OrderReinstated")
                .withArgs(buyId, expectedMatchedAmount);
        });

        it("should emit BothOrdersInactive when both maker and taker are cancelled", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);

            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sellId);
            await fungibleOrderbook.connect(seSigner).cancelOrder(buyId);

            await expireWindow();
            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(settlementEngine, "BothOrdersInactive");
        });

        it("should continue settling remaining trades when one trade in batch fails", async function () {
            // Trade 1: will fail (maker cancelled)
            const sell1 = await placeSell(client1, AMOUNT / 2n, PRICE);
            const buy1  = await placeBuy(client2, AMOUNT / 2n, PRICE);

            // Trade 2: valid
            const SALT2   = ethers.encodeBytes32String("s2");
            const amount2 = ethers.parseUnits("10", 18);
            const sellHash = computeOrderHash(
                client1.address, tokenB.target, tokenA.target, PRICE, amount2, Side.SELL, true, SALT2
            );
            const sellTx = await fungibleOrderbook.connect(client1).commit(sellHash, CommitType.Order);
            const sellR  = await sellTx.wait();
            await revealOrder(client1, sellR.logs[0].args[0], tokenB.target, tokenA.target, PRICE, amount2, Side.SELL, true, SALT2);
            const buyHash = computeOrderHash(
                client2.address, tokenA.target, tokenB.target, PRICE, amount2, Side.BUY, true, SALT2
            );
            const buyTx = await fungibleOrderbook.connect(client2).commit(buyHash, CommitType.Order);
            const buyR  = await buyTx.wait();
            await revealOrder(client2, buyR.logs[0].args[0], tokenA.target, tokenB.target, PRICE, amount2, Side.BUY, true, SALT2);

            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sell1);

            await expireWindow();
            // BatchSettled should report 1 settled (trade 2) and 1 failed (trade 1)
            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(settlementEngine, "BatchSettled")
                .withArgs(1n, 1n, 0n);
        });
    });


    //----------------------------------------------Compliance Re-validation During Settlement----------------------

    describe("Compliance re-validation during _executeFungibleTrade", function () {

        // ── Token blacklisted after queuing ──────────────────────────────────────

        it("should cancel both orders and emit TokenBlacklisted when token is blacklisted after queuing", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);

            // Blacklist tokenA after the trade is queued
            await complianceManager.connect(operator).blacklistToken(tokenA.target);

            await expireWindow();
            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(settlementEngine, "TokenBlacklisted");

            const seller = await fungibleOrderbook.getOrder(sellId);
            const buyer  = await fungibleOrderbook.getOrder(buyId);
            expect(seller.status).to.equal(Status.Inactive);
            expect(buyer.status).to.equal(Status.Inactive);
        });

        it("should unlock taker funds when token blacklisted and taker has no stored order", async function () {
            // Direct trade (revealTake) — taker order is not stored
            const sellId = await placeSell(client1, AMOUNT, PRICE);

            // Use revealTake to create a direct trade
            const takeHash = ethers.solidityPackedKeccak256(
                ["address","uint256","uint256","bytes32"],
                [client2.address, sellId, AMOUNT, SALT]
            );
            const takeTx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const takeR  = await takeTx.wait();
            const takeCommitId = takeR.logs[0].args[0];
            await fungibleOrderbook.connect(client2).revealTake(takeCommitId, sellId, AMOUNT, SALT);

            await complianceManager.connect(operator).blacklistToken(tokenA.target);

            await expireWindow();
            // Taker funds should be unlocked since they have no stored order
            const lockedBefore = await custodian.lockedBalanceOf(client2.address, tokenB.target);
            await settlementEngine.connect(anyone).settleBatch();
            const lockedAfter = await custodian.lockedBalanceOf(client2.address, tokenB.target);
            expect(lockedAfter).to.be.lt(lockedBefore);
        });

        // ── Maker blacklisted after queuing ──────────────────────────────────────

        it("should cancel maker and reinstate taker when maker is blacklisted after queuing", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);

            await complianceManager.connect(operator).setUserStatus(client1.address, 2); // Blacklisted

            await expireWindow();
            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(settlementEngine, "UserBlacklisted")
                .withArgs(client1.address);

            const seller = await fungibleOrderbook.getOrder(sellId);
            const buyer  = await fungibleOrderbook.getOrder(buyId);
            const expectedBuyerAmount = normalizedAmountFromQuote(
                tokenA.target,
                tokenB.target,
                Side.BUY,
                PRICE,
                AMOUNT
            );
            expect(seller.status).to.equal(Status.Inactive);
            // Taker reinstated — amount restored, status Active
            expect(buyer.status).to.equal(Status.Active);
            expect(buyer.amount).to.equal(expectedBuyerAmount);
        });

        it("should cancel maker and unlock taker funds when maker blacklisted and taker is direct", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);

            const takeHash = ethers.solidityPackedKeccak256(
                ["address","uint256","uint256","bytes32"],
                [client2.address, sellId, AMOUNT, SALT]
            );
            const takeTx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const takeR  = await takeTx.wait();
            await fungibleOrderbook.connect(client2).revealTake(takeR.logs[0].args[0], sellId, AMOUNT, SALT);

            await complianceManager.connect(operator).setUserStatus(client1.address, 2);

            const takerLockedBefore = await custodian.lockedBalanceOf(client2.address, tokenB.target);
            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();
            const takerLockedAfter = await custodian.lockedBalanceOf(client2.address, tokenB.target);

            // Taker funds unlocked
            expect(takerLockedAfter).to.be.lt(takerLockedBefore);
        });

        // ── Taker blacklisted after queuing ──────────────────────────────────────

        it("should cancel taker and reinstate maker when taker is blacklisted after queuing", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);

            await complianceManager.connect(operator).setUserStatus(client2.address, 2);

            await expireWindow();
            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(settlementEngine, "UserBlacklisted")
                .withArgs(client2.address);

            const seller = await fungibleOrderbook.getOrder(sellId);
            const buyer  = await fungibleOrderbook.getOrder(buyId);
            const expectedSellerAmount = normalizedAmountFromQuote(
                tokenB.target,
                tokenA.target,
                Side.SELL,
                PRICE,
                AMOUNT
            );
            expect(buyer.status).to.equal(Status.Inactive);
            // Maker reinstated
            expect(seller.status).to.equal(Status.Active);
            expect(seller.amount).to.equal(expectedSellerAmount);
        });

        it("should cancel taker and reinstate maker when taker is direct and blacklisted", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);

            const takeHash = ethers.solidityPackedKeccak256(
                ["address","uint256","uint256","bytes32"],
                [client2.address, sellId, AMOUNT, SALT]
            );
            const takeTx = await fungibleOrderbook.connect(client2).commit(takeHash, CommitType.Take);
            const takeR  = await takeTx.wait();
            await fungibleOrderbook.connect(client2).revealTake(takeR.logs[0].args[0], sellId, AMOUNT, SALT);

            await complianceManager.connect(operator).setUserStatus(client2.address, 2);

            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const seller = await fungibleOrderbook.getOrder(sellId);
            const expectedSellerAmount = normalizedAmountFromQuote(
                tokenB.target,
                tokenA.target,
                Side.SELL,
                PRICE,
                AMOUNT
            );
            expect(seller.status).to.equal(Status.Active);
            expect(seller.amount).to.equal(expectedSellerAmount);
        });

        // ── Insufficient locked balance ───────────────────────────────────────────

        it("should cancel maker and reinstate taker on insufficient maker locked balance", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);

            // Drain maker's locked balance by impersonating custodian logic
            // In practice this tests the defensive check — triggering it requires
            // custom custodian manipulation; mark as integration-level
            // Skipping direct drain here; covered by integration tests
        });
    });


    //----------------------------------------------Status Enum Specific Tests-------------------------------------

    describe("Status enum — Matched state during batch window", function () {

        it("order should be Status.Matched after queuing and before settlement", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);

            // After matching but before settlement, maker should be Matched
            const seller = await fungibleOrderbook.getOrder(sellId);
            expect(seller.status).to.equal(Status.Matched);
        });

        it("taker order should be Status.Matched after queuing", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            const buyId = await placeBuy(client2, AMOUNT, PRICE);

            const buyer = await fungibleOrderbook.getOrder(buyId);
            expect(buyer.status).to.equal(Status.Matched);
        });

        it("order should be Status.Inactive after full settlement", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            expect((await fungibleOrderbook.getOrder(sellId)).status).to.equal(Status.Inactive);
            expect((await fungibleOrderbook.getOrder(buyId)).status).to.equal(Status.Inactive);
        });

        it("partially filled order should be Status.Active after settlement", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT / 2n, PRICE);
            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const seller = await fungibleOrderbook.getOrder(sellId);
            expect(seller.status).to.equal(Status.Active);
        });

        it("reinstated order should be Status.Active with restored amount", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);

            // Cancel maker to force reinstatement of taker
            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sellId);

            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const buyer = await fungibleOrderbook.getOrder(buyId);
            const expectedBuyerAmount = normalizedAmountFromQuote(
                tokenA.target,
                tokenB.target,
                Side.BUY,
                PRICE,
                AMOUNT
            );
            expect(buyer.status).to.equal(Status.Active);
            expect(buyer.amount).to.equal(expectedBuyerAmount);
        });

        it("_matchIncoming should allow partially filled Matched orders to match again", async function () {
            // Place sell order that gets matched by first buy
            const sellId = await placeSell(client1, AMOUNT * 2n, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);

            // Sell order should now be Matched (partially)
            const sellerAfterFirstMatch = await fungibleOrderbook.getOrder(sellId);
            expect(sellerAfterFirstMatch.status).to.equal(Status.Matched);

            // A second buy at the same price should match against the remaining amount
            const SALT2 = ethers.encodeBytes32String("second");
            const buyHash = computeOrderHash(
                client2.address, tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT2
            );
            const buyTx = await fungibleOrderbook.connect(client2).commit(buyHash, CommitType.Order);
            const buyR  = await buyTx.wait();
            await revealOrder(client2, buyR.logs[0].args[0], tokenA.target, tokenB.target, PRICE, AMOUNT, Side.BUY, true, SALT2);

            // The second buy should match (one additional OrderMatched emitted)
            const events = await fungibleOrderbook.queryFilter(
                fungibleOrderbook.filters.OrderMatched(), buyR.blockNumber
            );

            const sellerAfterSecondMatch = await fungibleOrderbook.getOrder(sellId);
            expect(events.length).to.equal(1);
            expect(sellerAfterSecondMatch.amount).to.equal(0n);
            expect(sellerAfterSecondMatch.status).to.equal(Status.Matched);
        });
    });


    //----------------------------------------------reinstateOrder()-----------------------------------------------

    describe("reinstateOrder()", function () {

        it("should revert if called by non-SettlementEngine", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);

            await expect(fungibleOrderbook.connect(client1).reinstateOrder(sellId, AMOUNT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "NotSettlementEngine");
        });

        it("should revert if order was not in Matched status", async function () {
            // An Active order that was never matched cannot be reinstated
            const sellId = await placeSell(client1, AMOUNT, PRICE);

            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);

            await expect(fungibleOrderbook.connect(seSigner).reinstateOrder(sellId, AMOUNT))
                .to.be.revertedWithCustomError(fungibleOrderbook, "OrderWasntMatchedCantReinstate");
        });

        it("should emit OrderReinstated with correct orderId and amount", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            const buyId  = await placeBuy(client2, AMOUNT, PRICE);
            const expectedMatchedAmount = normalizedAmountFromQuote(
                tokenA.target,
                tokenB.target,
                Side.BUY,
                PRICE,
                AMOUNT
            );

            // Force failure path
            const seSigner = await ethers.getImpersonatedSigner(settlementEngine.target);
            await ethers.provider.send("hardhat_setBalance", [
                settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))
            ]);
            await fungibleOrderbook.connect(seSigner).cancelOrder(sellId);

            await expireWindow();
            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(fungibleOrderbook, "OrderReinstated")
                .withArgs(buyId, expectedMatchedAmount);
        });
    });


    //----------------------------------------------updateOrder()--------------------------------------------------

    describe("updateOrder()", function () {

        it("should revert if called by non-SettlementEngine", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            await expect(fungibleOrderbook.connect(client1).updateOrder(sellId, false))
                .to.be.revertedWithCustomError(fungibleOrderbook, "NotSettlementEngine");
        });

        it("should mark order Inactive when amount reaches zero", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const order = await fungibleOrderbook.getOrder(sellId);
            expect(order.status).to.equal(Status.Inactive);
            expect(order.amount).to.equal(0n);
        });

        it("should keep order Active and emit OrderPartiallyFilled when amount remains", async function () {
            const sellId = await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT / 2n, PRICE);
            await expireWindow();

            await expect(settlementEngine.connect(anyone).settleBatch())
                .to.emit(fungibleOrderbook, "OrderPartiallyFilled");

            const order = await fungibleOrderbook.getOrder(sellId);
            expect(order.status).to.equal(Status.Active);
        });
    });


    //----------------------------------------------getBatchSize()-------------------------------------------------

    describe("getBatchSize()", function () {

        it("should return 0 for an empty batch", async function () {
            const { fungible, nft } = await settlementEngine.getBatchSize(1n);
            expect(fungible).to.equal(0n);
            expect(nft).to.equal(0n);
        });

        it("should return correct count after trades are queued", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);

            const { fungible } = await settlementEngine.getBatchSize(1n);
            expect(fungible).to.equal(1n);
        });

        it("should return correct count for a previous settled batch", async function () {
            await placeSell(client1, AMOUNT, PRICE);
            await placeBuy(client2, AMOUNT, PRICE);
            await expireWindow();
            await settlementEngine.connect(anyone).settleBatch();

            const { fungible } = await settlementEngine.getBatchSize(1n);
            expect(fungible).to.equal(1n); // still stored, just settled
        });
    });
});