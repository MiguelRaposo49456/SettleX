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
    let operator: any;
    let user1: any;
    let user2: any;
    let tokenAddress: string;

    // Role hashes
    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
    const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

    beforeEach(async function () {
        [admin, operator, user1, user2] = await ethers.getSigners();

        complianceManager = await ethers.deployContract("ComplianceManager");
        tokenAddress = ethers.Wallet.createRandom().address;

        await complianceManager.connect(admin).grantRole(OPERATOR_ROLE, operator.address);
    });

    //-----------------------------------Token blacklisting---------------------------------------

    describe("Token blacklisting", function () {

        it("should allow a token by default", async function () {
            expect(await complianceManager.isTokenAllowed(tokenAddress)).to.be.true;
        });

        it("should blacklist a token", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenAddress);
            expect(await complianceManager.isTokenAllowed(tokenAddress)).to.be.false;
        });

        it("should unblacklist a token", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenAddress);
            await complianceManager.connect(operator).unblacklistToken(tokenAddress);
            expect(await complianceManager.isTokenAllowed(tokenAddress)).to.be.true;
        });

        it("should not affect other tokens when blacklisting one", async function () {
            const otherToken = ethers.Wallet.createRandom().address;
            await complianceManager.connect(operator).blacklistToken(tokenAddress);
            expect(await complianceManager.isTokenAllowed(otherToken)).to.be.true;
        });

        it("should revert if non-operator tries to blacklist a token", async function () {
            await expect(complianceManager.connect(user1).blacklistToken(tokenAddress))
                .to.be.revertedWithCustomError(complianceManager, "AccessControlUnauthorizedAccount")
                .withArgs(user1.address, OPERATOR_ROLE);
        });

        it("should revert if non-operator tries to unblacklist a token", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenAddress);
            await expect(complianceManager.connect(user1).unblacklistToken(tokenAddress))
                .to.be.revertedWithCustomError(complianceManager, "AccessControlUnauthorizedAccount")
                .withArgs(user1.address, OPERATOR_ROLE);
        });

        it("should emit TokenBlacklisted event", async function () {
            await expect(complianceManager.connect(operator).blacklistToken(tokenAddress))
                .to.emit(complianceManager, "TokenBlacklisted")
                .withArgs(tokenAddress);
        });

        it("should emit TokenUnblacklisted event", async function () {
            await complianceManager.connect(operator).blacklistToken(tokenAddress);
            await expect(complianceManager.connect(operator).unblacklistToken(tokenAddress))
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
            await complianceManager.connect(operator).setUserStatus(user1.address, UserStatus.Blacklisted);
            await complianceManager.connect(operator).setUserStatus(user1.address, UserStatus.Allowed);
            expect(await complianceManager.isUserAllowed(user1.address)).to.be.true;
            expect(await complianceManager.canUserWithdraw(user1.address)).to.be.true;
        });

        it("should correctly set user to BlacklistedWithWithdrawal", async function () {
            await complianceManager.connect(operator).setUserStatus(user1.address, UserStatus.BlacklistedWithWithdrawal);
            expect(await complianceManager.isUserAllowed(user1.address)).to.be.false;
            expect(await complianceManager.canUserWithdraw(user1.address)).to.be.true;
        });

        it("should correctly set user to Blacklisted", async function () {
            await complianceManager.connect(operator).setUserStatus(user1.address, UserStatus.Blacklisted);
            expect(await complianceManager.isUserAllowed(user1.address)).to.be.false;
            expect(await complianceManager.canUserWithdraw(user1.address)).to.be.false;
        });

        it("should not affect other users when blacklisting one", async function () {
            await complianceManager.connect(operator).setUserStatus(user1.address, UserStatus.Blacklisted);
            expect(await complianceManager.isUserAllowed(user2.address)).to.be.true;
            expect(await complianceManager.canUserWithdraw(user2.address)).to.be.true;
        });

        it("should revert if non-operator tries to set user status", async function () {
            await expect(complianceManager.connect(user1).setUserStatus(user2.address, UserStatus.Blacklisted))
                .to.be.revertedWithCustomError(complianceManager, "AccessControlUnauthorizedAccount")
                .withArgs(user1.address, OPERATOR_ROLE);
        });

        it("should emit UserStatusUpdated event", async function () {
            await expect(complianceManager.connect(operator).setUserStatus(user1.address, UserStatus.BlacklistedWithWithdrawal))
                .to.emit(complianceManager, "UserStatusUpdated")
                .withArgs(user1.address, UserStatus.BlacklistedWithWithdrawal);
        });
    });

    //-------------------------------------Circuit breaker---------------------------------------

    describe("Circuit breaker", function () {

        it("should not be paused by default", async function () {
            expect(await complianceManager.isSystemPaused()).to.be.false;
        });

        it("should pause the system", async function () {
            await complianceManager.connect(operator).pause();
            expect(await complianceManager.isSystemPaused()).to.be.true;
        });

        it("should unpause the system", async function () {
            await complianceManager.connect(operator).pause();
            await complianceManager.connect(operator).unpause();
            expect(await complianceManager.isSystemPaused()).to.be.false;
        });

        it("should revert if non-operator tries to pause", async function () {
            await expect(complianceManager.connect(user1).pause())
                .to.be.revertedWithCustomError(complianceManager, "AccessControlUnauthorizedAccount")
                .withArgs(user1.address, OPERATOR_ROLE);
        });

        it("should revert if non-operator tries to unpause", async function () {
            await complianceManager.connect(operator).pause();
            await expect(complianceManager.connect(user1).unpause())
                .to.be.revertedWithCustomError(complianceManager, "AccessControlUnauthorizedAccount")
                .withArgs(user1.address, OPERATOR_ROLE);
        });

        it("should emit Paused event", async function () {
            await expect(complianceManager.connect(operator).pause())
                .to.emit(complianceManager, "Paused")
                .withArgs(operator.address);
        });

        it("should emit Unpaused event", async function () {
            await complianceManager.connect(operator).pause();
            await expect(complianceManager.connect(operator).unpause())
                .to.emit(complianceManager, "Unpaused")
                .withArgs(operator.address);
        });
    });

    //-------------------------------------Operator management---------------------------------------

    describe("Operator management", function () {

        it("should allow admin to grant operator role", async function () {
            await complianceManager.connect(admin).grantRole(OPERATOR_ROLE, user1.address);
            expect(await complianceManager.hasRole(OPERATOR_ROLE, user1.address)).to.be.true;
        });

        it("should allow admin to revoke operator role", async function () {
            await complianceManager.connect(admin).revokeRole(OPERATOR_ROLE, operator.address);
            expect(await complianceManager.hasRole(OPERATOR_ROLE, operator.address)).to.be.false;
        });

        it("should revert if revoked operator tries to blacklist", async function () {
            await complianceManager.connect(admin).revokeRole(OPERATOR_ROLE, operator.address);
            await expect(complianceManager.connect(operator).blacklistToken(tokenAddress))
                .to.be.revertedWithCustomError(complianceManager, "AccessControlUnauthorizedAccount")
                .withArgs(operator.address, OPERATOR_ROLE);
        });

        it("should revert if non-admin tries to grant operator role", async function () {
            await expect(complianceManager.connect(user1).grantRole(OPERATOR_ROLE, user2.address))
                .to.be.revertedWithCustomError(complianceManager, "AccessControlUnauthorizedAccount")
                .withArgs(user1.address, DEFAULT_ADMIN_ROLE);
        });
    });
});