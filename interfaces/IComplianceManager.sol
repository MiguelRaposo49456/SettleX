// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IComplianceManager {

    enum UserStatus {
        Allowed,
        BlacklistedWithWithdrawal,
        Blacklisted
    }

    // System control
    function isSystemPaused() external view returns (bool);

    // Token validation
    function isTokenAllowed(address token) external view returns (bool);

    // User validation
    function isUserAllowed(address user) external view returns (bool);
    function canUserWithdraw(address user) external view returns (bool);
}