// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ISettlementEngine {
    function executeTrade(uint256 orderIdMaker, uint256 orderIdTaker) external;
}