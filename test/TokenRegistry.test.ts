import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

const UserStatus = {
    Allowed: 0,
    BlacklistedWithWithdrawal: 1,
    Blacklisted: 2
};

describe("ComplianceManager", function () {
    let complianceManager: any;
    let admin: any;
    let user1: any;
    let user2: any;
    let tokenAddress: string;

    beforeEach(async function () {
        [admin, user1, user2] = await ethers.getSigners();

        complianceManager = await ethers.deployContract("ComplianceManager");
        tokenAddress = ethers.Wallet.createRandom().address;
    });

    //-----------------------------------Token blacklisting---------------------------------------

    describe("Token blacklisting", function () {

        it("should allow a token by default", async function () {
            expect(await complianceManager.isTokenAllowed(tokenAddress)).to.be.true;
        });

        it("should blacklist a token", async function () {
            await complianceManager.blacklistToken(tokenAddress);
            expect(await complianceManager.isTokenAllowed(tokenAddress)).to.be.false;
        });

        it("should unblacklist a token", async function () {
            await complianceManager.blacklistToken(tokenAddress);
            await complianceManager.unblacklistToken(tokenAddress);
            expect(await complianceManager.isTokenAllowed(tokenAddress)).to.be.true;
        });

        it("should not affect other tokens when blacklisting one", async function () {
            const otherToken = ethers.Wallet.createRandom().address;
            await complianceManager.blacklistToken(tokenAddress);
            expect(await complianceManager.isTokenAllowed(otherToken)).to.be.true;
        });

        it("should emit TokenBlacklisted event", async function () {
            await expect(complianceManager.blacklistToken(tokenAddress))
                .to.emit(complianceManager, "TokenBlacklisted")
                .withArgs(tokenAddress);
        });

        it("should emit TokenUnblacklisted event", async function () {
            await complianceManager.blacklistToken(tokenAddress);
            await expect(complianceManager.unblacklistToken(tokenAddress))
                .to.emit(complianceManager, "TokenUnblacklisted")
                .withArgs(tokenAddress);
        });
    });

    //-------------------------------------User status---------------------------------------

    describe("User status", function () {

        it("should allow a user by default", async function () {
            expect(await complianceManager.isUserAllowed(user1.address)).to.be.true;
        });

        it("should allow withdrawal by default", async function () {
            expect(await complianceManager.canUserWithdraw(user1.address)).to.be.true;
        });

        it("should correctly set user to Allowed", async function () {
            await complianceManager.setUserStatus(user1.address, UserStatus.Blacklisted);
            await complianceManager.setUserStatus(user1.address, UserStatus.Allowed);
            expect(await complianceManager.isUserAllowed(user1.address)).to.be.true;
            expect(await complianceManager.canUserWithdraw(user1.address)).to.be.true;
        });

        it("should correctly set user to BlacklistedWithWithdrawal", async function () {
            await complianceManager.setUserStatus(user1.address, UserStatus.BlacklistedWithWithdrawal);
            expect(await complianceManager.isUserAllowed(user1.address)).to.be.false;
            expect(await complianceManager.canUserWithdraw(user1.address)).to.be.true;
        });

        it("should correctly set user to Blacklisted", async function () {
            await complianceManager.setUserStatus(user1.address, UserStatus.Blacklisted);
            expect(await complianceManager.isUserAllowed(user1.address)).to.be.false;
            expect(await complianceManager.canUserWithdraw(user1.address)).to.be.false;
        });

        it("should not affect other users when blacklisting one", async function () {
            await complianceManager.setUserStatus(user1.address, UserStatus.Blacklisted);
            expect(await complianceManager.isUserAllowed(user2.address)).to.be.true;
            expect(await complianceManager.canUserWithdraw(user2.address)).to.be.true;
        });

        it("should emit UserStatusUpdated event", async function () {
            await expect(complianceManager.setUserStatus(user1.address, UserStatus.BlacklistedWithWithdrawal))
                .to.emit(complianceManager, "UserStatusUpdated")
                .withArgs(user1.address, UserStatus.BlacklistedWithWithdrawal);
        });
    });
});