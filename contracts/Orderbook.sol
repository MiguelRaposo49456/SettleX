// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "solidity-linked-list/contracts/StructuredLinkedList.sol";
import "../interfaces/IOrderbook.sol";
import "../interfaces/ICustodian.sol";
import "../interfaces/ISettlementEngine.sol";
import "../interfaces/IComplianceManager.sol";
import "./libs/BokkyPooBahsRedBlackTreeLibrary.sol";


contract OrderBook is IOrderBook {
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

    // Auto-incrementing order ID counter
    uint256 private _nextOrderId;

    // Auto-incrementing IDs for NFT listings and offers
    uint256 private _nextListingId;
    uint256 private _nextOfferId;

    // RB trees for buy side — keyed by price (higher = better)
    mapping(bytes32 pairId => BokkyPooBahsRedBlackTreeLibrary.Tree) private _buyTrees;

    // RB trees for sell side — keyed by price (lower = better)
    mapping(bytes32 pairId => BokkyPooBahsRedBlackTreeLibrary.Tree) private _sellTrees;

    // FIFO linked lists of order IDs per (pair, price level) for buys
    mapping(bytes32 pairId => mapping(uint256 price => StructuredLinkedList.List)) private _buyOrders;

    // FIFO linked lists of order IDs per (pair, price level) for sells
    mapping(bytes32 pairId => mapping(uint256 price => StructuredLinkedList.List)) private _sellOrders;

    //------------------------------------NFT Listings and Offers Storage--------------------------------------------

    // NFT Listings by ID
    mapping(uint256 => NFTListing) private _nftListings;

    // NFT Offers by ID
    mapping(uint256 => NFTOffer) private _nftOffers;

    // Index: collection => tokenId => listingId (0 = no active listing)
    mapping(address => mapping(uint256 => uint256)) private _activeListingByNFT;

    // Index: collection => tokenId => offerId[] (multiple offers per NFT allowed)
    mapping(address => mapping(uint256 => uint256[])) private _offersByNFT;


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
    event OrderPartiallyFilled(uint256 indexed orderId, uint256 matchedAmount, uint256 remainingAmount);
    event Initialized(address custodian, address settlementEngine);
    event Committed(uint256 indexed commitId, address indexed client, uint256 commitBlock);
    event CommitExpired(uint256 indexed commitId, address indexed client);
    event MakerBlacklisted(uint256 indexed orderId, address indexed maker);
    event TokenBlacklisted();
    event NFTListed(uint256 indexed listingId, address indexed seller, address indexed collection, uint256 tokenId);
    event NFTOfferMade(uint256 indexed offerId, address indexed buyer, address indexed collection, uint256 tokenId);
    event NFTListingCancelled(uint256 indexed listingId, address indexed seller);
    event NFTOfferCancelled(uint256 indexed offerId, address indexed buyer);
    event NFTListingUpdated(uint256 indexed listingId, bool active);
    event NFTOfferUpdated(uint256 indexed offerId, bool active);

    
    //----------------------------------------------Errors-----------------------------------------------------------
    error AlreadyInitialized();
    error CommitAlreadyRevealed();
    error CommitAndRevealOnSameBlock();
    error CommitExpiredError(uint256 commitId);
    error CommitHashMismatch();
    error CommitNotFound(uint256 commitId);
    error InvalidSide();
    error NotAdmin();
    error NotCommitOwner(uint256 commitId);
    error NotInitialized();
    error NotOrderOwner(uint256 orderId);
    error NotSettlementEngine();
    error OrderNotActive(uint256 orderId);
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
            expired: false,
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
            pending.expired = true;
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
            pending.expired = true;
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

    /**
     * @notice Phase 2 (NFT listing) — reveal NFT listing parameters that match your earlier commit
     * @param  commitId ID returned by commit()
     * @param  collection Address of the NFT collection
     * @param  tokenId Token ID of the NFT to list
     * @param  paymentType Whether the payment is in ERC-20 or an NFT
     * @param  paymentToken If ERC-20, the address of the token; if NFT, the collection address of the desired NFT
     * @param  paymentAmount If ERC-20, the amount to pay; if NFT, should be 0
     * @param  paymentTokenId Only relevant for NFT-for-NFT trades
     * @param  salt Secret random value used when computing the commit hash
     */
    function revealNFTList(
        uint256 commitId,
        address collection,
        uint256 tokenId,
        IOrderBook.AssetType paymentType,
        address paymentToken,                           // ERC-20 address, or NFT collection if NFT-for-NFT
        uint256 paymentAmount,                          // 0 if NFT-for-NFT
        uint256 paymentTokenId,                         // only if paymentType is an ERC721
        bytes32 salt
    ) external whenNotPaused whenInitialized {
        PendingCommit storage pending = _pendingCommits[commitId];
        
        if (pending.client == address(0)) revert CommitNotFound(commitId);
        if (msg.sender != pending.client) revert NotCommitOwner(commitId);
        if (pending.commitType != CommitType.NFTList) revert WrongCommitType(commitId);
        if (pending.revealed) revert CommitAlreadyRevealed();
        if (block.number == pending.commitBlock) revert CommitAndRevealOnSameBlock();
        if (block.number > pending.revealDeadline) {
            pending.expired = true;
            revert CommitExpiredError(commitId);
        }

        bytes32 expectedHash = keccak256(abi.encodePacked(
            msg.sender, collection, tokenId,
            paymentType, paymentToken, paymentAmount, paymentTokenId,
            salt
        ));

        if (expectedHash != pending.commitHash) revert CommitHashMismatch();

        pending.revealed = true;

        if (!complianceManager.isTokenAllowed(collection)) revert TokenNotAllowed();
        if (!complianceManager.isUserAllowed(msg.sender))  revert UserNotAllowed(msg.sender);
        if (paymentType == AssetType.ERC20 && !complianceManager.isTokenAllowed(paymentToken)) revert TokenNotAllowed();

        // Lock the NFT
        custodian.lockNFT(msg.sender, collection, tokenId);

        uint256 listingId = _nextListingId++;
        _nftListings[listingId] = NFTListing({
            listingId: listingId,
            seller: msg.sender,
            collection: collection,
            tokenId: tokenId,
            paymentType: paymentType,
            paymentToken: paymentToken,
            paymentAmount: paymentAmount,
            paymentTokenId: paymentTokenId,
            active: true
        });

        _activeListingByNFT[collection][tokenId] = listingId;

        // Attempt immediate match against existing offers
        _matchNFTListing(listingId);

        emit NFTListed(listingId, msg.sender, collection, tokenId);
    }

    /**
     * @notice Phase 2 (NFT offer) — reveal NFT offer parameters that match your earlier commit
     * @param  commitId ID returned by commit()
     * @param  collection Address of the NFT collection
     * @param  tokenId Token ID of the NFT to buy
     * @param  offerType Whether the offer is in ERC-20 or an NFT
     * @param  offerToken If ERC-20, the address of the token; if NFT, the collection address of the offered NFT
     * @param  offerAmount If ERC-20, the amount offered; if NFT, should be 0
     * @param  offerTokenId Only relevant if the offer is an ERC-721
     * @param  salt Secret random value used when computing the commit hash
     */
    function revealNFTOffer(
        uint256 commitId,
        address collection,
        uint256 tokenId,
        IOrderBook.AssetType offerType,
        address offerToken,
        uint256 offerAmount,
        uint256 offerTokenId,
        bytes32 salt
    ) external whenNotPaused whenInitialized {
        PendingCommit storage pending = _pendingCommits[commitId];
        
        if (pending.client == address(0)) revert CommitNotFound(commitId);
        if (msg.sender != pending.client) revert NotCommitOwner(commitId);
        if (pending.commitType != CommitType.NFTOffer) revert WrongCommitType(commitId);
        if (pending.revealed) revert CommitAlreadyRevealed();
        if (block.number == pending.commitBlock) revert CommitAndRevealOnSameBlock();
        if (block.number > pending.revealDeadline) {
            pending.expired = true;
            revert CommitExpiredError(commitId);
        }

        bytes32 expectedHash = keccak256(abi.encodePacked(
            msg.sender, collection, tokenId,
            offerType, offerToken, offerAmount, offerTokenId,
            salt
        ));

        if (expectedHash != pending.commitHash) revert CommitHashMismatch();

        pending.revealed = true;

        // Lock payment
        if (offerType == AssetType.ERC20) {
            custodian.lockFunds(msg.sender, offerToken, offerAmount);
        } else {
            custodian.lockNFT(msg.sender, offerToken, offerTokenId);
        }

        uint256 offerId = _nextOfferId++;
        _nftOffers[offerId] = NFTOffer({
            offerId: offerId,
            buyer: msg.sender,
            collection: collection,
            tokenId: tokenId,
            offerType: offerType,
            offerToken: offerToken,
            offerAmount: offerAmount,
            offerTokenId: offerTokenId,
            active: true
        });

        _offersByNFT[collection][tokenId].push(offerId);

        // Check if there's an active listing this offer satisfies
        uint256 listingId = _activeListingByNFT[collection][tokenId];
        if (listingId != 0) _matchNFTOffer(listingId, offerId);

        emit NFTOfferMade(offerId, msg.sender, collection, tokenId);
    }


    /**
     * @notice Expire a commit whose reveal window has passed without a reveal.
     * @param  commitId  The commit to expire
     */
    function expireCommit(uint256 commitId) external {
        PendingCommit storage pending = _pendingCommits[commitId];

        if (pending.client == address(0)) revert CommitNotFound(commitId);
        if (pending.revealed) revert CommitAlreadyRevealed();
        if (pending.expired) revert CommitExpiredError(commitId);
        if (block.number <= pending.revealDeadline) revert RevealWindowOpen(commitId);

        pending.expired = true;
        emit CommitExpired(commitId, pending.client);
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
            side: side,
            active: true,
            block: commitBlock,
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

    function _takeOrder(uint256 makerOrderId, uint256 takerAmount, uint256 commitBlock) internal {
        Order storage maker = _orders[makerOrderId];

        if (!maker.active) revert OrderNotActive(makerOrderId);

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
        IOrderBook.Order memory takerOrder = IOrderBook.Order({
            id:             0,
            client:         msg.sender,
            pairId:         maker.pairId,
            tokenIn:        maker.tokenOut,
            tokenOut:       maker.tokenIn,
            price:          maker.price,
            amount:         amountToFulfill,
            side:           takerSide,
            active:         true,
            block:          commitBlock,
            partialAllowed: false
        });

        // Delegate directly to Settlement Engine
        settlementEngine.executeDirectTrade(makerOrderId, takerOrder);
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

        _cancelOrder(orderId, order);
    }

    /**
     * @notice Internal function to cancel an order
     * @param listingId ID of the NFT listing to cancel
     */
    function cancelNFTListing(uint256 listingId) external whenInitialized {
        NFTListing storage listing = _nftListings[listingId];

        if (!listing.active) revert OrderNotActive(listingId);
        if (msg.sender != listing.seller && msg.sender != address(settlementEngine)) revert NotOrderOwner(listingId);

        _deactivateListing(listingId);
        custodian.unlockNFT(listing.seller, listing.collection, listing.tokenId);

        emit NFTListingCancelled(listingId, listing.seller);
    }

    /**
     * @notice Cancel an active NFT offer and return locked payment to the buyer
     * @param offerId ID of the NFT offer to cancel
     */
    function cancelNFTOffer(uint256 offerId) external whenInitialized {
        NFTOffer storage offer = _nftOffers[offerId];
        if (!offer.active) revert OrderNotActive(offerId);
        if (msg.sender != offer.buyer && msg.sender != address(settlementEngine)) revert NotOrderOwner(offerId);

        _deactivateOffer(offerId);
        if (offer.offerType == AssetType.ERC20) {
            custodian.unlockFunds(offer.buyer, offer.offerToken, offer.offerAmount);
        } else {
            custodian.unlockNFT(offer.buyer, offer.offerToken, offer.offerTokenId);
        }

        emit NFTOfferCancelled(offerId, offer.buyer);
    }

    /**
     * @notice Deactivate a listing without unlocking the NFT
     * @param listingId ID of the NFT listing to deactivate
     */
    function deactivateListing(uint256 listingId) external onlySettlementEngine whenInitialized {
        _deactivateListing(listingId);
    }

    /**
     * @notice Deactivate an offer without unlocking the payment
     * @param offerId ID of the NFT offer to deactivate
     */
    function deactivateOffer(uint256 offerId) external onlySettlementEngine whenInitialized {
        _deactivateOffer(offerId);
    }

    /**
     * @notice Called by the SettlementEngine after a successful trade
     * @param orderId ID of the order to update
     * @param remainingAmount Amount still left to fill after this trade
     */
    function updateOrderAmount(uint256 orderId, uint256 remainingAmount) external onlySettlementEngine whenInitialized {
        Order storage order = _orders[orderId];

        order.amount = remainingAmount;

        if (remainingAmount == 0) {
            order.active = false;
            _removeFromBook(orderId, order.pairId, order.side, order.price);
        } else {
            emit OrderPartiallyFilled(orderId, order.amount, remainingAmount);
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
     * @notice Try to match a new NFT listing against existing offers for the same NFT
     * @dev For each offer:
     *        - Check if it satisfies the listing's ask
     *        - If yes, call settlementEngine.executeNFTTrade() for atomic settlement
     *        - Stop after the first match since the listing is no longer active after that
     * @param listingId ID of the new listing to match against existing offers
     */
    function _matchNFTListing(uint256 listingId) internal {
        NFTListing storage listing = _nftListings[listingId];
        uint256[] storage offerIds = _offersByNFT[listing.collection][listing.tokenId];

        for (uint256 i = 0; i < offerIds.length; i++) {
            NFTOffer storage offer = _nftOffers[offerIds[i]];
            if (!offer.active) continue;
            if (_offersMatch(listing, offer)) {
                settlementEngine.executeNFTTrade(listingId, offerIds[i]);
                return;
            }
        }
    }

    /**
     * @notice Try to match a new NFT offer against the active listing for the same NFT
     * @dev If the offer satisfies the listing's ask, call settlementEngine.executeNFTTrade() for atomic settlement
     * @param listingId ID of the existing listing to match against
     * @param offerId ID of the new offer to match against the existing listing
     */
    function _matchNFTOffer(uint256 listingId, uint256 offerId) internal {
        NFTListing storage listing = _nftListings[listingId];
        NFTOffer   storage offer   = _nftOffers[offerId];

        if (_offersMatch(listing, offer)) {
            settlementEngine.executeNFTTrade(listingId, offerId);
        }
    }

    /** @notice Check if a given offer satisfies the listing's ask
     * @dev For ERC-20 payments, offer must meet or exceed the ask amount at the specified price
     *      For NFT-for-NFT, offer must match the exact collection and tokenId specified in the listing
     * @param listing The NFT listing to check against
     * @param offer The NFT offer to check
     */
    function _offersMatch(NFTListing storage listing, NFTOffer storage offer) internal view returns (bool) {
        if (listing.paymentType != offer.offerType) return false;

        if (listing.paymentType == AssetType.ERC20) {
            return offer.offerToken  == listing.paymentToken && offer.offerAmount >= listing.paymentAmount;
        } else {
            return offer.offerToken  == listing.paymentToken && offer.offerTokenId == listing.paymentTokenId;
        }
    }


    //---------------------------------Internal helpers — RB tree + linked list management--------------------------------
    /**
     * @notice Cancel an order by ID
     * @dev The private version of the cancelOrder function
      * @param orderId ID of the order to cancel
      * @param order Reference to the Order struct in storage
     */
    function _cancelOrder(uint256 orderId, Order storage order) internal {
        order.active = false;

        _removeFromBook(orderId, order.pairId, order.side, order.price);

        uint256 unlockAmount = _computeLockAmount(order.side, order.amount, order.price);
        custodian.unlockFunds(order.client, order.tokenOut, unlockAmount);

        emit OrderCancelled(orderId, order.client);
    }

    /**
     * @notice Deactivate an NFT listing by ID
     * @dev The private version of the cancelNFTListing function, used for both cancellations and blacklist enforcement
     * @param listingId ID of the NFT listing to deactivate
     */
    function _deactivateListing(uint256 listingId) internal {
        NFTListing storage listing = _nftListings[listingId];
        listing.active = false;
        _activeListingByNFT[listing.collection][listing.tokenId] = 0;
        emit NFTListingCancelled(listingId, listing.seller);
    }

    /**
     * @notice Deactivate an NFT offer by ID
     * @dev The private version of the cancelNFTOffer function, used for both cancellations and blacklist enforcement
     * @param offerId ID of the NFT offer to deactivate
     */
    function _deactivateOffer(uint256 offerId) internal {
        NFTOffer storage offer = _nftOffers[offerId];
        offer.active = false;
        emit NFTOfferCancelled(offerId, offer.buyer);
    }

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

    // Get pending commit details by ID
    function getPendingCommit(uint256 commitId) external view returns (PendingCommit memory) {
        return _pendingCommits[commitId];
    }

    // Get active listing ID for a given NFT
    function getNFTListing(uint256 listingId) external view returns (NFTListing memory) {
        return _nftListings[listingId];
    }

    // Get active offer IDs for a given NFT
    function getNFTOffer(uint256 offerId) external view returns (NFTOffer memory) {
        return _nftOffers[offerId];
    }
}
