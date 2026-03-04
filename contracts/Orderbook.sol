// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "solidity-linked-list/contracts/StructuredLinkedList.sol";
import "../interfaces/IOrderbook.sol";
import "../interfaces/ICustodian.sol";
import "../interfaces/ISettlementEngine.sol";
import "../interfaces/ITokenRegistry.sol";
import "./libs/BokkyPooBahsRedBlackTreeLibrary.sol";


contract OrderBook is IOrderBook {
    using StructuredLinkedList for StructuredLinkedList.List;
    using BokkyPooBahsRedBlackTreeLibrary for BokkyPooBahsRedBlackTreeLibrary.Tree;

    // Scaling factor for prices to avoid floating point (1e18 precision)
    uint256 public constant PRICE_PRECISION = 1e18;

    uint8 public constant BUY  = 0;
    uint8 public constant SELL = 1;

    ITokenRegistry public immutable tokenRegistry;
    ICustodian public custodian;
    ISettlementEngine public settlementEngine;
    bool public initialized;


    // Global order storage by ID
    mapping(uint256 orderId => Order) private _orders;

    // Auto-incrementing order ID counter
    uint256 private _nextOrderId;

    // RB trees for buy side — keyed by price (higher = better)
    mapping(bytes32 pairId => BokkyPooBahsRedBlackTreeLibrary.Tree) private _buyTrees;

    // RB trees for sell side — keyed by price (lower = better)
    mapping(bytes32 pairId => BokkyPooBahsRedBlackTreeLibrary.Tree) private _sellTrees;

    // FIFO linked lists of order IDs per (pair, price level) for buys
    mapping(bytes32 pairId => mapping(uint256 price => StructuredLinkedList.List)) private _buyOrders;

    // FIFO linked lists of order IDs per (pair, price level) for sells
    mapping(bytes32 pairId => mapping(uint256 price => StructuredLinkedList.List)) private _sellOrders;

    bool public paused;


    //----------------------------------------------Events-----------------------------------------------------------
    event OrderPlaced(
        uint256 indexed orderId,
        address indexed client,
        bytes32 indexed pairId,
        address tokenIn,
        address tokenOut,
        uint256 price,
        uint256 amount,
        uint8 side,
        bool partialAllowed
    );
    event OrderCancelled(uint256 indexed orderId, address indexed client);
    event OrderMatched(uint256 indexed makerOrderId, uint256 indexed takerOrderId);
    event OrderPartiallyFilled(uint256 indexed orderId, uint256 matchedAmount, uint256 remainingAmount);
    event Initialized(address custodian, address settlementEngine);
    
    
    //----------------------------------------------Errors-----------------------------------------------------------
    error AlreadyInitialized();
    error InvalidSide();
    error NotInitialized();
    error NotOrderOwner(uint256 orderId);
    error NotSettlementEngine();
    error OrderNotActive(uint256 orderId);
    error SameToken();
    error SystemPaused();
    error TokenNotAllowed(address token);
    error UserNotAllowed(address user);
    error ZeroAddress();
    error ZeroAmount();
    error ZeroPrice();


    //---------------------------------------------Modifiers--------------------------------------------------------
    modifier whenNotPaused() {
        if (paused) revert SystemPaused();
        _;
    }

    modifier whenInitialized() {
        if (!initialized) revert NotInitialized();
        _;
    }

    modifier onlySettlementEngine() {
        if (msg.sender != address(settlementEngine)) revert NotSettlementEngine();
        _;
    }
    
    
    //----------------------------------------------Constructor-----------------------------------------------------
    constructor(address _tokenRegistry) {
        if (_tokenRegistry == address(0)) revert ZeroAddress();
        tokenRegistry = ITokenRegistry(_tokenRegistry);
        _nextOrderId  = 1; // start at 1 so 0 can be used as null in linked lists
    }


    //--------------------------------Initialization — resolves circular dependency---------------------------------
    /*
     * Wire up Custodian and SettlementEngine after all three contracts are deployed
     * Can only be called once by the operator (maybe an Admin would be a better idea)
    function initialize(address _custodian, address _settlementEngine) external onlyOperator {
        if (initialized) revert AlreadyInitialized();
        if (_custodian == address(0) || _settlementEngine == address(0)) revert ZeroAddress();

        custodian        = ICustodian(_custodian);
        settlementEngine = ISettlementEngine(_settlementEngine);
        initialized      = true;

        emit Initialized(_custodian, _settlementEngine);
    }
    */


    //------------------------------------------Circuit Breaker------------------------------------------------------
    /*
    function pause() external onlyOperator {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOperator {
        paused = false;
        emit Unpaused(msg.sender);
    }
    */


    //----------------------------------------------Functions-------------------------------------------------------
    /**
     * @notice Place a new order
     * @dev Flow:
     *   1. Validate inputs, tokens, user and lock the funds
     *   2. Attempt matching against the opposite side — BEFORE storing
     *   3. If fully matched, return 0 (nothing stored)
     *   4. If partially or not matched, store the order
     * @param tokenIn        Token the client wants to receive
     * @param tokenOut       Token the client is giving
     * @param price          Quote tokens per base token, scaled by PRICE_PRECISION
     * @param amount         Amount of baseToken to buy or sell
     * @param partialAllowed Whether partial fills are acceptable
     * @return orderId       ID of the stored order, or 0 if fully matched immediately
     */
    function placeOrder(
        address tokenIn,
        address tokenOut,
        uint256 price,
        uint256 amount,
        uint8 side,
        bool partialAllowed
    ) external whenNotPaused whenInitialized returns (uint256 orderId) {
        if (amount == 0) revert ZeroAmount();
        if (price  == 0) revert ZeroPrice();
        if (tokenIn == tokenOut) revert SameToken();

        if (!tokenRegistry.isTokenAllowed(tokenIn)) revert TokenNotAllowed(tokenIn);
        if (!tokenRegistry.isTokenAllowed(tokenOut)) revert TokenNotAllowed(tokenOut);
        if (!tokenRegistry.isUserAllowed(msg.sender)) revert UserNotAllowed(msg.sender);

        // Derive canonical pair and side
        bytes32 pairId = _getPairId(tokenIn, tokenOut);

        uint256 lockAmount = _computeLockAmount(side, amount, price);
        custodian.lockFunds(msg.sender, tokenOut, lockAmount);

        // Store the order with remaining amount
        orderId = _nextOrderId++;

        _orders[orderId] = Order({
            id: orderId,
            client: msg.sender,
            pairId: pairId,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            price: price,
            amount: amount,
            side: side,
            active: true,
            timestamp: block.timestamp,
            partialAllowed: partialAllowed
        });

        _insertIntoBook(orderId, pairId, side, price);

        // Attempt matching against the opposite side
        uint256 remainingAmount = _matchIncoming(
            orderId,
            pairId,
            price,
            amount,
            side,
            partialAllowed
        );

        emit OrderPlaced(orderId, msg.sender, pairId, tokenIn, tokenOut, price, remainingAmount, side, partialAllowed);
    }

    /**
     * @notice Cancel an active order and return locked funds to the client
     * @dev Callable by the order owner or by the SettlementEngine (blacklist enforcement)
     * @param orderId ID of the order to cancel
     */
    function cancelOrder(uint256 orderId) external whenInitialized {
        Order storage order = _orders[orderId];

        if (!order.active) revert OrderNotActive(orderId);
        if (msg.sender != order.client && msg.sender != address(settlementEngine))
            revert NotOrderOwner(orderId);

        order.active = false;
        _removeFromBook(orderId, order.pairId, order.side, order.price);

        uint256 unlockAmount = _computeLockAmount(order.side, order.amount, order.price);

        custodian.unlockFunds(order.client, order.tokenOut, unlockAmount);

        emit OrderCancelled(orderId, order.client);
    }


    /**
     * @notice Called by the SettlementEngine after a successful trade
     * @param orderId ID of the order to update
     * @param remainingAmount Amount still left to fill after this trade
     */
    function updateOrderAmount(uint256 orderId, uint256 remainingAmount) external onlySettlementEngine {
        Order storage order = _orders[orderId];

        order.amount = remainingAmount;

        if (remainingAmount == 0) {
            order.active = false;
            _removeFromBook(orderId, order.pairId, order.side, order.price);
        } else {
            emit OrderPartiallyFilled(orderId, order.amount, remainingAmount);
        }
    }


    /**
     * @notice Try to match an incoming order against existing book orders
     * @dev For each match found:
     *        - Update the maker's stored order (amount, active flag, book structures)
     *        - Call settlementEngine.executeTrade() for atomic settlement
     * @return remainingTakerAmount  Amount of baseToken still unmatched after the loop
     */
    function _matchIncoming(
        uint256 takerOrderId,
        bytes32 pairId,
        uint256 price,
        uint256 amount,
        uint8 side,
        bool partialAllowed
    ) internal returns (uint256 remainingTakerAmount) {
        remainingTakerAmount = amount;

        while (remainingTakerAmount > 0) {
            // Find best price on the opposite side
            (bool found, uint256 bestPrice) = _getBestPrice(pairId, side);
            if (!found) break;

            // Check price compatibility
            if (side == BUY  && bestPrice > price) break;
            if (side == SELL && bestPrice < price) break;

            // Get linked list at this price level
            StructuredLinkedList.List storage list = (side == BUY)
                ? _sellOrders[pairId][bestPrice]
                : _buyOrders[pairId][bestPrice];

            // Begin the inner loop to find a match at this price level
            bool matchFoundAtLevel = false;
            uint256 makerOrderId   = _getListHead(list);

            while (makerOrderId != 0) {
                Order storage maker = _orders[makerOrderId];
                uint256 nextId = _getNext(list, makerOrderId);

                // Clean up stale entries lazily
                if (!maker.active) {
                    _removeFromList(list, makerOrderId);
                    makerOrderId = nextId;
                    continue;
                }

                // Check partial fill compatibility
                bool fullFillPossible = maker.amount >= remainingTakerAmount;

                // If maker doesn't allow partials and full fill isn't possible, skip
                if (!maker.partialAllowed && !fullFillPossible) {
                    makerOrderId = nextId;
                    continue;
                }
                // If taker doesn't allow partials and full fill isn't possible, skip
                if (!partialAllowed && !fullFillPossible) {
                    makerOrderId = nextId;
                    continue;
                }

                emit OrderMatched(makerOrderId, takerOrderId);

                // Call SettlementEngine to execute the trade atomically
                settlementEngine.executeTrade(makerOrderId, takerOrderId);

                // Retrieve the amount left from the taker order
                remainingTakerAmount = _orders[takerOrderId].amount;

                matchFoundAtLevel = true;
                break; // restart outer loop since best price may have changed
            }

            if (!matchFoundAtLevel) break;
        }
    }

    /**
     * @notice Checks if the system is paused (circuit breaker)
     */
    function isSystemPaused() external view returns (bool) {
        return paused;
    }   

    //---------------------------------Internal helpers — RB tree + linked list management--------------------------------

    /**
     * @notice Insert an order into the order book
     * @dev Adds the order to the appropriate tree and linked list
     */
    function _insertIntoBook(
        uint256 orderId,
        bytes32 pairId,
        uint8   side,
        uint256 price
    ) internal {
        if (side == BUY) {
            if (!_buyTrees[pairId].exists(price)) _buyTrees[pairId].insert(price);
            _buyOrders[pairId][price].pushBack(orderId);
        } else {
            if (!_sellTrees[pairId].exists(price)) _sellTrees[pairId].insert(price);
            _sellOrders[pairId][price].pushBack(orderId);
        }
    }

    /**
     * @notice Remove an order from the order book
     * @dev Removes the order from the linked list and cleans up the tree if the price level is empty
     */
    function _removeFromBook(
        uint256 orderId,
        bytes32 pairId,
        uint8   side,
        uint256 price
    ) internal {
        if (side == BUY) {
            _removeFromList(_buyOrders[pairId][price], orderId);
            if (!_buyOrders[pairId][price].listExists()) _buyTrees[pairId].remove(price);
        } else {
            _removeFromList(_sellOrders[pairId][price], orderId);
            if (!_sellOrders[pairId][price].listExists()) _sellTrees[pairId].remove(price);
        }
    }

    /**
     * @notice Remove an order ID from a linked list
     */
    function _removeFromList(
        StructuredLinkedList.List storage list,
        uint256 orderId
    ) internal {
        if (list.nodeExists(orderId)) list.remove(orderId);
    }

    //---------------------------------------Internal helpers — price and amount---------------------------------
    /**
     * @notice Get the best available price on the opposite side
     * @dev Incoming BUY  → match against lowest sell  (first() of sell tree)
     *      Incoming SELL → match against highest buy  (last()  of buy tree)
     */
    function _getBestPrice(bytes32 pairId, uint8 incomingSide) internal view returns (bool found, uint256 price) {
        if (incomingSide == BUY) {
            price = _sellTrees[pairId].first();
        } else {
            price = _buyTrees[pairId].last();
        }
        found = price != 0;
    }

    /** 
     * @notice Get the head of the linked list (first order ID at this price level)
     */
    function _getListHead(StructuredLinkedList.List storage list) internal view returns (uint256) {
        (, uint256 head) = list.getAdjacent(0, true);
        return head;
    }

    /** 
     * @notice Get the next order ID in the linked list after a given order ID
     */
    function _getNext(StructuredLinkedList.List storage list, uint256 orderId) internal view returns (uint256) {
        (, uint256 next) = list.getAdjacent(orderId, true);
        return next;
    }

    /**
     * @notice How many tokenOut to lock for a given order
     * @dev SELL: gives baseToken  → lock `amount` baseTokens
     *      BUY:  gives quoteToken → lock `amount * price / PRICE_PRECISION` quoteTokens
     */
    function _computeLockAmount(uint8 side, uint256 amount, uint256 price) internal pure returns (uint256) {
        return side == SELL ? amount : (amount * price) / PRICE_PRECISION;
    }

    /**
     * @notice Get the canonical pair ID for two tokens
     * @dev Ensures a consistent ordering of tokens to generate a unique ID
     */
    function _getPairId(address tokenA, address tokenB) internal pure returns (bytes32) {
        (address base, address quote) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encodePacked(base, quote));
    }


    //----------------------------------------------View Functions------------------------------------------------
    // Get an order by ID
    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }
}
