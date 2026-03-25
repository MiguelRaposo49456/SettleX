// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/ISettlementEngine.sol";
import "../interfaces/IComplianceManager.sol";
import "../interfaces/IOrderbook.sol";
import "../interfaces/ICustodian.sol";

contract SettlementEngine is ISettlementEngine {
    
    ICustodian public custodian;
    IOrderBook public orderBook;
    IComplianceManager public immutable complianceManager;

    bool public initialized;
    address public immutable admin;


    //----------------------------------------------Events-----------------------------------------------------------
    event TradeExecuted(uint256 indexed orderIdMaker, uint256 indexed orderIdTaker, uint256 executedAmount);
    event Initialized(address orderbook, address custodian);
    event InsufficientLockedBalance(uint256 lockedBalance, uint256 requiredAmount);
    event TokenBlacklisted();
    event UserBlacklisted();
    event NFTTradeExecuted(uint256 indexed listingId, uint256 indexed offerId, address collection, uint256 tokenId);

    //----------------------------------------------Errors-----------------------------------------------------------
    error AlreadyInitialized();
    error NotAdmin();
    error NotInitialized();
    error NotOrderBook();
    error SystemPaused();
    error ZeroAddress();

    //---------------------------------------------Modifiers--------------------------------------------------------

    // Only allows the Orderbook to call the functions
    modifier onlyOrderBook() {
        if (msg.sender != address(orderBook)) revert NotOrderBook();
        _;
    }

    // Checks the OrderBook's paused state
    modifier whenNotPaused() {
        if (complianceManager.isSystemPaused()) revert SystemPaused();
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
    constructor(address _complianceManager) {
        if (_complianceManager == address(0)) revert ZeroAddress();

        complianceManager = IComplianceManager(_complianceManager);
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
        if (!complianceManager.isTokenAllowed(makerOrder.tokenIn) || !complianceManager.isTokenAllowed(takerOrder.tokenIn)) {
            orderBook.cancelOrder(makerOrderId);
            if (takerOrderId != 0) orderBook.cancelOrder(takerOrderId);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            emit TokenBlacklisted();
            return;
        }

        // Check maker user — if blacklisted cancel maker only, taker order stays active
        if (!complianceManager.isUserAllowed(makerOrder.client)) {
            orderBook.cancelOrder(makerOrderId);
            if (takerOrderId == 0) custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            emit UserBlacklisted();
            return;
        }

        // Check taker user — if blacklisted cancel taker only, maker order stays active
        if (!complianceManager.isUserAllowed(takerOrder.client)) {
            if (takerOrderId != 0) orderBook.cancelOrder(takerOrderId);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            emit UserBlacklisted();
            return;
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
            emit InsufficientLockedBalance(makerLocked, executedAmount);
            return;
        }

        // Check taker has enough locked funds for the executed amount
        uint256 takerLocked = custodian.lockedBalanceOf(takerOrder.client, takerOrder.tokenOut);
        if (takerLocked < executedAmount) {
            if (takerOrderId != 0) orderBook.cancelOrder(takerOrderId);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerLocked);
            emit InsufficientLockedBalance(takerLocked, executedAmount);
            return;
        }

        // Execute both legs of the trade atomically
        custodian.internalTransfer(makerOrder.client, takerOrder.client, makerOrder.tokenOut, executedAmount);
        custodian.internalTransfer(takerOrder.client, makerOrder.client, takerOrder.tokenOut, executedAmount);

        // Update remaining amounts in the OrderBook
        // Each order's new remaining = old amount - executedAmount
        orderBook.updateOrderAmount(makerOrderId, makerOrder.amount - executedAmount);

        // Update taker amount only if it has a stored order
        if (takerOrderId != 0) {
            orderBook.updateOrderAmount(takerOrderId, takerOrder.amount - executedAmount);
        }

        emit TradeExecuted(makerOrderId, takerOrderId, executedAmount);
    }

    //-------------------------------------------NFT Trades-------------------------------------------------------
    /**
     * @notice Executes a trade between an NFT listing and an offer
     * @param listingId The ID of the NFT listing
     * @param offerId The ID of the NFT offer
     */
    function executeNFTTrade(uint256 listingId, uint256 offerId) external onlyOrderBook whenNotPaused whenInitialized {
        IOrderBook.NFTListing memory listing = orderBook.getNFTListing(listingId);
        IOrderBook.NFTOffer   memory offer   = orderBook.getNFTOffer(offerId);

        if (!complianceManager.isTokenAllowed(listing.collection)) {
            orderBook.cancelNFTListing(listingId);
            orderBook.cancelNFTOffer(offerId);
            emit TokenBlacklisted();
            return;
        }

        if (!complianceManager.isUserAllowed(listing.seller)) {
            orderBook.cancelNFTListing(listingId);
            emit UserBlacklisted();
            return;
        }

        if (!complianceManager.isUserAllowed(offer.buyer)) {
            orderBook.cancelNFTOffer(offerId);
            emit UserBlacklisted();
            return;
        }

        // If payment is ERC-20
        if (listing.paymentType == IOrderBook.AssetType.ERC20) {
            // NFT goes from seller to buyer
            custodian.internalTransferNFT(listing.seller, offer.buyer, listing.collection, listing.tokenId);
            // ERC-20 goes from buyer to seller
            custodian.internalTransfer(offer.buyer, listing.seller, listing.paymentToken, listing.paymentAmount);
            // Refund overpayment if offer exceeded the ask
            if (offer.offerAmount > listing.paymentAmount) {
                custodian.unlockFunds(offer.buyer, offer.offerToken, offer.offerAmount - listing.paymentAmount);
            }

        // If payment is another NFT
        } else {
            // Listing NFT goes from seller to buyer
            custodian.internalTransferNFT(listing.seller, offer.buyer, listing.collection, listing.tokenId);
            // Offer NFT goes from buyer to seller
            custodian.internalTransferNFT(offer.buyer, listing.seller,offer.offerToken, offer.offerTokenId);
        }

        // Deactivate both sides without unlocking since ownership has already been transferred
        orderBook.deactivateListing(listingId);
        orderBook.deactivateOffer(offerId);

        emit NFTTradeExecuted(listingId, offerId, listing.collection, listing.tokenId);
    }
}