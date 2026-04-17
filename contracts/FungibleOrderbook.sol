// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "solidity-linked-list/contracts/StructuredLinkedList.sol";
import "../interfaces/IFungibleOrderbook.sol";
import "../interfaces/ICustodian.sol";
import "../interfaces/ISettlementEngine.sol";
import "../interfaces/IComplianceManager.sol";
import "./libs/BokkyPooBahsRedBlackTreeLibrary.sol";


contract FungibleOrderbook is IFungibleOrderbook {
    using StructuredLinkedList for StructuredLinkedList.List;
    using BokkyPooBahsRedBlackTreeLibrary for BokkyPooBahsRedBlackTreeLibrary.Tree;

    // Scaling factor for prices to avoid floating point (1e18 precision)
    uint256 public constant PRICE_PRECISION = 1e18;

    uint8 public constant BUY  = 0;
    uint8 public constant SELL = 1;

    // Reveal windows (in blocks)
    uint256 public constant ORDER_REVEAL_WINDOW = 20; // ~4 min
    uint256 public constant TAKE_REVEAL_WINDOW  = 10; // ~2 min — takes are more time-sensitive

    IComplianceManager public immutable complianceManager;
    ICustodian public custodian;
    ISettlementEngine public settlementEngine;
    
    bool public initialized;
    address public immutable admin;

    // Global order storage by ID
    mapping(uint256 orderId => Order) private _orders;

    // Remaining escrow reserved for each order
    mapping(uint256 orderId => uint256) private _orderEscrow;

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
    //-----------------------------------------------Commit-Reveal---------------------------------------------------
    mapping(uint256 commitId => PendingCommit) private _pendingCommits;
    uint256 private _nextCommitId; // starts at 0 since theres no need to use 0 as null in this case


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
    event OrderPartiallyFilled(uint256 indexed orderId, uint256 matchedAmount);
    event Initialized(address custodian, address settlementEngine);
    event Committed(uint256 indexed commitId, address indexed client, uint256 commitBlock);
    event CommitExpired(uint256 indexed commitId, address indexed client);
    event MakerBlacklisted(uint256 indexed orderId, address indexed maker);
    event TokenBlacklisted();
    event OrderReinstated(uint256 indexed orderId, uint256 reinstatedAmount);

    
    //----------------------------------------------Errors-----------------------------------------------------------
    error AlreadyInitialized();
    error CommitAlreadyRevealed();
    error CommitAndRevealOnSameBlock();
    error CommitExpiredError(uint256 commitId);
    error CommitHashMismatch();
    error CommitNotFound(uint256 commitId);
    error InsufficientLockedBalance(uint256 escrowed, uint256 required);
    error InvalidSide();
    error NotAdmin();
    error NotCommitOwner(uint256 commitId);
    error NotInitialized();
    error NotOrderOwner(uint256 orderId);
    error NotSettlementEngine();
    error OrderNotActive(uint256 orderId);
    error OrderWasntMatchedCantReinstate(uint256 orderId);
    error PartialFillNotAllowed();
    error RevealWindowOpen(uint256 commitId);
    error SameToken();
    error SystemPaused();
    error TokenNotAllowed();
    error UserNotAllowed(address user);
    error WrongCommitType(uint256 commitId);
    error ZeroAddress();
    error ZeroAmount();
    error ZeroPrice();


    //---------------------------------------------Modifiers--------------------------------------------------------
    modifier whenNotPaused() {
        if (complianceManager.isSystemPaused()) revert SystemPaused();
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

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }
    
    
    //----------------------------------------------Constructor-----------------------------------------------------
    constructor(address _complianceManager) {
        if (_complianceManager == address(0)) revert ZeroAddress();
        complianceManager = IComplianceManager(_complianceManager);
        admin = msg.sender;
        _nextOrderId  = 1; // start at 1 so 0 can be used as null in linked lists
    }


    //--------------------------------Initialization — resolves circular dependency---------------------------------
    /**
     * @notice Wire up Custodian and SettlementEngine after all three contracts are deployed
     * @dev Can only be called once by the admin
     */
    function initialize(address _custodian, address _settlementEngine) external onlyAdmin {
        if (initialized) revert AlreadyInitialized();
        if (_custodian == address(0) || _settlementEngine == address(0)) revert ZeroAddress();

        custodian = ICustodian(_custodian);
        settlementEngine = ISettlementEngine(_settlementEngine);
        initialized = true;

        emit Initialized(_custodian, _settlementEngine);
    }


    //----------------------------------------------Functions Commit-Reveal-------------------------------------------
    /**
     * @notice Phase 1 (order) — submit a hash of your order without revealing its contents
     * @dev Compute off-chain the hash of the intended operation with the correct parameters and a secret salt
     * @param commitHash Hash of the order parameters + secret salt
     * @return commitId ID to reference in revealOrder()
     */
    function commit(bytes32 commitHash, CommitType commitType) external whenNotPaused whenInitialized returns (uint256 commitId) {
        commitId = _nextCommitId++;

        uint256 revealWindow = commitType == CommitType.Order ? ORDER_REVEAL_WINDOW : TAKE_REVEAL_WINDOW;

        _pendingCommits[commitId] = PendingCommit({
            commitHash: commitHash,
            client: msg.sender,
            commitBlock: block.number,
            revealDeadline: block.number + revealWindow,
            revealed: false,
            commitType: commitType
        });

        emit Committed(commitId, msg.sender, block.number);
    }

     /**
     * @notice Phase 2 (order) — reveal order parameters that match your earlier commit
     * @dev The order enters the CLOB with commitBlock as its time-priority, NOT the
     *         current block — this is what makes front-running ineffective.
     * @param  commitId ID returned by commit()
     * @param  tokenIn Token the client wants to receive
     * @param  tokenOut Token the client is giving
     * @param  price Quote tokens per base token, scaled by PRICE_PRECISION
     * @param  amount Amount of baseToken to buy or sell
     * @param  side BUY (0) or SELL (1)
     * @param  partialAllowed Whether partial fills are acceptable
     * @param  salt Secret random value used when computing the commit hash
     */
    function revealOrder(
        uint256 commitId,
        address tokenIn,
        address tokenOut,
        uint256 price,
        uint256 amount,
        uint8 side,
        bool partialAllowed,
        bytes32 salt
    ) external whenNotPaused whenInitialized {
        PendingCommit storage pending = _pendingCommits[commitId];

        if (pending.client == address(0)) revert CommitNotFound(commitId);
        if (msg.sender != pending.client) revert NotCommitOwner(commitId);
        if (pending.commitType != CommitType.Order) revert WrongCommitType(commitId);
        if (pending.revealed) revert CommitAlreadyRevealed();
        if (block.number == pending.commitBlock) revert CommitAndRevealOnSameBlock();
        if (block.number > pending.revealDeadline) {
            revert CommitExpiredError(commitId);
        }

        // Hash verification
        bytes32 expectedHash = keccak256(abi.encodePacked(
            msg.sender,
            tokenIn,
            tokenOut,
            price,
            amount,
            side,
            partialAllowed,
            salt
        ));
        if (expectedHash != pending.commitHash) revert CommitHashMismatch();

        // Check Effect Interaction — mark as revealed before any external calls
        pending.revealed = true;

        // Input validation
        if (amount == 0) revert ZeroAmount();
        if (price  == 0) revert ZeroPrice();
        if (tokenIn == tokenOut) revert SameToken();
        if (side != BUY && side != SELL) revert InvalidSide();

        if (!complianceManager.isTokenAllowed(tokenIn) || !complianceManager.isTokenAllowed(tokenOut))
            revert TokenNotAllowed();
        if (!complianceManager.isUserAllowed(msg.sender))
            revert UserNotAllowed(msg.sender);

        _placeOrder(tokenIn, tokenOut, price, amount, side, partialAllowed, pending.commitBlock);
    }
    
    /**
     * @notice Phase 2 (take) — reveal take parameters that match your earlier commit.
     * @param  commitId     ID returned by commit()
     * @param  makerOrderId ID of the maker order to fill
     * @param  takerAmount  Amount to fill
     * @param  salt         Secret random value used when computing the commit hash
     */
    function revealTake(
        uint256 commitId,
        uint256 makerOrderId,
        uint256 takerAmount,
        bytes32 salt
    ) external whenNotPaused whenInitialized {
        PendingCommit storage pending = _pendingCommits[commitId];

        if (pending.client == address(0)) revert CommitNotFound(commitId);
        if (msg.sender != pending.client) revert NotCommitOwner(commitId);
        if (pending.commitType != CommitType.Take) revert WrongCommitType(commitId);
        if (pending.revealed) revert CommitAlreadyRevealed();
        if (block.number == pending.commitBlock) revert CommitAndRevealOnSameBlock();
        if (block.number > pending.revealDeadline) {
            revert CommitExpiredError(commitId);
        }

        // Hash verification
        bytes32 expectedHash = keccak256(abi.encodePacked(
            msg.sender,
            makerOrderId,
            takerAmount,
            salt
        ));
        if (expectedHash != pending.commitHash) revert CommitHashMismatch();

        // Check Effect Interaction — mark as revealed before any external calls
        pending.revealed = true;

        _takeOrder(makerOrderId, takerAmount, pending.commitBlock);
    }

    //----------------------------------------------Orderbook Functions-----------------------------------------------
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
    function _placeOrder(
        address tokenIn,
        address tokenOut,
        uint256 price,
        uint256 amount,
        uint8 side,
        bool partialAllowed,
        uint256 commitBlock
    ) internal returns (uint256 orderId) {
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
            lockedAmount: lockAmount,
            side: side,
            status: Status.Active,
            block: commitBlock,
            partialAllowed: partialAllowed
        });
        _orderEscrow[orderId] = lockAmount;

        _insertIntoBook(orderId, pairId, side, price);

        // Attempt matching against the opposite side
        uint256 remainingAmount = _matchIncoming(orderId);

        emit OrderPlaced(orderId, msg.sender, pairId, tokenIn, tokenOut, price, remainingAmount, side, partialAllowed);
    }

    function _takeOrder(uint256 makerOrderId, uint256 takerAmount, uint256 commitBlock) internal {
        Order storage maker = _orders[makerOrderId];

        if (maker.status == Status.Inactive) revert OrderNotActive(makerOrderId);

        if (!complianceManager.isUserAllowed(msg.sender)) revert UserNotAllowed(msg.sender);
        if (!complianceManager.isUserAllowed(maker.client)) {
            _cancelOrder(makerOrderId, maker);
            emit MakerBlacklisted(makerOrderId, maker.client);
            return;
        } 

        if (!complianceManager.isTokenAllowed(maker.tokenIn) || !complianceManager.isTokenAllowed(maker.tokenOut)) {
            _cancelOrder(makerOrderId, maker);
            emit TokenBlacklisted();
            return;
        }

        uint256 amountToFulfill = takerAmount > maker.amount ? maker.amount : takerAmount;
        // If maker doesn't allow partials, taker must fulfill the entire order
        if (!maker.partialAllowed && amountToFulfill < maker.amount) revert PartialFillNotAllowed();

        uint8 takerSide = maker.side == BUY ? SELL : BUY;

        // Lock taker funds
        uint256 lockAmount = _computeLockAmount(takerSide, amountToFulfill, maker.price);
        custodian.lockFunds(msg.sender, maker.tokenIn, lockAmount);

        // Build taker order as a memory struct — never stored in the book
        IFungibleOrderbook.Order memory takerOrder = IFungibleOrderbook.Order({
            id:             0,
            client:         msg.sender,
            pairId:         maker.pairId,
            tokenIn:        maker.tokenOut,
            tokenOut:       maker.tokenIn,
            price:          maker.price,
            amount:         amountToFulfill,
            lockedAmount:   lockAmount,
            side:           takerSide,
            status:         Status.Matched,
            block:          commitBlock,
            partialAllowed: false
        });

        // Delegate directly to Settlement Engine
        settlementEngine.executeDirectTrade(makerOrderId, takerOrder, amountToFulfill);

        maker.amount -= amountToFulfill;
        maker.status = Status.Matched;
    }

    /**
     * @notice Cancel an active order and return locked funds to the client
     * @dev Callable by the order owner
     * @param orderId ID of the order to cancel
     */
    function cancelOrder(uint256 orderId) external whenInitialized {
        Order storage order = _orders[orderId];

        if (order.status == Status.Inactive) revert OrderNotActive(orderId);
        if (msg.sender != order.client && msg.sender != address(settlementEngine)) revert NotOrderOwner(orderId);

        _cancelOrder(orderId, order);
    }

    /**
     * @notice Restore a matched-but-failed order to active status
     * @dev Called by the SettlementEngine when a queued trade fails during settlement
     *      Re-activates the order and adds `amount` back to its remaining amount
     * @param orderId The ID of the order to reinstate
     * @param amount  The executedAmount that was deducted at match time
     */
    function reinstateOrder(uint256 orderId, uint256 amount) external onlySettlementEngine {
        Order storage order = _orders[orderId];

        if(order.status != Status.Matched) revert OrderWasntMatchedCantReinstate(orderId);

        order.status = Status.Active;
        order.amount += amount;
        emit OrderReinstated(orderId, amount);
    }

    /**
     * @notice Reduce the remaining escrow for a settled order
     * @dev Called by the SettlementEngine after a trade succeeds
     */
    function consumeLockedAmount(uint256 orderId, uint256 amount) external onlySettlementEngine {
        uint256 escrowAmount = _orderEscrow[orderId];
        if (escrowAmount < amount) revert InsufficientLockedBalance(escrowAmount, amount);
        _orderEscrow[orderId] = escrowAmount - amount;
    }

    /**
     * @notice Checks if a settled order should remain Matched for later trades in this batch,
     *         or transition to Inactive/Active based on the remaining amount
     * @dev Called by the SettlementEngine after a trade is executed to update the order status accordingly
     * @param orderId ID of the order to update
     * @param keepMatched Whether this order still has later trades pending in the current batch
     */
    function updateOrder(uint256 orderId, bool keepMatched) external onlySettlementEngine whenInitialized {
        Order storage order = _orders[orderId];

        if (keepMatched) {
            order.status = Status.Matched;
            return;
        }

        if (order.amount == 0) {
            order.status = Status.Inactive;
            _removeFromBook(orderId, order.pairId, order.side, order.price);
        } else {
            order.status = Status.Active;
            emit OrderPartiallyFilled(orderId, order.amount);
        }
    }

    //----------------------------------------------Internal Matching Logic------------------------------------------------

    /**
     * @notice Try to match an incoming order against existing book orders
     * @dev For each match found:
     *        - Update the maker's stored order (amount, active flag, book structures)
     *        - Call settlementEngine.executeTrade() for atomic settlement
     * @return remainingTakerAmount  Amount of baseToken still unmatched after the loop
     */
    function _matchIncoming(
        uint256 takerOrderId
    ) internal returns (uint256 remainingTakerAmount) {
        Order storage takerOrder = _orders[takerOrderId];

        while (takerOrder.amount > 0) {
            // Find best price on the opposite side
            (bool found, uint256 bestPrice) = _getBestPrice(takerOrder.pairId, takerOrder.side);
            if (!found) break;

            // Check price compatibility
            if (takerOrder.side == BUY  && bestPrice > takerOrder.price) break;
            if (takerOrder.side == SELL && bestPrice < takerOrder.price) break;

            // Get linked list at this price level
            StructuredLinkedList.List storage list = (takerOrder.side == BUY)
                ? _sellOrders[takerOrder.pairId][bestPrice]
                : _buyOrders[takerOrder.pairId][bestPrice];

            // Begin the inner loop to find a match at this price level
            bool matchFoundAtLevel = false;
            uint256 makerOrderId = _getListHead(list);

            while (makerOrderId != 0) {
                Order storage maker = _orders[makerOrderId];
                uint256 nextId = _getNext(list, makerOrderId);

                // Clean up stale entries lazily
                if (maker.status == Status.Inactive) {
                    _removeFromList(list, makerOrderId);
                    makerOrderId = nextId;
                    continue;
                }
                else if (maker.status == Status.Matched) {
                    // A matched order with remaining amount can still be matched again
                    // Only skip if it is fully consumed.
                    if (maker.amount == 0) {
                        makerOrderId = nextId;
                        continue;
                    }
                }

                // Check partial fill compatibility
                bool makerFullyFilled = takerOrder.amount >= maker.amount;
                bool takerFullyFilled = maker.amount >= takerOrder.amount;

                // If maker doesn't allow partials and full fill isn't possible, skip
                if (!maker.partialAllowed && !makerFullyFilled) {
                    makerOrderId = nextId;
                    continue;
                }
                // If taker doesn't allow partials and full fill isn't possible, skip
                if (!takerOrder.partialAllowed && !takerFullyFilled) {
                    makerOrderId = nextId;
                    continue;
                }

                // Determine how much of this match will consume
                uint256 fillAmount = maker.amount < takerOrder.amount ? maker.amount : takerOrder.amount;

                emit OrderMatched(makerOrderId, takerOrderId);

                maker.amount -= fillAmount;
                maker.status = Status.Matched;

                takerOrder.amount -= fillAmount;
                takerOrder.status = Status.Matched;

                // Call SettlementEngine to execute the trade atomically
                settlementEngine.executeTrade(makerOrderId, takerOrderId, fillAmount);

                matchFoundAtLevel = true;
                break; // restart outer loop since best price may have changed
            }

            if (!matchFoundAtLevel) break;
        }
        return takerOrder.amount;
    }


    //---------------------------------Internal helpers — RB tree + linked list management--------------------------------
    /**
     * @notice Cancel an order by ID
     * @dev The private version of the cancelOrder function
      * @param orderId ID of the order to cancel
      * @param order Reference to the Order struct in storage
     */
    function _cancelOrder(uint256 orderId, Order storage order) internal {
        uint256 unlockAmount = _orderEscrow[orderId];

        order.status = Status.Inactive;
        _orderEscrow[orderId] = 0;

        _removeFromBook(orderId, order.pairId, order.side, order.price);

        custodian.unlockFunds(order.client, order.tokenOut, unlockAmount);

        emit OrderCancelled(orderId, order.client);
    }

    /**
     * @notice Insert an order into the order book
     * @dev Adds the order to the appropriate tree and linked list
     */
    function _insertIntoBook(uint256 orderId, bytes32 pairId, uint8 side, uint256 price) internal {
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
    function _removeFromBook(uint256 orderId, bytes32 pairId, uint8 side, uint256 price) internal {
        if (side == BUY) {
            if (_buyOrders[pairId][price].nodeExists(orderId)) {
                _removeFromList(_buyOrders[pairId][price], orderId);
                if (!_buyOrders[pairId][price].listExists()) _buyTrees[pairId].remove(price);
            }
        } else {
            if (_sellOrders[pairId][price].nodeExists(orderId)) {
                _removeFromList(_sellOrders[pairId][price], orderId);
                if (!_sellOrders[pairId][price].listExists()) _sellTrees[pairId].remove(price);
            }
        }
    }

    /**
     * @notice Remove an order ID from a linked list
     */
    function _removeFromList(StructuredLinkedList.List storage list, uint256 orderId) internal {
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

    // Get pending commit details by ID
    function getPendingCommit(uint256 commitId) external view returns (PendingCommit memory) {
        return _pendingCommits[commitId];
    }
}
