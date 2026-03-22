// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IMockLendingPool {
    // Supply funds to the lending pool
    function supply(address token, uint256 amount, address user) external returns (uint256);

    // Withdraw funds from the lending pool
    function withdraw(address token, uint256 scaledAmount, address user) external returns (uint256);

    // Get the address of the aToken corresponding to the given token
    function getAToken(address token) external view returns (address);

    // Get the balance of a user for a given token (including interest)
    function balanceOf(address token, address user) external view returns (uint256);
}