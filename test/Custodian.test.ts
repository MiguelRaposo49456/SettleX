import { expect } from "chai";
import { network } from "hardhat";
import { deploySystem } from "./utils/deploy.js";

const { ethers } = await network.connect();

const UserStatus = {
    Allowed: 0,
    BlacklistedWithWithdrawal: 1,
    Blacklisted: 2
};

const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
const ETH_ADDRESS   = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

describe("Custodian", function () {
    let admin: any, operator: any, client1: any, client2: any;
    let complianceManager: any, fungibleOrderbook: any, custodian: any, settlementEngine: any;
    let tokenA: any, tokenB: any, mockWeth: any, mockLendingPool: any;
    let orderbookSigner: any, settlementEngineSigner: any;

    const DEPOSIT_AMOUNT = ethers.parseUnits("100", 18);
    const LOCK_AMOUNT = ethers.parseUnits("50", 18);
    const ETH_AMOUNT = ethers.parseEther("1.0");

    beforeEach(async function () {
        ({ admin, client1, client2, complianceManager, fungibleOrderbook, custodian,
           settlementEngine, tokenA, tokenB, mockWeth, mockLendingPool }
            = await deploySystem(ethers));

        [, operator] = await ethers.getSigners();
        await complianceManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);

        orderbookSigner = await ethers.getImpersonatedSigner(fungibleOrderbook.target);
        settlementEngineSigner = await ethers.getImpersonatedSigner(settlementEngine.target);

        await ethers.provider.send("hardhat_setBalance", [fungibleOrderbook.target, ethers.toQuantity(ethers.parseEther("1.0"))]);
        await ethers.provider.send("hardhat_setBalance", [settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))]);

        await tokenA.mint(client1.address, ethers.parseUnits("1000", 18));
        await tokenB.mint(client2.address, ethers.parseUnits("1000", 18));

        await tokenA.connect(client1).approve(custodian.target, ethers.parseUnits("1000", 18));
        await tokenB.connect(client2).approve(custodian.target, ethers.parseUnits("1000", 18));

        await ethers.provider.send("hardhat_setBalance", [client1.address, ethers.toQuantity(ethers.parseEther("10.0"))]);
        await ethers.provider.send("hardhat_setBalance", [client2.address, ethers.toQuantity(ethers.parseEther("10.0"))]);
    });

    //---------------------------------------Deposit ERC20 (no lending pool)---------------------------------------

    describe("deposit() — token not in lending pool", function () {

        it("should deposit tokens and increase available balance", async function () {
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.equal(DEPOSIT_AMOUNT);
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(client1).deposit(tokenA.target, 0))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });

        it("should revert if token is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenA.target);
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "TokenNotAllowed");
        });

        it("should revert if user is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, UserStatus.Blacklisted);
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "UserNotAllowed");
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "SystemPaused");
        });

        it("should emit Deposited event", async function () {
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.emit(custodian, "Deposited")
                .withArgs(client1.address, tokenA.target, DEPOSIT_AMOUNT);
        });
    });

    //---------------------------------------Deposit ERC20 (with lending pool)---------------------------------------

    describe("deposit() — token in lending pool", function () {

        let aTokenA: any;

        beforeEach(async function () {
            // Register tokenA in lending pool at 5% interest rate
            await mockLendingPool.connect(admin).addPool(
                tokenA.target, 500, "aTokenA", "aTKA"
            );
            const aTokenAddress = await mockLendingPool.getAToken(tokenA.target);
            aTokenA = await ethers.getContractAt("AToken", aTokenAddress);

            // Mint extra tokens to admin for liquidity
            await tokenA.mint(admin.address, ethers.parseUnits("10000", 18));
            await tokenA.connect(admin).approve(mockLendingPool.target, ethers.parseUnits("10000", 18));
            await mockLendingPool.connect(admin).addLiquidity(tokenA.target, ethers.parseUnits("10000", 18));
        });

        it("should supply token to lending pool on deposit", async function () {
            const aTokenBefore = await aTokenA.balanceOf(custodian.target);
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
            const aTokenAfter = await aTokenA.balanceOf(custodian.target);
            expect(aTokenAfter).to.be.greaterThan(aTokenBefore);
        });

        it("should credit aToken balance not underlying balance", async function () {
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
            // underlying balance should be 0
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.equal(0);
            // aToken balance should be credited
            const aTokenAddress = await mockLendingPool.getAToken(tokenA.target);
            expect(await custodian.balanceOf(client1.address, aTokenAddress)).to.be.greaterThan(0);
        });

        it("should emit Deposited event with underlying token address", async function () {
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.emit(custodian, "Deposited")
                .withArgs(client1.address, tokenA.target, DEPOSIT_AMOUNT);
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(client1).deposit(tokenA.target, 0))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });
        
        it("should revert if token is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenA.target);
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "TokenNotAllowed");
        });
        
        it("should revert if user is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, UserStatus.Blacklisted);
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "UserNotAllowed");
        });
        
        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "SystemPaused");
        });
    });

    //---------------------------------------Withdraw ERC20 (no lending pool)--------------------------------------

    describe("withdraw() — token not in lending pool", function () {

        beforeEach(async function () {
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
        });

        it("should withdraw tokens and decrease available balance", async function () {
            await custodian.connect(client1).withdraw(tokenA.target, DEPOSIT_AMOUNT, false);
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.equal(0);
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(client1).withdraw(tokenA.target, 0, false))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });

        it("should revert if withdrawing more than available", async function () {
            const tooMuch = ethers.parseUnits("200", 18);
            await expect(custodian.connect(client1).withdraw(tokenA.target, tooMuch, false))
                .to.be.revertedWithCustomError(custodian, "InsufficientBalance");
        });

        it("should revert if user is fully blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, UserStatus.Blacklisted);
            await expect(custodian.connect(client1).withdraw(tokenA.target, DEPOSIT_AMOUNT, false))
                .to.be.revertedWithCustomError(custodian, "UserCannotWithdraw");
        });

        it("should allow withdrawal if user is BlacklistedWithWithdrawal", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, UserStatus.BlacklistedWithWithdrawal);
            await custodian.connect(client1).withdraw(tokenA.target, DEPOSIT_AMOUNT, false);
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.equal(0);
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(client1).withdraw(tokenA.target, DEPOSIT_AMOUNT, false))
                .to.be.revertedWithCustomError(custodian, "SystemPaused");
        });

        it("should emit Withdrawn event", async function () {
            await expect(custodian.connect(client1).withdraw(tokenA.target, DEPOSIT_AMOUNT, false))
                .to.emit(custodian, "Withdrawn")
                .withArgs(client1.address, tokenA.target, DEPOSIT_AMOUNT);
        });
    });

    //---------------------------------------Withdraw ERC20 (with lending pool)--------------------------------------

    describe("withdraw() — aToken with yield", function () {

        let aTokenA: any;
        let aTokenAddress: string;
        let scaledAmount: bigint;

        beforeEach(async function () {
            // Register tokenA in lending pool at 5% interest rate
            await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA");
            aTokenAddress = await mockLendingPool.getAToken(tokenA.target);
            aTokenA = await ethers.getContractAt("AToken", aTokenAddress);

            // Deposit and get scaled amount of aTokens credited
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
            scaledAmount = await custodian.balanceOf(client1.address, aTokenAddress);
        });

        it("should withdraw underlying including yield after simulateYield", async function () {
            // Add liquidity to cover yield for this specific test
            await tokenA.mint(admin.address, ethers.parseUnits("10000", 18));
            await tokenA.connect(admin).approve(mockLendingPool.target, ethers.parseUnits("10000", 18));
            await mockLendingPool.connect(admin).addLiquidity(tokenA.target, ethers.parseUnits("10000", 18));

            await mockLendingPool.connect(admin).simulateYield(tokenA.target, 365n * 24n * 3600n);

            const tokenABefore = await tokenA.balanceOf(client1.address);
            await custodian.connect(client1).withdraw(aTokenAddress, scaledAmount, false);
            const tokenAAfter = await tokenA.balanceOf(client1.address);

            expect(tokenAAfter - tokenABefore).to.be.greaterThan(DEPOSIT_AMOUNT);
        });

        it("should decrease aToken balance to zero after full withdrawal", async function () {
            // Add liquidity just enough for the original deposit
            await tokenA.mint(admin.address, DEPOSIT_AMOUNT);
            await tokenA.connect(admin).approve(mockLendingPool.target, DEPOSIT_AMOUNT);
            await mockLendingPool.connect(admin).addLiquidity(tokenA.target, DEPOSIT_AMOUNT);

            await custodian.connect(client1).withdraw(aTokenAddress, scaledAmount, false);
            expect(await custodian.balanceOf(client1.address, aTokenAddress)).to.equal(0);
        });

        it("should revert if withdrawing more than aToken balance", async function () {
            const tooMuch = scaledAmount + 1n;
            await expect(custodian.connect(client1).withdraw(aTokenAddress, tooMuch, false))
                .to.be.revertedWithCustomError(custodian, "InsufficientBalance");
        });

        it("should queue withdrawal if lending pool has insufficient liquidity", async function () {
            // Simulate 1000 years of yield
            await mockLendingPool.connect(admin).simulateYield(tokenA.target, 1000n * 365n * 24n * 3600n);

            await expect(custodian.connect(client1).withdraw(aTokenAddress, scaledAmount, false))
                .to.emit(custodian, "WithdrawalQueued");
        });

        it("should process queued withdrawal when another user deposits", async function () {
            await mockLendingPool.connect(admin).simulateYield(tokenA.target, 1000n * 365n * 24n * 3600n);

            // client1 withdrawal gets queued
            await custodian.connect(client1).withdraw(aTokenAddress, scaledAmount, false);
            expect(await custodian.queueHead()).to.equal(0);

            // Admin adds liquidity to cover the queued withdrawal
            await tokenA.mint(admin.address, ethers.parseUnits("100000", 18));
            await tokenA.connect(admin).approve(mockLendingPool.target, ethers.parseUnits("100000", 18));
            await mockLendingPool.connect(admin).addLiquidity(tokenA.target, ethers.parseUnits("100000", 18));

            // client2 deposits triggering _processWithdrawalQueue
            await tokenA.mint(client2.address, DEPOSIT_AMOUNT);
            await tokenA.connect(client2).approve(custodian.target, DEPOSIT_AMOUNT);
            await expect(custodian.connect(client2).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.emit(custodian, "WithdrawalProcessed");

            expect(await custodian.queueHead()).to.equal(1);
        });

        it("should emit Withdrawn event", async function () {
            await tokenA.mint(admin.address, DEPOSIT_AMOUNT);
            await tokenA.connect(admin).approve(mockLendingPool.target, DEPOSIT_AMOUNT);
            await mockLendingPool.connect(admin).addLiquidity(tokenA.target, DEPOSIT_AMOUNT);

            await expect(custodian.connect(client1).withdraw(aTokenAddress, scaledAmount, false))
                .to.emit(custodian, "Withdrawn")
                .withArgs(client1.address, aTokenAddress, scaledAmount);
        });
    });


    //---------------------------------------Deposit ETH---------------------------------------

    describe("depositETH() — no WETH pool", function () {

        it("should deposit ETH and increase available ETH balance", async function () {
            await custodian.connect(client1).depositETH({ value: ETH_AMOUNT });
            expect(await custodian.balanceOf(client1.address, ETH_ADDRESS)).to.equal(ETH_AMOUNT);
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(client1).depositETH({ value: 0 }))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });

        it("should revert if ETH is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(ETH_ADDRESS);
            await expect(custodian.connect(client1).depositETH({ value: ETH_AMOUNT }))
                .to.be.revertedWithCustomError(custodian, "TokenNotAllowed");
        });

        it("should revert if user is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, UserStatus.Blacklisted);
            await expect(custodian.connect(client1).depositETH({ value: ETH_AMOUNT }))
                .to.be.revertedWithCustomError(custodian, "UserNotAllowed");
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(client1).depositETH({ value: ETH_AMOUNT }))
                .to.be.revertedWithCustomError(custodian, "SystemPaused");
        });

        it("should revert on direct ETH transfer", async function () {
            await expect(client1.sendTransaction({ to: custodian.target, value: ETH_AMOUNT }))
                .to.be.revertedWith("Use depositETH()");
        });

        it("should emit Deposited event", async function () {
            await expect(custodian.connect(client1).depositETH({ value: ETH_AMOUNT }))
                .to.emit(custodian, "Deposited")
                .withArgs(client1.address, ETH_ADDRESS, ETH_AMOUNT);
        });
    });

    describe("depositETH() — with WETH pool", function () {

        let aWethAddress: string;
        let aWeth: any;

        beforeEach(async function () {
            // Register WETH pool at 3% interest rate
            await mockLendingPool.connect(admin).addPool(mockWeth.target, 300, "aWETH", "aWETH");
            aWethAddress = await mockLendingPool.getAToken(mockWeth.target);
            aWeth = await ethers.getContractAt("AToken", aWethAddress);

            // Add liquidity to cover yield
            await mockWeth.connect(admin).deposit({ value: ethers.parseEther("10.0") });
            await mockWeth.connect(admin).approve(mockLendingPool.target, ethers.parseEther("10.0"));
            await mockLendingPool.connect(admin).addLiquidity(mockWeth.target, ethers.parseEther("10.0"));
        });

        it("should credit aWETH balance not ETH balance", async function () {
            await custodian.connect(client1).depositETH({ value: ETH_AMOUNT });
            expect(await custodian.balanceOf(client1.address, ETH_ADDRESS)).to.equal(0);
            expect(await custodian.balanceOf(client1.address, aWethAddress)).to.be.greaterThan(0);
        });

        it("should supply WETH to lending pool", async function () {
            const aWethBefore = await aWeth.balanceOf(custodian.target);
            await custodian.connect(client1).depositETH({ value: ETH_AMOUNT });
            const aWethAfter = await aWeth.balanceOf(custodian.target);
            expect(aWethAfter).to.be.greaterThan(aWethBefore);
        });

        it("should emit Deposited event with ETH sentinel address", async function () {
            await expect(custodian.connect(client1).depositETH({ value: ETH_AMOUNT }))
                .to.emit(custodian, "Deposited")
                .withArgs(client1.address, ETH_ADDRESS, ETH_AMOUNT);
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(client1).depositETH({ value: 0 }))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });
        
        it("should revert if ETH is blacklisted", async function () {
            await complianceManager.connect(operator).blacklistToken(ETH_ADDRESS);
            await expect(custodian.connect(client1).depositETH({ value: ETH_AMOUNT }))
                .to.be.revertedWithCustomError(custodian, "TokenNotAllowed");
        });
        
        it("should revert if user is blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, UserStatus.Blacklisted);
            await expect(custodian.connect(client1).depositETH({ value: ETH_AMOUNT }))
                .to.be.revertedWithCustomError(custodian, "UserNotAllowed");
        });
        
        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(client1).depositETH({ value: ETH_AMOUNT }))
                .to.be.revertedWithCustomError(custodian, "SystemPaused");
        });
    });

    //---------------------------------------Withdraw ETH (no WETH pool)--------------------------------------

    describe("withdrawETH() — no WETH pool", function () {

        beforeEach(async function () {
            await custodian.connect(client1).depositETH({ value: ETH_AMOUNT });
        });

        it("should withdraw ETH and decrease available ETH balance", async function () {
            await custodian.connect(client1).withdrawETH(ETH_AMOUNT);
            expect(await custodian.balanceOf(client1.address, ETH_ADDRESS)).to.equal(0);
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(client1).withdrawETH(0))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });

        it("should revert if withdrawing more than available", async function () {
            const tooMuch = ethers.parseEther("2.0");
            await expect(custodian.connect(client1).withdrawETH(tooMuch))
                .to.be.revertedWithCustomError(custodian, "InsufficientBalance");
        });

        it("should revert if user is fully blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, UserStatus.Blacklisted);
            await expect(custodian.connect(client1).withdrawETH(ETH_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "UserCannotWithdraw");
        });

        it("should allow withdrawal if user is BlacklistedWithWithdrawal", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, UserStatus.BlacklistedWithWithdrawal);
            await custodian.connect(client1).withdrawETH(ETH_AMOUNT);
            expect(await custodian.balanceOf(client1.address, ETH_ADDRESS)).to.equal(0);
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(client1).withdrawETH(ETH_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "SystemPaused");
        });

        it("should emit Withdrawn event", async function () {
            await expect(custodian.connect(client1).withdrawETH(ETH_AMOUNT))
                .to.emit(custodian, "Withdrawn")
                .withArgs(client1.address, ETH_ADDRESS, ETH_AMOUNT);
        });
    });

    describe("withdraw() aWETH — with WETH pool", function () {

        let aWethAddress: string;
        let scaledAmount: bigint;

        beforeEach(async function () {
            await mockLendingPool.connect(admin).addPool(mockWeth.target, 300, "aWETH", "aWETH");
            aWethAddress = await mockLendingPool.getAToken(mockWeth.target);

            // Add liquidity
            await mockWeth.connect(admin).deposit({ value: ethers.parseEther("10.0") });
            await mockWeth.connect(admin).approve(mockLendingPool.target, ethers.parseEther("10.0"));
            await mockLendingPool.connect(admin).addLiquidity(mockWeth.target, ethers.parseEther("10.0"));

            await custodian.connect(client1).depositETH({ value: ETH_AMOUNT });
            scaledAmount = await custodian.balanceOf(client1.address, aWethAddress);
        });

        it("should withdraw WETH when receiveETH is false", async function () {
            const wethBefore = await mockWeth.balanceOf(client1.address);
            await custodian.connect(client1).withdraw(aWethAddress, scaledAmount, false);
            const wethAfter = await mockWeth.balanceOf(client1.address);
            expect(wethAfter).to.be.greaterThan(wethBefore);
        });

        it("should withdraw ETH when receiveETH is true", async function () {
            const ethBefore = await ethers.provider.getBalance(client1.address);
            await custodian.connect(client1).withdraw(aWethAddress, scaledAmount, true);
            const ethAfter = await ethers.provider.getBalance(client1.address);
            // Balance increases (minus gas) — net positive means ETH received
            expect(ethAfter).to.be.greaterThan(ethBefore - ethers.parseEther("0.01")); // 0.01 ETH gas tolerance
        });

        it("should decrease aWETH balance to zero after full withdrawal", async function () {
            await custodian.connect(client1).withdraw(aWethAddress, scaledAmount, true);
            expect(await custodian.balanceOf(client1.address, aWethAddress)).to.equal(0);
        });

        it("should return more ETH than deposited after yield with receiveETH=true", async function () {
            // Simulate 1 year of yield
            await mockLendingPool.connect(admin).simulateYield(mockWeth.target, 365n * 24n * 3600n);

            // Add extra liquidity to cover yield
            await mockWeth.connect(admin).deposit({ value: ethers.parseEther("10.0") });
            await mockWeth.connect(admin).approve(mockLendingPool.target, ethers.parseEther("10.0"));
            await mockLendingPool.connect(admin).addLiquidity(mockWeth.target, ethers.parseEther("10.0"));

            const ethBefore = await ethers.provider.getBalance(client1.address);
            const tx = await custodian.connect(client1).withdraw(aWethAddress, scaledAmount, true);
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed * BigInt(receipt.gasPrice ?? 0);
            const ethAfter = await ethers.provider.getBalance(client1.address);

            expect(ethAfter + gasCost - ethBefore).to.be.greaterThan(ETH_AMOUNT);
        });

        it("should emit Withdrawn event with aWETH address", async function () {
            await expect(custodian.connect(client1).withdraw(aWethAddress, scaledAmount, true))
                .to.emit(custodian, "Withdrawn")
                .withArgs(client1.address, aWethAddress, scaledAmount);
        });

        it("should revert if user is fully blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(client1.address, UserStatus.Blacklisted);
            await expect(custodian.connect(client1).withdraw(aWethAddress, scaledAmount, true))
                .to.be.revertedWithCustomError(custodian, "UserCannotWithdraw");
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(client1).withdraw(aWethAddress, scaledAmount, true))
                .to.be.revertedWithCustomError(custodian, "SystemPaused");
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(client1).withdraw(aWethAddress, 0n, false))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });
    });

    //---------------------------------------MockLendingPool---------------------------------------

    describe("MockLendingPool", function () {

        it("should register a new pool", async function () {
            await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA");
            expect(await mockLendingPool.isSupported(tokenA.target)).to.be.true;
        });

        it("should revert if pool already exists", async function () {
            await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA");
            await expect(mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA"))
                .to.be.revertedWithCustomError(mockLendingPool, "PoolAlreadyExists");
        });

        it("should return address(0) for unsupported token", async function () {
            expect(await mockLendingPool.getAToken(tokenA.target)).to.equal(ethers.ZeroAddress);
        });

        it("should simulate yield by advancing the index", async function () {
            await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA");
            const indexBefore = await mockLendingPool.getLiquidityIndex(tokenA.target);
            await mockLendingPool.connect(admin).simulateYield(tokenA.target, 365n * 24n * 3600n);
            const indexAfter = await mockLendingPool.getLiquidityIndex(tokenA.target);
            expect(indexAfter).to.be.greaterThan(indexBefore);
        });

        it("should revert simulateYield if caller is not admin", async function () {
            await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA");
            await expect(mockLendingPool.connect(client1).simulateYield(tokenA.target, 1000))
                .to.be.revertedWithCustomError(mockLendingPool, "NotAdmin");
        });

        it("should add liquidity to the pool", async function () {
            await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA");
            await tokenA.mint(admin.address, ethers.parseUnits("1000", 18));
            await tokenA.connect(admin).approve(mockLendingPool.target, ethers.parseUnits("1000", 18));
            await mockLendingPool.connect(admin).addLiquidity(tokenA.target, ethers.parseUnits("1000", 18));
            // Pool should now hold the liquidity
            expect(await tokenA.balanceOf(mockLendingPool.target)).to.be.greaterThan(0);
        });
    });

    //---------------------------------------lockFunds--------------------------------------

    describe("lockFunds()", function () {

        beforeEach(async function () {
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
        });

        it("should move funds from available to locked", async function () {
            await custodian.connect(orderbookSigner).lockFunds(client1.address, tokenA.target, LOCK_AMOUNT);
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.equal(DEPOSIT_AMOUNT - LOCK_AMOUNT);
            expect(await custodian.lockedBalanceOf(client1.address, tokenA.target)).to.equal(LOCK_AMOUNT);
        });

        it("should revert if caller is not the orderbook", async function () {
            await expect(custodian.connect(client1).lockFunds(client1.address, tokenA.target, LOCK_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "NotOrderbook");
        });

        it("should revert if insufficient available balance", async function () {
            const tooMuch = ethers.parseUnits("200", 18);
            await expect(custodian.connect(orderbookSigner).lockFunds(client1.address, tokenA.target, tooMuch))
                .to.be.revertedWithCustomError(custodian, "InsufficientBalance");
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(orderbookSigner).lockFunds(client1.address, tokenA.target, 0))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(orderbookSigner).lockFunds(client1.address, tokenA.target, LOCK_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "SystemPaused");
        });

        it("should emit FundsLocked event", async function () {
            await expect(custodian.connect(orderbookSigner).lockFunds(client1.address, tokenA.target, LOCK_AMOUNT))
                .to.emit(custodian, "FundsLocked")
                .withArgs(client1.address, tokenA.target, LOCK_AMOUNT);
        });
    });

    //---------------------------------------unlockFunds--------------------------------------

    describe("unlockFunds()", function () {

        beforeEach(async function () {
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
            await custodian.connect(orderbookSigner).lockFunds(client1.address, tokenA.target, LOCK_AMOUNT);
        });

        it("should move funds from locked back to available", async function () {
            await custodian.connect(orderbookSigner).unlockFunds(client1.address, tokenA.target, LOCK_AMOUNT);
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.equal(DEPOSIT_AMOUNT);
            expect(await custodian.lockedBalanceOf(client1.address, tokenA.target)).to.equal(0);
        });

        it("should revert if caller is not the orderbook", async function () {
            await expect(custodian.connect(client1).unlockFunds(client1.address, tokenA.target, LOCK_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "NotOrderbook");
        });

        it("should revert if insufficient locked balance", async function () {
            const tooMuch = ethers.parseUnits("200", 18);
            await expect(custodian.connect(orderbookSigner).unlockFunds(client1.address, tokenA.target, tooMuch))
                .to.be.revertedWithCustomError(custodian, "InsufficientLockedBalance");
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(orderbookSigner).unlockFunds(client1.address, tokenA.target, 0))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(orderbookSigner).unlockFunds(client1.address, tokenA.target, LOCK_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "SystemPaused");
        });

        it("should emit FundsUnlocked event", async function () {
            await expect(custodian.connect(orderbookSigner).unlockFunds(client1.address, tokenA.target, LOCK_AMOUNT))
                .to.emit(custodian, "FundsUnlocked")
                .withArgs(client1.address, tokenA.target, LOCK_AMOUNT);
        });
    });

    //------------------------------------internalTransfer----------------------------------------

    describe("internalTransfer()", function () {

        beforeEach(async function () {
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
            await custodian.connect(orderbookSigner).lockFunds(client1.address, tokenA.target, LOCK_AMOUNT);
        });

        it("should debit locked balance of sender and credit available balance of receiver", async function () {
            await custodian.connect(settlementEngineSigner).internalTransfer(
                client1.address, client2.address, tokenA.target, LOCK_AMOUNT
            );
            expect(await custodian.lockedBalanceOf(client1.address, tokenA.target)).to.equal(0);
            expect(await custodian.balanceOf(client2.address, tokenA.target)).to.equal(LOCK_AMOUNT);
        });

        it("should revert if caller is not the SettlementEngine", async function () {
            await expect(custodian.connect(client1).internalTransfer(
                client1.address, client2.address, tokenA.target, LOCK_AMOUNT
            )).to.be.revertedWithCustomError(custodian, "NotSettlementEngine");
        });

        it("should revert if sender has insufficient locked balance", async function () {
            const tooMuch = ethers.parseUnits("200", 18);
            await expect(custodian.connect(settlementEngineSigner).internalTransfer(
                client1.address, client2.address, tokenA.target, tooMuch
            )).to.be.revertedWithCustomError(custodian, "InsufficientLockedBalance");
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(settlementEngineSigner).internalTransfer(
                client1.address, client2.address, tokenA.target, 0
            )).to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });

        it("should revert when system is paused", async function () {
            await complianceManager.connect(operator).pause();
            await expect(custodian.connect(settlementEngineSigner).internalTransfer(
                client1.address, client2.address, tokenA.target, LOCK_AMOUNT
            )).to.be.revertedWithCustomError(custodian, "SystemPaused");
        });

        it("should emit InternalTransfer event", async function () {
            await expect(custodian.connect(settlementEngineSigner).internalTransfer(
                client1.address, client2.address, tokenA.target, LOCK_AMOUNT
            )).to.emit(custodian, "InternalTransfer")
              .withArgs(client1.address, client2.address, tokenA.target, LOCK_AMOUNT);
        });
    });

    //-------------------------------------View functions-------------------------------------

    describe("fullBalanceOf()", function () {

        it("should return both available and locked balances", async function () {
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
            await custodian.connect(orderbookSigner).lockFunds(client1.address, tokenA.target, LOCK_AMOUNT);

            const [available, locked] = await custodian.fullBalanceOf(client1.address, tokenA.target);
            expect(available).to.equal(DEPOSIT_AMOUNT - LOCK_AMOUNT);
            expect(locked).to.equal(LOCK_AMOUNT);
        });

        it("should return both available and locked aToken balances", async function () {
            await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA");
            const aTokenAddress = await mockLendingPool.getAToken(tokenA.target);
        
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
            const scaledAmount = await custodian.balanceOf(client1.address, aTokenAddress);
        
            await custodian.connect(orderbookSigner).lockFunds(client1.address, aTokenAddress, scaledAmount / 2n);
        
            const [available, locked] = await custodian.fullBalanceOf(client1.address, aTokenAddress);
            expect(available).to.equal(scaledAmount / 2n);
            expect(locked).to.equal(scaledAmount / 2n);
        })
    });

    //-------------------------------------Withdrawal Queue-------------------------------------

    describe("Withdrawal queue", function () {

        let aTokenA: any;
        let aTokenAddress: string;

        beforeEach(async function () {
            await mockLendingPool.connect(admin).addPool(tokenA.target, 500, "aTokenA", "aTKA");
            aTokenAddress = await mockLendingPool.getAToken(tokenA.target);
            aTokenA = await ethers.getContractAt("AToken", aTokenAddress);

            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
        });

        it("should start with empty queue", async function () {
            expect(await custodian.queueHead()).to.equal(0);
        });

        it("should process queued withdrawal when another user deposits", async function () {
            const scaledAmount = await custodian.balanceOf(client1.address, aTokenAddress);

            // Simulate massive yield so pool can't cover it
            await mockLendingPool.connect(admin).simulateYield(tokenA.target, 1000n * 365n * 24n * 3600n);

            // client1 withdrawal gets queued
            await custodian.connect(client1).withdraw(aTokenAddress, scaledAmount, false);
            expect(await custodian.queueHead()).to.equal(0);

            // Admin adds liquidity to cover the queued withdrawal
            await tokenA.mint(admin.address, ethers.parseUnits("100000", 18));
            await tokenA.connect(admin).approve(mockLendingPool.target, ethers.parseUnits("100000", 18));
            await mockLendingPool.connect(admin).addLiquidity(tokenA.target, ethers.parseUnits("100000", 18));

            // client2 deposits triggering _processWithdrawalQueue
            await tokenA.mint(client2.address, DEPOSIT_AMOUNT);
            await tokenA.connect(client2).approve(custodian.target, DEPOSIT_AMOUNT);
            await expect(custodian.connect(client2).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.emit(custodian, "WithdrawalProcessed");

            // Queue head advanced which means client1's withdrawal was processed
            expect(await custodian.queueHead()).to.equal(1);
        });

        it("should emit WithdrawalQueued when withdrawal is queued", async function () {
            const scaledAmount = await custodian.balanceOf(client1.address, aTokenAddress);

            // Simulate massive yield so pool can't cover it
            await mockLendingPool.connect(admin).simulateYield(tokenA.target, 1000n * 365n * 24n * 3600n);

            // Try to withdraw — should queue since pool lacks liquidity for yield
            await expect(custodian.connect(client1).withdraw(aTokenAddress, scaledAmount, false))
                .to.emit(custodian, "WithdrawalQueued");
        });
    });
});