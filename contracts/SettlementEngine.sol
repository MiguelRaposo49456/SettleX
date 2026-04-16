// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/ISettlementEngine.sol";
import "../interfaces/IComplianceManager.sol";
import "../interfaces/IFungibleOrderbook.sol";
import "../interfaces/INFTOrderbook.sol";
import "../interfaces/ICustodian.sol";
import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SettlementEngine is ISettlementEngine, AutomationCompatibleInterface, ReentrancyGuard {

    ICustodian public custodian;
    IFungibleOrderbook public fungibleOrderbook;
    INFTOrderbook public nftOrderbook;
    IComplianceManager public immutable complianceManager;

    bool public initialized;
    address public immutable admin;

    // -----------------------------------------------Batch Settlement------------------------------------------------
    
    struct PendingTrade {
        uint256 makerOrderId;
        uint256 takerOrderId;
        IFungibleOrderbook.Order takerOrder;
        uint256 executedAmount;
        bool settled;
    }

    struct PendingNFTTrade {
        uint256 listingId;
        uint256 offerId;
        bool settled;
    }

    // Operator-adjustable settlement window — minimum 1 minute enforced
    uint256 public settlementWindowSeconds;
    uint256 public constant MIN_SETTLEMENT_WINDOW = 1 minutes;

    // Operator-adjustable max batch size — bounded to prevent gas DoS
    uint256 public maxBatchSize;
    uint256 public constant MIN_BATCH_SIZE = 1;
    uint256 public constant MAX_BATCH_SIZE = 100;

    // Current open batch tracking
    uint256 public currentBatchId;
    uint256 public batchOpenedAt;

    // Storage for pending fungible and NFT trades per batch
    mapping(uint256 batchId => PendingTrade[]) private _pendingTrades;
    mapping(uint256 batchId => PendingNFTTrade[]) private _pendingNFTTrades;

    // Tracks the last settled batch so Chainlink / callers know what's next
    uint256 public lastSettledBatchId;


    //----------------------------------------------Events-----------------------------------------------------------
    event TradeExecuted(uint256 indexed makerOrderId, uint256 indexed takerOrderId, uint256 executedAmount);
    event TradeQueued(uint256 indexed batchId, uint256 indexed makerOrderId, uint256 indexed takerOrderId);
    event NFTTradeQueued(uint256 indexed batchId, uint256 indexed listingId, uint256 indexed offerId);
    event BatchSettled(uint256 indexed batchId, uint256 tradesSettled, uint256 nftTradesSettled);
    event BatchOpened(uint256 indexed batchId, uint256 openedAt);
    event TradeFailed(uint256 indexed batchId, uint256 indexed makerOrderId, uint256 indexed takerOrderId, string reason);
    event NFTTradeFailed(uint256 indexed batchId, uint256 indexed listingId, uint256 indexed offerId, string reason);
    event Initialized(address fungibleOrderBook, address nftOrderBook, address custodian);
    event InsufficientLockedBalance(uint256 lockedBalance, uint256 requiredAmount);
    event TokenBlacklisted();
    event UserBlacklisted(address user);
    event OrderNotActive(uint256 orderId);
    event NFTTradeExecuted(uint256 indexed listingId, uint256 indexed offerId, address collection, uint256 tokenId);
    event SettlementWindowUpdated(uint256 oldWindow, uint256 newWindow);
    event MaxBatchSizeUpdated(uint256 oldSize, uint256 newSize);
    event OrderInactive(uint256 orderId);
    event BothOrdersInactive(uint256 makerOrderId, uint256 takerOrderId);

    //----------------------------------------------Errors-----------------------------------------------------------
    error AlreadyInitialized();
    error NotAdmin();
    error NotInitialized();
    error NotOrderbook();
    error ListingNotActive();
    error OfferNotActive();
    error SystemPaused();
    error ZeroAddress();
    error WindowNotExpired();
    error BatchEmpty();
    error WindowTooShort();
    error BatchSizeOutOfBounds();
    error NotOperator();

    //---------------------------------------------Modifiers--------------------------------------------------------
    modifier onlyAuthorizedOrderBook() {
        if (msg.sender != address(fungibleOrderbook) && msg.sender != address(nftOrderbook))
            revert NotOrderbook();
        _;
    }

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

    modifier onlyOperator() {
        if (!complianceManager.hasOperatorRole(msg.sender)) revert NotOperator();
        _;
    }


    //----------------------------------------------Constructor-----------------------------------------------------
    constructor(address _complianceManager, uint256 _settlementWindowSeconds, uint256 _maxBatchSize) {
        if (_complianceManager == address(0)) revert ZeroAddress();
        if (_settlementWindowSeconds < MIN_SETTLEMENT_WINDOW) revert WindowTooShort();
        if (_maxBatchSize < MIN_BATCH_SIZE || _maxBatchSize > MAX_BATCH_SIZE) revert BatchSizeOutOfBounds();

        complianceManager = IComplianceManager(_complianceManager);
        admin = msg.sender;
        settlementWindowSeconds = _settlementWindowSeconds;
        maxBatchSize = _maxBatchSize;
    }


    //--------------------------------Initialization — resolves circular dependency---------------------------------
    /**
     * @notice Wire up Orderbook and Custodian after all three contracts are deployed
     * @dev Can only be called once by the admin. Opens the first batch immediately.
     */
    function initialize(
        address _fungibleOrderbook,
        address _nftOrderbook,
        address _custodian
    ) external onlyAdmin {
        if (initialized) revert AlreadyInitialized();
        if (_fungibleOrderbook == address(0) || _nftOrderbook == address(0) || _custodian == address(0))
            revert ZeroAddress();

        fungibleOrderbook = IFungibleOrderbook(_fungibleOrderbook);
        nftOrderbook = INFTOrderbook(_nftOrderbook);
        custodian = ICustodian(_custodian);
        initialized = true;

        // Open the first batch
        _openNewBatch();

        emit Initialized(_fungibleOrderbook, _nftOrderbook, _custodian);
    }


    //----------------------------------------------Operator Config-------------------------------------------------
    /**
     * @notice Update the settlement window duration
     * @dev Enforces a minimum of MIN_SETTLEMENT_WINDOW to prevent the window being set to 0
     * @param newWindow New window duration in seconds
     */
    function setSettlementWindow(uint256 newWindow) external onlyOperator {
        if (newWindow < MIN_SETTLEMENT_WINDOW) revert WindowTooShort();
        emit SettlementWindowUpdated(settlementWindowSeconds, newWindow);
        settlementWindowSeconds = newWindow;
    }

    /**
     * @notice Update the maximum number of trades per batch
     * @dev Bounded between MIN_BATCH_SIZE and MAX_BATCH_SIZE to prevent gas DoS or batching being defeated
     * @param newSize New max batch size
     */
    function setMaxBatchSize(uint256 newSize) external onlyOperator {
        if (newSize < MIN_BATCH_SIZE || newSize > MAX_BATCH_SIZE) revert BatchSizeOutOfBounds();
        emit MaxBatchSizeUpdated(maxBatchSize, newSize);
        maxBatchSize = newSize;
    }


    //----------------------------------------------Chainlink Automation--------------------------------------------
    /**
     * @notice Chainlink Automation check — returns true when the batch window has expired
     * and there are pending trades to settle
     */
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory) {
        upkeepNeeded = _batchReady();
    }

    /**
     * @notice Chainlink Automation entry point — settles the batch
     * @dev Re-validates the condition so that even if Chainlink calls this slightly early,
     * or anyone calls it directly as a permissionless fallback, nothing bad happens
     */
    function performUpkeep(bytes calldata) external override nonReentrant whenNotPaused whenInitialized {
        if (!_batchReady()) revert WindowNotExpired();
        _settleBatch();
    }

    /**
     * @notice Permissionless fallback — anyone can settle the batch once the window expires
     * @dev Identical to performUpkeep but with an explicit name for clarity
     */
    function settleBatch() external nonReentrant whenNotPaused whenInitialized {
        if (!_batchReady()) revert WindowNotExpired();
        _settleBatch();
    }


    //----------------------------------------------Queue Functions (called by Orderbooks)-------------------------

    /**
     * @notice Queue a matched fungible trade into the current batch
     * @param orderIdMaker    ID of the maker order
     * @param orderIdTaker    ID of the taker order stored in the orderbook
     * @param executedAmount  The amount that was deducted from both sides at match time
     */
    function executeTrade(
        uint256 orderIdMaker,
        uint256 orderIdTaker,
        uint256 executedAmount
    ) external onlyAuthorizedOrderBook whenNotPaused whenInitialized {
        IFungibleOrderbook.Order memory takerOrder = fungibleOrderbook.getOrder(orderIdTaker);

        _checkAndRollBatch();

        _pendingTrades[currentBatchId].push(PendingTrade({
            makerOrderId: orderIdMaker,
            takerOrderId: orderIdTaker,
            takerOrder: takerOrder,
            executedAmount: executedAmount,
            settled: false
        }));

        emit TradeQueued(currentBatchId, orderIdMaker, orderIdTaker);
    }

    /**
     * @notice Queue a direct (take) fungible trade into the current batch
     * @dev Called by FungibleOrderbook for revealTake flows where the taker order is not stored
     * @param makerOrderId    ID of the maker order
     * @param takerOrder      The taker order details provided inline
     * @param executedAmount  The amount that was deducted from the maker at match time
     */
    function executeDirectTrade(
        uint256 makerOrderId,
        IFungibleOrderbook.Order memory takerOrder,
        uint256 executedAmount
    ) external onlyAuthorizedOrderBook whenNotPaused whenInitialized {
        
        _checkAndRollBatch();

        _pendingTrades[currentBatchId].push(PendingTrade({
            makerOrderId: makerOrderId,
            takerOrderId: 0,
            takerOrder: takerOrder,
            executedAmount: executedAmount,
            settled: false
        }));

        emit TradeQueued(currentBatchId, makerOrderId, 0);
    }

    /**
     * @notice Queue a matched NFT trade into the current batch
     * @dev Called by NFTOrderbook after a match is found
     * @param listingId ID of the NFT listing
     * @param offerId   ID of the NFT offer
     */
    function executeNFTTrade(
        uint256 listingId,
        uint256 offerId
    ) external onlyAuthorizedOrderBook whenNotPaused whenInitialized {
       
        _checkAndRollBatch();

        _pendingNFTTrades[currentBatchId].push(PendingNFTTrade({
            listingId: listingId,
            offerId:   offerId,
            settled:   false
        }));

        emit NFTTradeQueued(currentBatchId, listingId, offerId);
    }


    //----------------------------------------------Internal Settlement---------------------------------------------

    /**
     * @notice Check if the current batch has hit its size cap and roll it over if so
     */
    function _checkAndRollBatch() internal {
        uint256 fungibleCount = _pendingTrades[currentBatchId].length;
        uint256 nftCount = _pendingNFTTrades[currentBatchId].length;

        if (fungibleCount + nftCount >= maxBatchSize) {
            _openNewBatch();
        }
    }

    /**
     * @notice Returns true when the active batch window has expired and the batch is non-empty
     */
    function _batchReady() internal view returns (bool) {
        uint256 fungibleCount = _pendingTrades[currentBatchId].length;
        uint256 nftCount = _pendingNFTTrades[currentBatchId].length;
        bool windowExpired = block.timestamp >= batchOpenedAt + settlementWindowSeconds;
        bool hasItems = (fungibleCount + nftCount) > 0;
        return windowExpired && hasItems;
    }

    /**
     * @notice Settle all trades in the oldest unsettled batch, then open a new one
     */
    function _settleBatch() internal {
        uint256 batchToSettle = lastSettledBatchId + 1;

        PendingTrade[] storage fungibleTrades = _pendingTrades[batchToSettle];
        PendingNFTTrade[] storage nftTrades = _pendingNFTTrades[batchToSettle];

        uint256 settledCount = 0;
        uint256 nftSettledCount = 0;

        for (uint256 i = 0; i < fungibleTrades.length; i++) {
            PendingTrade storage trade = fungibleTrades[i];
            if (trade.settled) continue;

            trade.settled = true;

            bool success = _executeFungibleTrade(trade.makerOrderId, trade.takerOrder, trade.takerOrderId, trade.executedAmount);

            if (success) {
                settledCount++;
            } else {
                emit TradeFailed(batchToSettle, trade.makerOrderId, trade.takerOrderId, "trade execution failed");
            }
        }

        for (uint256 i = 0; i < nftTrades.length; i++) {
            PendingNFTTrade storage nftTrade = nftTrades[i];
            if (nftTrade.settled) continue;

            nftTrade.settled = true;

            bool success = _executeNFTTrade(nftTrade.listingId, nftTrade.offerId);

            if (success) {
                nftSettledCount++;
            } else {
                emit NFTTradeFailed(batchToSettle, nftTrade.listingId, nftTrade.offerId, "nft trade execution failed");
            }
        }

        lastSettledBatchId = batchToSettle;

        if (batchToSettle == currentBatchId) {
            _openNewBatch();
        }

        emit BatchSettled(batchToSettle, settledCount, nftSettledCount);
    }

    /**
     * @notice Open a new batch and record when it was opened
     */
    function _openNewBatch() internal {
        currentBatchId++;
        batchOpenedAt = block.timestamp;
        emit BatchOpened(currentBatchId, batchOpenedAt);
    }

    /**
     * @notice Execute a single fungible trade
     * @dev Returns false instead of reverting so the batch loop can skip and continue
     */
    function _executeFungibleTrade(
        uint256 makerOrderId,
        IFungibleOrderbook.Order memory takerOrder,
        uint256 takerOrderId,
        uint256 executedAmount
    ) internal returns (bool) {
        IFungibleOrderbook.Order memory makerOrder = fungibleOrderbook.getOrder(makerOrderId);

        if (takerOrderId != 0) {
            takerOrder = fungibleOrderbook.getOrder(takerOrderId);
        }

        assert(makerOrder.tokenIn == takerOrder.tokenOut);
        assert(makerOrder.tokenOut == takerOrder.tokenIn);

        if(makerOrder.status == IFungibleOrderbook.Status.Inactive) {
            if(takerOrder.status != IFungibleOrderbook.Status.Inactive) {
                if(takerOrderId != 0) fungibleOrderbook.reinstateOrder(takerOrderId, executedAmount);
                else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
                emit OrderInactive(makerOrderId);
                return false;
            }
            else {
                emit BothOrdersInactive(makerOrderId, takerOrderId);
                return false;
            }
        }

        if(takerOrder.status != IFungibleOrderbook.Status.Inactive) {
            fungibleOrderbook.reinstateOrder(makerOrderId, executedAmount);
            emit OrderInactive(takerOrderId);
            return false;
        }

        // Re-validate token compliance — tokens could be blacklisted after queuing
        if (!complianceManager.isTokenAllowed(makerOrder.tokenIn) || !complianceManager.isTokenAllowed(takerOrder.tokenIn)) {
            fungibleOrderbook.cancelOrder(makerOrderId);
            if (takerOrderId != 0) fungibleOrderbook.cancelOrder(takerOrderId);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            emit TokenBlacklisted();
            return false;
        }

        // Re-validate user compliance — users could be blacklisted after queuing
        if (!complianceManager.isUserAllowed(makerOrder.client)) {
            fungibleOrderbook.cancelOrder(makerOrderId);
            if (takerOrderId != 0) fungibleOrderbook.reinstateOrder(takerOrderId, executedAmount);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            emit UserBlacklisted(makerOrder.client);
            return false;
        }

        if (!complianceManager.isUserAllowed(takerOrder.client)) {
            if (takerOrderId != 0) fungibleOrderbook.cancelOrder(takerOrderId);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            fungibleOrderbook.reinstateOrder(makerOrderId, executedAmount);
            emit UserBlacklisted(takerOrder.client);
            return false;
        }

        // Re-validate locked balances
        uint256 makerLocked = custodian.lockedBalanceOf(makerOrder.client, makerOrder.tokenOut);
        if (makerLocked < executedAmount) {
            fungibleOrderbook.cancelOrder(makerOrderId);
            if (takerOrderId != 0) fungibleOrderbook.reinstateOrder(takerOrderId, executedAmount);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerOrder.amount);
            emit InsufficientLockedBalance(makerLocked, executedAmount);
            return false;
        }

        uint256 takerLocked = custodian.lockedBalanceOf(takerOrder.client, takerOrder.tokenOut);
        if (takerLocked < executedAmount) {
            if (takerOrderId != 0) fungibleOrderbook.cancelOrder(takerOrderId);
            else custodian.unlockFunds(takerOrder.client, takerOrder.tokenOut, takerLocked);
            fungibleOrderbook.reinstateOrder(makerOrderId, executedAmount);
            emit InsufficientLockedBalance(takerLocked, executedAmount);
            return false;
        }

        // Execute both legs of the trade atomically
        custodian.internalTransfer(makerOrder.client, takerOrder.client, makerOrder.tokenOut, executedAmount);
        custodian.internalTransfer(takerOrder.client, makerOrder.client, takerOrder.tokenOut, executedAmount);

        fungibleOrderbook.updateOrder(makerOrderId);
        if (takerOrderId != 0) fungibleOrderbook.updateOrder(takerOrderId);

        emit TradeExecuted(makerOrderId, takerOrderId, executedAmount);
        return true;
    }

    /**
     * @notice Execute a single NFT trade
     * @dev Returns false instead of reverting so the batch loop can skip and continue
     */
    function _executeNFTTrade(uint256 listingId, uint256 offerId) internal returns (bool) {
        INFTOrderbook.NFTListing memory listing = nftOrderbook.getNFTListing(listingId);
        INFTOrderbook.NFTOffer memory offer = nftOrderbook.getNFTOffer(offerId);

        // Re-validate active state
        if (listing.status == INFTOrderbook.Status.Inactive) {
            emit NFTTradeFailed(currentBatchId, listingId, offerId, "listing not active");
            return false;
        }
        if (offer.status == INFTOrderbook.Status.Inactive) {
            emit NFTTradeFailed(currentBatchId, listingId, offerId, "offer not active");
            return false;
        }

        // Re-validate compliance
        if (!complianceManager.isTokenAllowed(listing.collection)) {
            nftOrderbook.cancelNFTListing(listingId);
            nftOrderbook.cancelNFTOffer(offerId);
            emit TokenBlacklisted();
            return false;
        }

        if (!complianceManager.isUserAllowed(listing.seller)) {
            nftOrderbook.cancelNFTListing(listingId);
            emit UserBlacklisted(listing.seller);
            return false;
        }

        if (!complianceManager.isUserAllowed(offer.buyer)) {
            nftOrderbook.cancelNFTOffer(offerId);
            emit UserBlacklisted(offer.buyer);
            return false;
        }

        // If payment is ERC-20
        if (listing.paymentType == INFTOrderbook.AssetType.ERC20) {
            custodian.internalTransferNFT(listing.seller, offer.buyer, listing.collection, listing.tokenId);
            custodian.internalTransfer(offer.buyer, listing.seller, listing.paymentToken, listing.paymentAmount);
            if (offer.offerAmount > listing.paymentAmount) {
                custodian.unlockFunds(offer.buyer, offer.offerToken, offer.offerAmount - listing.paymentAmount);
            }
        } else {
            custodian.internalTransferNFT(listing.seller, offer.buyer, listing.collection, listing.tokenId);
            custodian.internalTransferNFT(offer.buyer, listing.seller, offer.offerToken, offer.offerTokenId);
        }

        nftOrderbook.deactivateListing(listingId);
        nftOrderbook.deactivateOffer(offerId);

        emit NFTTradeExecuted(listingId, offerId, listing.collection, listing.tokenId);
        return true;
    }


    //----------------------------------------------View Functions--------------------------------------------------

    function getBatchSize(uint256 batchId) external view returns (uint256 fungible, uint256 nft) {
        fungible = _pendingTrades[batchId].length;
        nft = _pendingNFTTrades[batchId].length;
    }

    function timeUntilSettlement() external view returns (uint256) {
        uint256 expiry = batchOpenedAt + settlementWindowSeconds;
        if (block.timestamp >= expiry) return 0;
        return expiry - block.timestamp;
    }
}
