// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/ISettlementEngine.sol";
import "../interfaces/ITokenRegistry.sol";
import "../interfaces/IOrderbook.sol";
import "../interfaces/ICustodian.sol";

contract SettlementEngine is ISettlementEngine {
    
    ICustodian public immutable custodian;
    IOrderBook public immutable orderBook;
    ITokenRegistry public immutable tokenRegistry;


    //----------------------------------------------Events-----------------------------------------------------------
    event TradeExecuted(uint256 indexed orderIdMaker, uint256 indexed orderIdTaker, uint256 executedAmount);

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
        if (orderBook.isSystemPaused()) revert SystemPaused();
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

    /**
     * @notice Executes a trade between a maker and taker order
     * @dev Validates orders, checks balances, performs internal transfers, and updates the OrderBook
     * @param orderIdMaker The ID of the maker order
     * @param orderIdTaker The ID of the taker order
     */
    function executeTrade(uint256 orderIdMaker, uint256 orderIdTaker) external onlyOrderBook whenNotPaused {
        IOrderBook.Order memory makerOrder = orderBook.getOrder(orderIdMaker);
        IOrderBook.Order memory takerOrder = orderBook.getOrder(orderIdTaker);

        assert(makerOrder.tokenIn == takerOrder.tokenOut);
        assert(makerOrder.tokenOut == takerOrder.tokenIn);

        // Check if the tokens in the orders aren't blacklisted
        if (!tokenRegistry.isTokenAllowed(makerOrder.tokenIn) || 
            !tokenRegistry.isTokenAllowed(takerOrder.tokenIn)) {
            orderBook.cancelOrder(orderIdMaker);
            orderBook.cancelOrder(orderIdTaker);
            revert TokenNotAllowed();
        }

        // Check maker user — if blacklisted cancel maker only, taker order stays active
        if (!tokenRegistry.isUserAllowed(makerOrder.client)) {
            orderBook.cancelOrder(orderIdMaker);
            revert UserNotAllowed();
        }

        // Check taker user — if blacklisted cancel taker only, maker order stays active
        if (!tokenRegistry.isUserAllowed(takerOrder.client)) {
            orderBook.cancelOrder(orderIdTaker);
            revert UserNotAllowed();
        }

        // Determine executed amount — minimum of both sides
        // This handles partial fills: the smaller order fills completely,
        // the larger one gets its remaining amount updated
        uint256 executedAmount = makerOrder.amount < takerOrder.amount ? makerOrder.amount : takerOrder.amount;

        // Check maker has enough locked funds for the executed amount
        uint256 makerLocked = custodian.lockedBalanceOf(makerOrder.client, makerOrder.tokenOut);
        if (makerLocked < executedAmount) {
            orderBook.cancelOrder(orderIdMaker);
            revert InsufficientLockedBalance(makerLocked, executedAmount);
        }

        // Check taker has enough locked funds for the executed amount
        uint256 takerLocked = custodian.lockedBalanceOf(takerOrder.client, takerOrder.tokenOut);
        if (takerLocked < executedAmount) {
            orderBook.cancelOrder(orderIdTaker);
            revert InsufficientLockedBalance(takerLocked, executedAmount);
        }

        // Execute both legs of the trade atomically
        custodian.internalTransfer(makerOrder.client, takerOrder.client, makerOrder.tokenOut, executedAmount);
        custodian.internalTransfer(takerOrder.client, makerOrder.client, takerOrder.tokenOut, executedAmount);

        // Update remaining amounts in the OrderBook
        // Each order's new remaining = old amount - executedAmount
        orderBook.updateOrderAmount(orderIdMaker, makerOrder.amount - executedAmount);
        orderBook.updateOrderAmount(orderIdTaker, takerOrder.amount - executedAmount);

        emit TradeExecuted(orderIdMaker, orderIdTaker, executedAmount);
    }


    /**
     * @notice Executes a direct trade between a maker order and a taker order provided as input
     * @dev Validates orders, checks balances, performs internal transfers, and updates the OrderBook only for the maker order
     * @param makerOrderId The ID of the maker order
     * @param takerOrder The taker order details provided as input (not stored in OrderBook)
     */
    function executeDirectTrade(uint256 makerOrderId, IOrderBook.Order memory takerOrder) external onlyOrderBook whenNotPaused {
        IOrderBook.Order memory makerOrder = orderBook.getOrder(makerOrderId);

        assert(makerOrder.tokenIn == takerOrder.tokenOut);
        assert(makerOrder.tokenOut == takerOrder.tokenIn);

        // Check if the tokens in the orders aren't blacklisted
        if (!tokenRegistry.isTokenAllowed(makerOrder.tokenIn) ||
            !tokenRegistry.isTokenAllowed(takerOrder.tokenIn)) {
            orderBook.cancelOrder(makerOrderId);
            // taker order is never stored so nothing to cancel on that side
            revert TokenNotAllowed();
        }

        // Check maker user — if blacklisted cancel maker only, taker order stays active
        if (!tokenRegistry.isUserAllowed(makerOrder.client)) {
            orderBook.cancelOrder(makerOrderId);
            revert UserNotAllowed();
        }

        // Check taker user — if blacklisted cancel taker only, maker order stays active
        if (!tokenRegistry.isUserAllowed(takerOrder.client)) {
            // taker order was never stored, just revert
            revert UserNotAllowed();
        }

        // Determine executed amount
        uint256 executedAmount = makerOrder.amount < takerOrder.amount ? makerOrder.amount : takerOrder.amount;

        // Check maker has enough locked funds for the executed amount
        uint256 makerLocked = custodian.lockedBalanceOf(makerOrder.client, makerOrder.tokenOut);
        if (makerLocked < executedAmount) {
            orderBook.cancelOrder(makerOrderId);
            revert InsufficientLockedBalance(makerLocked, executedAmount);
        }

        // Check taker has enough locked funds for the executed amount
        uint256 takerLocked = custodian.lockedBalanceOf(takerOrder.client, takerOrder.tokenOut);
        if (takerLocked < executedAmount) {
            // taker funds were locked in takeOrder() — unlock them before reverting
            custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerLocked);
            revert InsufficientLockedBalance(takerLocked, executedAmount);
        }

        // Execute both legs
        custodian.internalTransfer(makerOrder.client, takerOrder.client, makerOrder.tokenOut, executedAmount);
        custodian.internalTransfer(takerOrder.client, makerOrder.client, takerOrder.tokenOut, executedAmount);

        // Update maker amount — taker has no stored order to update
        orderBook.updateOrderAmount(makerOrderId, makerOrder.amount - executedAmount);

        emit TradeExecuted(makerOrderId, 0, executedAmount);
    }
}