// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/ISettlementEngine.sol";
import "../interfaces/ITokenRegistry.sol";
import "../interfaces/IOrderbook.sol";
import "../interfaces";

contract SettlementEngine is ISettlementEngine {
    
    ICustodian public immutable custodian;
    IOrderBook public immutable orderBook;
    ITokenRegistry public immutable tokenRegistry;


    //----------------------------------------------Events-----------------------------------------------------------
    event TradeExecuted(uint256 indexed orderIdMaker, uint256 indexed orderIdTaker);


    //----------------------------------------------Errors-----------------------------------------------------------
    error InsufficientLockedBalance(uint256 lockedBalance, uint256 requiredAmount);
    error NotOrderBook();
    error SystemPaused();
    error TokenNotAllowed();
    error UserNotAllowed();
    error ZeroAddress();

    //---------------------------------------------Modifiers--------------------------------------------------------

    // Only allows the Orderbook to call the functions
    modifier onlyOrderBook() {
        if (msg.sender != address(orderBook)) revert NotOrderBook();
        _;
    }

    // Checks the OrderBook's paused state
    modifier whenNotPaused() {
        if (orderBook.paused()) revert SystemPaused();
        _;
    }


    //----------------------------------------------Constructor-----------------------------------------------------
    constructor(address _tokenRegistry, address _custodian, address _orderBook) {
        if (_tokenRegistry == address(0) || _custodian == address(0) || _orderBook == address(0))
            revert ZeroAddress();

        tokenRegistry = ITokenRegistry(_tokenRegistry);
        custodian = ICustodian(_custodian);
        orderBook = IOrderBook(_orderBook);
    }


    //----------------------------------------------Functions-------------------------------------------------------
    function executeTrade(uint256 orderIdMaker, uint256 orderIdTaker) external onlyOrderBook whenNotPaused {
        Order makerOrder = orderBook.getOrder(orderIdMaker);
        Order takerOrder = orderBook.getOrder(orderIdTaker);

        // Check if the tokens in the orders aren't blacklisted
        if (!tokenRegistry.isTokenAllowed(makerOrder.tokenIn) || !tokenRegistry.isTokenAllowed(takerOrder.tokenIn)) {
            orderBook.cancelOrder(orderIdMaker);
            orderBook.cancelOrder(orderIdTaker);
            revert TokenNotAllowed();
        }

        // Check if the users in the orders aren't blacklisted
        if(!tokenRegistry.isUserAllowed(makerOrder.user)) {
            orderBook.cancelOrder(orderIdMaker);
            revert UserNotAllowed();
        }

        if(!tokenRegistry.isUserAllowed(takerOrder.user)) {
            orderBook.cancelOrder(orderIdTaker);
            revert UserNotAllowed();
        }
        
        // Check if the users have enough locked funds to execute the trade
        uint256 makerLockedBalance = custodian.lockedBalanceOf(makerOrder.user, makerOrder.tokenIn);
        if(makerLockedBalance < makerOrder.amount) {
            orderBook.cancelOrder(orderIdMaker);
            revert InsufficientLockedBalance(makerLockedBalance, makerOrder.amount);
        }

        uint256 takerLockedBalance = custodian.lockedBalanceOf(takerOrder.user, takerOrder.tokenIn);
        if(takerLockedBalance < takerOrder.amount) {
            orderBook.cancelOrder(orderIdTaker);
            revert InsufficientLockedBalance(takerLockedBalance, takerOrder.amount);
        }

        // Execute the trade by transferring the funds
        custodian.internalTransfer(makerOrder.user, takerOrder.user, makerOrder.tokenIn, makerOrder.amount);
        custodian.internalTransfer(takerOrder.user, makerOrder.user, takerOrder.tokenIn, takerOrder.amount);

        emit TradeExecuted(orderIdMaker, orderIdTaker);
    }
}