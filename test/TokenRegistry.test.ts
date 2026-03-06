import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

const UserStatus = {
    Allowed: 0,
    BlacklistedWithWithdrawal: 1,
    Blacklisted: 2
};

describe("TokenRegistry", function () {
    let tokenRegistry: any;
    let admin: any;
    let user1: any;
    let user2: any;
    let tokenAddress: string;

    beforeEach(async function () {
        [admin, user1, user2] = await ethers.getSigners();

        tokenRegistry = await ethers.deployContract("TokenRegistry");
        tokenAddress = ethers.Wallet.createRandom().address;
    });

    //-----------------------------------Token blacklisting---------------------------------------

    describe("Token blacklisting", function () {

        it("should allow a token by default", async function () {
            expect(await tokenRegistry.isTokenAllowed(tokenAddress)).to.be.true;
        });

        it("should blacklist a token", async function () {
            await tokenRegistry.blacklistToken(tokenAddress);
            expect(await tokenRegistry.isTokenAllowed(tokenAddress)).to.be.false;
        });

        it("should unblacklist a token", async function () {
            await tokenRegistry.blacklistToken(tokenAddress);
            await tokenRegistry.unblacklistToken(tokenAddress);
            expect(await tokenRegistry.isTokenAllowed(tokenAddress)).to.be.true;
        });

        it("should not affect other tokens when blacklisting one", async function () {
            const otherToken = ethers.Wallet.createRandom().address;
            await tokenRegistry.blacklistToken(tokenAddress);
            expect(await tokenRegistry.isTokenAllowed(otherToken)).to.be.true;
        });

        it("should emit TokenBlacklisted event", async function () {
            await expect(tokenRegistry.blacklistToken(tokenAddress))
                .to.emit(tokenRegistry, "TokenBlacklisted")
                .withArgs(tokenAddress);
        });

        it("should emit TokenUnblacklisted event", async function () {
            await tokenRegistry.blacklistToken(tokenAddress);
            await expect(tokenRegistry.unblacklistToken(tokenAddress))
                .to.emit(tokenRegistry, "TokenUnblacklisted")
                .withArgs(tokenAddress);
        });
    });

    //-------------------------------------User status---------------------------------------

    describe("User status", function () {

        it("should allow a user by default", async function () {
            expect(await tokenRegistry.isUserAllowed(user1.address)).to.be.true;
        });

        it("should allow withdrawal by default", async function () {
            expect(await tokenRegistry.canUserWithdraw(user1.address)).to.be.true;
        });

        it("should correctly set user to Allowed", async function () {
            await tokenRegistry.setUserStatus(user1.address, UserStatus.Blacklisted);
            await tokenRegistry.setUserStatus(user1.address, UserStatus.Allowed);
            expect(await tokenRegistry.isUserAllowed(user1.address)).to.be.true;
            expect(await tokenRegistry.canUserWithdraw(user1.address)).to.be.true;
        });

        it("should correctly set user to BlacklistedWithWithdrawal", async function () {
            await tokenRegistry.setUserStatus(user1.address, UserStatus.BlacklistedWithWithdrawal);
            expect(await tokenRegistry.isUserAllowed(user1.address)).to.be.false;
            expect(await tokenRegistry.canUserWithdraw(user1.address)).to.be.true;
        });

        it("should correctly set user to Blacklisted", async function () {
            await tokenRegistry.setUserStatus(user1.address, UserStatus.Blacklisted);
            expect(await tokenRegistry.isUserAllowed(user1.address)).to.be.false;
            expect(await tokenRegistry.canUserWithdraw(user1.address)).to.be.false;
        });

        it("should not affect other users when blacklisting one", async function () {
            await tokenRegistry.setUserStatus(user1.address, UserStatus.Blacklisted);
            expect(await tokenRegistry.isUserAllowed(user2.address)).to.be.true;
            expect(await tokenRegistry.canUserWithdraw(user2.address)).to.be.true;
        });

        it("should emit UserStatusUpdated event", async function () {
            await expect(tokenRegistry.setUserStatus(user1.address, UserStatus.BlacklistedWithWithdrawal))
                .to.emit(tokenRegistry, "UserStatusUpdated")
                .withArgs(user1.address, UserStatus.BlacklistedWithWithdrawal);
        });
    });
});