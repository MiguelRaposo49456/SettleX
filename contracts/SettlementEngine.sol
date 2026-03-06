// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/ISettlementEngine.sol";
import "../interfaces/ITokenRegistry.sol";
import "../interfaces/IOrderbook.sol";
import "../interfaces/ICustodian.sol";

contract SettlementEngine is ISettlementEngine {
    
    ICustodian public custodian;
    IOrderBook public orderBook;
    ITokenRegistry public immutable tokenRegistry;

    bool public initialized;
    address public immutable admin;


    //----------------------------------------------Events-----------------------------------------------------------
    event TradeExecuted(uint256 indexed orderIdMaker, uint256 indexed orderIdTaker, uint256 executedAmount);
    event Initialized(address orderbook, address custodian);

    //----------------------------------------------Errors-----------------------------------------------------------
    error AlreadyInitialized();
    error NotAdmin();
    error NotInitialized();
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

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenInitialized() {
        if (!initialized) revert NotInitialized();
        _;
    }


    //----------------------------------------------Constructor-----------------------------------------------------
    constructor(address _tokenRegistry) {
        if (_tokenRegistry == address(0)) revert ZeroAddress();

        tokenRegistry = ITokenRegistry(_tokenRegistry);
        admin = msg.sender;
    }

    //--------------------------------Initialization — resolves circular dependency---------------------------------
    /**
     * @notice Wire up Orderbook and Custodian after all three contracts are deployed
     * @dev Can only be called once by the admin
     */
    function initialize(address _orderBook, address _custodian) external onlyAdmin {
        if (initialized) revert AlreadyInitialized();
        if (_orderBook == address(0) || _custodian == address(0)) revert ZeroAddress();

        orderBook = IOrderBook(_orderBook);
        custodian = ICustodian(_custodian);
        initialized = true;

        emit Initialized(_orderBook, _custodian);
    }


    //----------------------------------------------Functions-------------------------------------------------------

    /**
     * @notice Executes a trade between a maker and taker order
     * @dev Validates orders, checks balances, performs internal transfers, and updates the OrderBook
     * @param orderIdMaker The ID of the maker order
     * @param orderIdTaker The ID of the taker order
     */
    function executeTrade(uint256 orderIdMaker, uint256 orderIdTaker) external onlyOrderBook whenNotPaused whenInitialized {
        IOrderBook.Order memory takerOrder = orderBook.getOrder(orderIdTaker);
        _executeTrade(orderIdMaker, takerOrder, orderIdTaker);
    }


    /**
     * @notice Executes a direct trade between a maker order and a taker order provided as input
     * @dev Validates orders, checks balances, performs internal transfers, and updates the OrderBook only for the maker order
     * @param makerOrderId The ID of the maker order
     * @param takerOrder The taker order details provided as input (not stored in OrderBook)
     */
    function executeDirectTrade(uint256 makerOrderId, IOrderBook.Order memory takerOrder) external onlyOrderBook whenNotPaused whenInitialized {
        _executeTrade(makerOrderId, takerOrder, 0);
    }

    /**
     * @notice Internal function to execute a trade between a maker and taker order
     * @param makerOrderId The ID of the maker order
     * @param takerOrder The taker order details provided as input (not stored in OrderBook)
     * @param takerOrderId The ID of the taker order if it exists in the OrderBook, or 0 if it's a direct trade
     */
    function _executeTrade(
        uint256 makerOrderId,
        IOrderBook.Order memory takerOrder,
        uint256 takerOrderId  // 0 if taker has no stored order
    ) internal {
        IOrderBook.Order memory makerOrder = orderBook.getOrder(makerOrderId);

        assert(makerOrder.tokenIn == takerOrder.tokenOut);
        assert(makerOrder.tokenOut == takerOrder.tokenIn);

        // Check if the tokens in the orders aren't blacklisted
        if (!tokenRegistry.isTokenAllowed(makerOrder.tokenIn) || !tokenRegistry.isTokenAllowed(takerOrder.tokenIn)) {
            orderBook.cancelOrder(makerOrderId);
            if (takerOrderId != 0) orderBook.cancelOrder(takerOrderId);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            revert TokenNotAllowed();
        }

        // Check maker user — if blacklisted cancel maker only, taker order stays active
        if (!tokenRegistry.isUserAllowed(makerOrder.client)) {
            orderBook.cancelOrder(makerOrderId);
            if (takerOrderId == 0) custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            revert UserNotAllowed();
        }

        // Check taker user — if blacklisted cancel taker only, maker order stays active
        if (!tokenRegistry.isUserAllowed(takerOrder.client)) {
            if (takerOrderId != 0) orderBook.cancelOrder(takerOrderId);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            revert UserNotAllowed();
        }

        // Determine executed amount — minimum of both sides
        // This handles partial fills: the smaller order fills completely,
        // the larger one gets its remaining amount updated
        uint256 executedAmount = makerOrder.amount < takerOrder.amount ? makerOrder.amount : takerOrder.amount;

        // Check maker has enough locked funds for the executed amount
        uint256 makerLocked = custodian.lockedBalanceOf(makerOrder.client, makerOrder.tokenOut);
        if (makerLocked < executedAmount) {
            orderBook.cancelOrder(makerOrderId);
            if (takerOrderId == 0) custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            revert InsufficientLockedBalance(makerLocked, executedAmount);
        }

        // Check taker has enough locked funds for the executed amount
        uint256 takerLocked = custodian.lockedBalanceOf(takerOrder.client, takerOrder.tokenOut);
        if (takerLocked < executedAmount) {
            if (takerOrderId != 0) orderBook.cancelOrder(takerOrderId);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerLocked);
            revert InsufficientLockedBalance(takerLocked, executedAmount);
        }

        // Execute both legs of the trade atomically
        custodian.internalTransfer(makerOrder.client, takerOrder.client, makerOrder.tokenIn, executedAmount);
        custodian.internalTransfer(takerOrder.client, makerOrder.client, takerOrder.tokenIn, executedAmount);

        // Update remaining amounts in the OrderBook
        // Each order's new remaining = old amount - executedAmount
        orderBook.updateOrderAmount(makerOrderId, makerOrder.amount - executedAmount);

        // Update taker amount only if it has a stored order
        if (takerOrderId != 0) {
            orderBook.updateOrderAmount(takerOrderId, takerOrder.amount - executedAmount);
        }

        emit TradeExecuted(makerOrderId, takerOrderId, executedAmount);
    }
}