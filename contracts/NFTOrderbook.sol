// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/INFTOrderbook.sol";
import "../interfaces/ICustodian.sol";
import "../interfaces/ISettlementEngine.sol";
import "../interfaces/IComplianceManager.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";


contract NFTOrderbook is INFTOrderbook {

    uint256 public constant NFT_REVEAL_WINDOW = 20; // ~4 min

    IComplianceManager public immutable complianceManager;
    ICustodian public custodian;
    ISettlementEngine public settlementEngine;

    bool public initialized;
    address public immutable admin;

    // NFT Listings by ID
    mapping(uint256 => NFTListing) private _nftListings;

    // NFT Offers by ID
    mapping(uint256 => NFTOffer) private _nftOffers;

    // Index: collection => tokenId => listingId (0 = no active listing)
    mapping(address => mapping(uint256 => uint256)) private _activeListingByNFT;

    // Index: collection => tokenId => offerId[]
    mapping(address => mapping(uint256 => uint256[])) private _offersByNFT;

    // Commit-reveal storage
    mapping(uint256 => PendingCommit) private _pendingCommits;

    uint256 private _nextListingId; // starts at 1
    uint256 private _nextOfferId;   // starts at 1
    uint256 private _nextCommitId;


    //----------------------------------------------Events-----------------------------------------------------------
    event NFTListed(uint256 indexed listingId, address indexed seller, address indexed collection, uint256 tokenId);
    event NFTOfferMade(uint256 indexed offerId, address indexed buyer, address indexed collection, uint256 tokenId);
    event NFTListingCancelled(uint256 indexed listingId, address indexed seller);
    event NFTOfferCancelled(uint256 indexed offerId, address indexed buyer);
    event NFTTradeMatched(uint256 indexed listingId, uint256 indexed offerId);
    event Initialized(address custodian, address settlementEngine);
    event Committed(uint256 indexed commitId, address indexed client, uint256 commitBlock);
    event CommitExpired(uint256 indexed commitId, address indexed client);


    //----------------------------------------------Errors-----------------------------------------------------------
    error AlreadyInitialized();
    error CollectionNotAllowed(address collection);
    error CommitAlreadyRevealed();
    error CommitAndRevealOnSameBlock();
    error CommitExpiredError(uint256 commitId);
    error CommitHashMismatch();
    error CommitNotFound(uint256 commitId);
    error NotAdmin();
    error NotCommitOwner(uint256 commitId);
    error NotInitialized();
    error NotOrderOwner(uint256 id);
    error NotSettlementEngine();
    error NotActive(uint256 id);
    error RevealWindowOpen(uint256 commitId);
    error SystemPaused();
    error TokenNotAllowed();
    error UserNotAllowed(address user);
    error WrongCommitType(uint256 commitId);
    error ZeroAddress();


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
        _nextListingId = 1;
        _nextOfferId   = 1;
    }


    //--------------------------------Initialization — resolves circular dependency---------------------------------
    /**
     * @notice Wire up Custodian and SettlementEngine after all contracts are deployed
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


    //----------------------------------------------Commit-Reveal---------------------------------------------------
    /**
     * @notice Phase 1 — submit a hash of your NFT operation without revealing its contents
     * @param commitHash Hash of the operation parameters + secret salt
     * @param commitType NFTList or NFTOffer
     * @return commitId ID to reference in reveal functions
     */
    function commit(bytes32 commitHash, CommitType commitType) external whenNotPaused whenInitialized returns (uint256 commitId) {
        commitId = _nextCommitId++;

        _pendingCommits[commitId] = PendingCommit({
            commitHash:     commitHash,
            client:         msg.sender,
            commitBlock:    block.number,
            revealDeadline: block.number + NFT_REVEAL_WINDOW,
            revealed:       false,
            commitType:     commitType
        });

        emit Committed(commitId, msg.sender, block.number);
    }

    /**
     * @notice Phase 2 (listing) — reveal NFT listing parameters that match your earlier commit
     * @param commitId ID returned by commit()
     * @param collection Address of the NFT collection
     * @param tokenId Token ID of the NFT to list
     * @param paymentType Whether the payment is in ERC-20 or another NFT
     * @param paymentToken ERC-20 address, or NFT collection address if NFT-for-NFT
     * @param paymentAmount Amount of ERC-20 requested (0 if NFT-for-NFT)
     * @param paymentTokenId Token ID of the desired NFT (only if NFT-for-NFT)
     * @param salt Secret random value used when computing the commit hash
     */
    function revealNFTList(
        uint256 commitId,
        address collection,
        uint256 tokenId,
        AssetType paymentType,
        address paymentToken,
        uint256 paymentAmount,
        uint256 paymentTokenId,
        bytes32 salt
    ) external whenNotPaused whenInitialized {
        PendingCommit storage pending = _pendingCommits[commitId];

        if (pending.client == address(0)) revert CommitNotFound(commitId);
        if (msg.sender != pending.client) revert NotCommitOwner(commitId);
        if (pending.commitType != CommitType.NFTList) revert WrongCommitType(commitId);
        if (pending.revealed) revert CommitAlreadyRevealed();
        if (block.number == pending.commitBlock) revert CommitAndRevealOnSameBlock();
        if (block.number > pending.revealDeadline) {
            revert CommitExpiredError(commitId);
        }

        bytes32 expectedHash = keccak256(abi.encodePacked(
            msg.sender, collection, tokenId,
            paymentType, paymentToken, paymentAmount, paymentTokenId,
            salt
        ));

        if (expectedHash != pending.commitHash) revert CommitHashMismatch();

        pending.revealed = true;

        // Compliance checks
        if (!complianceManager.isTokenAllowed(collection)) revert CollectionNotAllowed(collection);
        if (!complianceManager.isUserAllowed(msg.sender)) revert UserNotAllowed(msg.sender);
        if (!complianceManager.isTokenAllowed(paymentToken)) revert TokenNotAllowed();

        // Lock the NFT being listed
        custodian.lockNFT(msg.sender, collection, tokenId);

        uint256 listingId = _nextListingId++;
        _nftListings[listingId] = NFTListing({
            listingId:      listingId,
            seller:         msg.sender,
            collection:     collection,
            tokenId:        tokenId,
            paymentType:    paymentType,
            paymentToken:   paymentToken,
            paymentAmount:  paymentAmount,
            paymentTokenId: paymentTokenId,
            active:         true
        });

        _activeListingByNFT[collection][tokenId] = listingId;

        // Attempt immediate match against existing offers
        _matchNFTListing(listingId);

        emit NFTListed(listingId, msg.sender, collection, tokenId);
    }

    /**
     * @notice Phase 2 (offer) — reveal NFT offer parameters that match your earlier commit
     * @param commitId ID returned by commit()
     * @param collection Address of the NFT collection the buyer wants
     * @param tokenId Token ID the buyer wants
     * @param offerType Whether the offer is ERC-20 or another NFT
     * @param offerToken ERC-20 address, or NFT collection address if NFT-for-NFT
     * @param offerAmount Amount of ERC-20 offered (0 if NFT-for-NFT)
     * @param offerTokenId Token ID being offered (only if NFT-for-NFT)
     * @param salt Secret random value used when computing the commit hash
     */
    function revealNFTOffer(
        uint256 commitId,
        address collection,
        uint256 tokenId,
        AssetType offerType,
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
            revert CommitExpiredError(commitId);
        }

        bytes32 expectedHash = keccak256(abi.encodePacked(
            msg.sender, collection, tokenId,
            offerType, offerToken, offerAmount, offerTokenId,
            salt
        ));

        if (expectedHash != pending.commitHash) revert CommitHashMismatch();

        pending.revealed = true;

        // Compliance checks
        if (!complianceManager.isUserAllowed(msg.sender)) revert UserNotAllowed(msg.sender);
        if (!complianceManager.isTokenAllowed(collection)) revert CollectionNotAllowed(collection);
        if (!complianceManager.isTokenAllowed(offerToken)) revert TokenNotAllowed();

        // Lock the payment
        if (offerType == AssetType.ERC20) {
            custodian.lockFunds(msg.sender, offerToken, offerAmount);
        } else {
            custodian.lockNFT(msg.sender, offerToken, offerTokenId);
        }

        uint256 offerId = _nextOfferId++;
        _nftOffers[offerId] = NFTOffer({
            offerId:      offerId,
            buyer:        msg.sender,
            collection:   collection,
            tokenId:      tokenId,
            offerType:    offerType,
            offerToken:   offerToken,
            offerAmount:  offerAmount,
            offerTokenId: offerTokenId,
            active:       true
        });

        _offersByNFT[collection][tokenId].push(offerId);

        // Check if there's an active listing this offer satisfies
        uint256 listingId = _activeListingByNFT[collection][tokenId];
        if (listingId != 0) _matchNFTOffer(listingId, offerId);

        emit NFTOfferMade(offerId, msg.sender, collection, tokenId);
    }


    //----------------------------------------------Cancel Functions-------------------------------------------------
    /**
     * @notice Cancel an active NFT listing and return the locked NFT to the seller
     * @param listingId ID of the listing to cancel
     */
    function cancelNFTListing(uint256 listingId) external whenInitialized {
        NFTListing storage listing = _nftListings[listingId];

        if (!listing.active) revert NotActive(listingId);
        if (msg.sender != listing.seller && msg.sender != address(settlementEngine)) revert NotOrderOwner(listingId);

        _deactivateListing(listingId);
        custodian.unlockNFT(listing.seller, listing.collection, listing.tokenId);
    }

    /**
     * @notice Cancel an active NFT offer and return the locked payment to the buyer
     * @param offerId ID of the offer to cancel
     */
    function cancelNFTOffer(uint256 offerId) external whenInitialized {
        NFTOffer storage offer = _nftOffers[offerId];

        if (!offer.active) revert NotActive(offerId);
        if (msg.sender != offer.buyer && msg.sender != address(settlementEngine)) revert NotOrderOwner(offerId);

        _deactivateOffer(offerId);
        if (offer.offerType == AssetType.ERC20) {
            custodian.unlockFunds(offer.buyer, offer.offerToken, offer.offerAmount);
        } else {
            custodian.unlockNFT(offer.buyer, offer.offerToken, offer.offerTokenId);
        }
    }

    /**
     * @notice Deactivate a listing from the orderbook
     * @param listingId ID of the listing to deactivate
     */
    function deactivateListing(uint256 listingId) external onlySettlementEngine whenInitialized {
        _deactivateListing(listingId);
    }

    /**
     * @notice Deactivate an offer from the orderbook
     * @param offerId ID of the offer to deactivate
     */
    function deactivateOffer(uint256 offerId) external onlySettlementEngine whenInitialized {
        _deactivateOffer(offerId);
    }


    //----------------------------------------------Internal Matching------------------------------------------------
    /**
     * @notice Match a new listing against existing offers — picks the best ERC-20 offer
     * @param listingId ID of the new listing
     */
    function _matchNFTListing(uint256 listingId) internal {
        NFTListing storage listing = _nftListings[listingId];
        uint256[] storage offerIds = _offersByNFT[listing.collection][listing.tokenId];

        uint256 bestOfferId = 0;
        uint256 bestAmount = 0;

        for (uint256 i = 0; i < offerIds.length; i++) {
            NFTOffer storage offer = _nftOffers[offerIds[i]];
            if (!offer.active) continue;
            if (!_offersMatch(listing, offer)) continue;

            // NFT-for-NFT where there is only one possible correct match
            if (listing.paymentType == AssetType.ERC721) {
                emit NFTTradeMatched(listingId, offerIds[i]);
                settlementEngine.executeNFTTrade(listingId, offerIds[i]);
                return;
            }

            // ERC-20 to find the highest offer
            if (offer.offerAmount > bestAmount) {
                bestAmount  = offer.offerAmount;
                bestOfferId = offerIds[i];
            }
        }

        if (bestOfferId != 0) {
            emit NFTTradeMatched(listingId, bestOfferId);
            settlementEngine.executeNFTTrade(listingId, bestOfferId);
        }
    }

    /**
     * @notice Match a new offer against the active listing for the same NFT
     * @param listingId ID of the existing listing
     * @param offerId ID of the new offer
     */
    function _matchNFTOffer(uint256 listingId, uint256 offerId) internal {
        NFTListing storage listing = _nftListings[listingId];
        NFTOffer storage offer = _nftOffers[offerId];

        if (_offersMatch(listing, offer)) {
            emit NFTTradeMatched(listingId, offerId);
            settlementEngine.executeNFTTrade(listingId, offerId);
        }
    }

    /**
     * @notice Check if a given offer satisfies the listing's ask
     * @param listing The NFT listing to check against
     * @param offer The NFT offer to check
     */
    function _offersMatch(NFTListing storage listing, NFTOffer storage offer) internal view returns (bool) {
        if (listing.paymentType != offer.offerType) return false;

        if (listing.paymentType == AssetType.ERC20) {
            return offer.offerToken == listing.paymentToken && offer.offerAmount >= listing.paymentAmount;
        } else {
            return offer.offerToken == listing.paymentToken && offer.offerTokenId == listing.paymentTokenId;
        }
    }

    /**
     * @notice Mark a listing as inactive and clear the index
     */
    function _deactivateListing(uint256 listingId) internal {
        NFTListing storage listing = _nftListings[listingId];
        
        listing.active = false;
        _activeListingByNFT[listing.collection][listing.tokenId] = 0;

        emit NFTListingCancelled(listingId, listing.seller);
    }

    /**
     * @notice Mark an offer as inactive
     */
    function _deactivateOffer(uint256 offerId) internal {
        NFTOffer storage offer = _nftOffers[offerId];
        offer.active = false;

        emit NFTOfferCancelled(offerId, offer.buyer);
    }


    //----------------------------------------------View Functions---------------------------------------------------
    function getNFTListing(uint256 listingId) external view returns (NFTListing memory) {
        return _nftListings[listingId];
    }

    function getNFTOffer(uint256 offerId) external view returns (NFTOffer memory) {
        return _nftOffers[offerId];
    }

    function getPendingCommit(uint256 commitId) external view returns (PendingCommit memory) {
        return _pendingCommits[commitId];
    }

    function getActiveListing(address collection, uint256 tokenId) external view returns (uint256 listingId) {
        return _activeListingByNFT[collection][tokenId];
    }
}