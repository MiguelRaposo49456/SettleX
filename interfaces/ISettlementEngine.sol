// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IOrderbook.sol";

interface ISettlementEngine {
    function executeTrade(uint256 orderIdMaker, uint256 orderIdTaker) external;

    function executeDirectTrade(uint256 makerOrderId, IOrderBook.Order memory takerOrder) external;
}