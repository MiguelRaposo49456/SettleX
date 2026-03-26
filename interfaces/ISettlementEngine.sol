// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/IFungibleOrderbook.sol";

interface ISettlementEngine {
    // Executes a trade between a maker and taker order
    function executeTrade(uint256 orderIdMaker, uint256 orderIdTaker) external;

    // Executes a direct trade where the taker order is not stored in the OrderBook
    function executeDirectTrade(uint256 makerOrderId, IFungibleOrderbook.Order memory takerOrder) external;

    // Executes a trade between an NFT listing and an offer
    function executeNFTTrade(uint256 listingId, uint256 offerId) external;
}