// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ICustodian {

    // Locks some funds from a client's available balance, moving them to locked balance 
    function lockFunds(address client, address token, uint256 amount) external;

    // Unlocks some funds from a client's locked balance, moving them back to available balance
    function unlockFunds(address client, address token, uint256 amount) external;

    // Performs an internal transfer between two clients updating their balances
    function internalTransfer(address from, address to, address token, uint256 amount) external;

    // Check available balance
    function balanceOf(address client, address token) external view returns (uint256);

    // Check locked balance
    function lockedBalanceOf(address client, address token) external view returns (uint256);
}