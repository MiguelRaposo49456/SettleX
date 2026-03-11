import { expect } from "chai";
import { network } from "hardhat";
import { deploySystem } from "./utils/deploy.js";

const { ethers } = await network.connect();

const UserStatus = {
    Allowed: 0,
    BlacklistedWithWithdrawal: 1,
    Blacklisted: 2
};

describe("Custodian", function () {
    let admin: any, client1: any, client2: any;
    let complianceManager: any, orderbook: any, custodian: any, settlementEngine: any;
    let tokenA: any, tokenB: any;
    let orderbookSigner: any, settlementEngineSigner: any;

    const DEPOSIT_AMOUNT = ethers.parseUnits("100", 18);
    const LOCK_AMOUNT = ethers.parseUnits("50", 18);

    beforeEach(async function () {
        ({ admin, client1, client2, complianceManager, orderbook, custodian, settlementEngine, tokenA, tokenB } 
            = await deploySystem(ethers));

        // Create the Impersonated Signers for the contracts
        orderbookSigner = await ethers.getImpersonatedSigner(orderbook.target);
        settlementEngineSigner = await ethers.getImpersonatedSigner(settlementEngine.target);

        // Fund impersonated signers with ETH for gas
        await ethers.provider.send("hardhat_setBalance", [orderbook.target, ethers.toQuantity(ethers.parseEther("1.0"))]);
        await ethers.provider.send("hardhat_setBalance", [settlementEngine.target, ethers.toQuantity(ethers.parseEther("1.0"))]);

        // Mint tokens to clients
        await tokenA.mint(client1.address, ethers.parseUnits("1000", 18));
        await tokenB.mint(client2.address, ethers.parseUnits("1000", 18));

        // Approve custodian to spend tokens
        await tokenA.connect(client1).approve(custodian.target, ethers.parseUnits("1000", 18));
        await tokenB.connect(client2).approve(custodian.target, ethers.parseUnits("1000", 18));
    });

    //---------------------------------------Deposit---------------------------------------

    describe("deposit()", function () {

        it("should deposit tokens and increase available balance", async function () {
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.equal(DEPOSIT_AMOUNT);
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(client1).deposit(tokenA.target, 0))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });

        it("should revert if token is blacklisted", async function () {
            await complianceManager.blacklistToken(tokenA.target);
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "TokenNotAllowed");
        });

        it("should revert if user is blacklisted", async function () {
            await complianceManager.blacklistUser(client1.address);
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "UserNotAllowed");
        });

        it("should emit Deposited event", async function () {
            await expect(custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT))
                .to.emit(custodian, "Deposited")
                .withArgs(client1.address, tokenA.target, DEPOSIT_AMOUNT);
        });
    });

    //---------------------------------------Withdraw--------------------------------------

    describe("withdraw()", function () {

        beforeEach(async function () {
            await custodian.connect(client1).deposit(tokenA.target, DEPOSIT_AMOUNT);
        });

        it("should withdraw tokens and decrease available balance", async function () {
            await custodian.connect(client1).withdraw(tokenA.target, DEPOSIT_AMOUNT);
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.equal(0);
        });

        it("should revert on zero amount", async function () {
            await expect(custodian.connect(client1).withdraw(tokenA.target, 0))
                .to.be.revertedWithCustomError(custodian, "ZeroAmount");
        });

        it("should revert if withdrawing more than available", async function () {
            const tooMuch = ethers.parseUnits("200", 18);
            await expect(custodian.connect(client1).withdraw(tokenA.target, tooMuch))
                .to.be.revertedWithCustomError(custodian, "InsufficientBalance");
        });

        it("should revert if user is fully blacklisted", async function () {
            await complianceManager.blacklistUser(client1.address);
            await expect(custodian.connect(client1).withdraw(tokenA.target, DEPOSIT_AMOUNT))
                .to.be.revertedWithCustomError(custodian, "UserCannotWithdraw");
        });

        it("should allow withdrawal if user is BlacklistedWithWithdrawal", async function () {
            await complianceManager.setUserStatus(client1.address, UserStatus.BlacklistedWithWithdrawal);
            await custodian.connect(client1).withdraw(tokenA.target, DEPOSIT_AMOUNT);
            expect(await custodian.balanceOf(client1.address, tokenA.target)).to.equal(0);
        });

        it("should emit Withdrawn event", async function () {
            await expect(custodian.connect(client1).withdraw(tokenA.target, DEPOSIT_AMOUNT))
                .to.emit(custodian, "Withdrawn")
                .withArgs(client1.address, tokenA.target, DEPOSIT_AMOUNT);
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
    });
});