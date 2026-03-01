// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ICustodian {

    function lockFunds(address client, address token, uint256 amount) external;

    function unlockFunds(address client, address token, uint256 amount) external;

    function internalTransfer(address from, address to, address token, uint256 amount) external;

    function balanceOf(address client, address token) external view returns (uint256);
}