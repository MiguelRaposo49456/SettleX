// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ITokenRegistry {

    enum UserStatus {
        Allowed,
        BlacklistedWithWithdrawal,
        Blacklisted
    }

    // Token validation
    function isTokenAllowed(address token) external view returns (bool);

    // User validation
    function isUserAllowed(address user) external view returns (bool);

    // Withdrawal validation
    function canUserWithdraw(address user) external view returns (bool);

    //TODO: add it to the interface if other contracts depend on it
    // function getUserStatus(address user) external view returns (UserStatus);
}