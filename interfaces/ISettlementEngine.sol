// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IOrderbook.sol";

interface ISettlementEngine {
    // Executes a trade between a maker and taker order
    function executeTrade(uint256 orderIdMaker, uint256 orderIdTaker) external;

    // Executes a direct trade where the taker order is not stored in the OrderBook
    function executeDirectTrade(uint256 makerOrderId, IOrderBook.Order memory takerOrder) external;
}