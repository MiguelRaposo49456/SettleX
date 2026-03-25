// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IOrderBook {

    enum CommitType { Order, Take, NFTList, NFTOffer }

    struct PendingCommit {
        bytes32 commitHash;
        address client;
        uint256 commitBlock;
        uint256 revealDeadline;
        bool revealed;
        bool expired;
        CommitType commitType;
    }

    struct Order {
        uint256 id;             // Unique order ID
        address client;         // Trader who created the order
        uint8 side;             // Buy or Sell side of the order
        bool active;            // Whether the order is active or has been filled/cancelled
        bool partialAllowed;    // Whether the order can be partially filled
        bytes32 pairId;         // Canonical ID for the token pair (hash of tokenIn and tokenOut addresses)
        address tokenIn;        // Token the user is receiving
        address tokenOut;       // Token the user is giving
        uint256 price;          // Price expressed in tokenOut/tokenIn or the quote token for each base token like USDC per ETH
        uint256 amount;         // Amount of tokenIn the user wants to buy
        uint256 block;          // Block number when the order was created
    }


    enum AssetType { ERC20, ERC721 }

    struct NFTListing {
        uint256 listingId;
        address seller;
        address collection;
        uint256 tokenId;
        AssetType paymentType;                          // Type of payment: ERC20 or ERC721
        address paymentToken;                           // ERC-20 or NFT collection address
        uint256 paymentAmount;                          // in paymentToken units (0 if paying with NFT)
        uint256 paymentTokenId;                         // only meaningful if paymentType is an ERC721
        bool active;
    }

    struct NFTOffer {
        uint256 offerId;
        address buyer;
        address collection;                             // collection they want to buy into
        uint256 tokenId;                                // specific token ID they want
        AssetType offerType;                            // Type of offer: ERC20 or ERC721
        address offerToken;                             // ERC-20 or NFT collection address
        uint256 offerAmount;                            // ERC-20 amount (0 if NFT offer)
        uint256 offerTokenId;                           // only if offerType is an ERC721
        bool active;
    }


    // Allows a user to submit a commit for either a place order or a take order
    function commit(bytes32 commitHash, CommitType commitType) external returns (uint256 commitId);

    // Reveal a previously committed order
    function revealOrder(
        uint256 commitId,
        address tokenIn,
        address tokenOut,
        uint256 price,
        uint256 amount,
        uint8 side,
        bool partialAllowed,
        bytes32 salt
    ) external;

    // Reveal a previously committed take order
    function revealTake(
        uint256 commitId,
        uint256 makerOrderId,
        uint256 takerAmount,
        bytes32 salt
    ) external;

    // Cancel an active order and unlock its funds
    function cancelOrder(uint256 orderId) external;

    // Called by the SettlementEngine after a trade to update remaining amount
    function updateOrderAmount(uint256 orderId, uint256 remainingAmount) external;

    // Returns the full Order struct for a given ID
    function getOrder(uint256 orderId) external view returns (Order memory);

    // Returns the full PendingCommit struct for a given commit ID
    function getPendingCommit(uint256 commitId) external view returns (PendingCommit memory);

    // Creates a new NFT listing
    function getNFTListing(uint256 listingId) external view returns (NFTListing memory);
    
    // Creates a new NFT offer
    function getNFTOffer(uint256 offerId) external view returns (NFTOffer memory);
    
    // Cancels an active NFT listing and unlocks the NFT
    function cancelNFTListing(uint256 listingId) external;
    
    // Cancels an active NFT offer and unlocks the offered asset
    function cancelNFTOffer(uint256 offerId) external;
    
    // Internal functions to deactivate listings without unlocking
    function deactivateListing(uint256 listingId) external;
    
    // Internal functions to deactivate offers without unlocking
    function deactivateOffer(uint256 offerId) external;
}