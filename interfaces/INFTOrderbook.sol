// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface INFTOrderbook {

    enum CommitType { NFTList, NFTOffer }

    enum AssetType { ERC20, ERC721 }

    struct PendingCommit {
        bytes32 commitHash;
        address client;
        uint256 commitBlock;
        uint256 revealDeadline;
        bool revealed;
        bool expired;
        CommitType commitType;
    }

    struct NFTListing {
        uint256 listingId;
        address seller;
        address collection;
        uint256 tokenId;
        AssetType paymentType;
        address paymentToken;
        uint256 paymentAmount;
        uint256 paymentTokenId;
        bool active;
    }

    struct NFTOffer {
        uint256 offerId;
        address buyer;
        address collection;
        uint256 tokenId;
        AssetType offerType;
        address offerToken;
        uint256 offerAmount;
        uint256 offerTokenId;
        bool active;
    }

    // Commit and reveal functions for NFT listings and offers
    function commit(bytes32 commitHash, CommitType commitType) external returns (uint256 commitId);
    function revealNFTList(uint256 commitId, address collection, uint256 tokenId, AssetType paymentType, address paymentToken, uint256 paymentAmount, uint256 paymentTokenId, bytes32 salt) external;
    function revealNFTOffer(uint256 commitId, address collection, uint256 tokenId, AssetType offerType, address offerToken, uint256 offerAmount, uint256 offerTokenId, bytes32 salt) external;
    function expireCommit(uint256 commitId) external;

    // Functions to cancel or deactivate listings and offers
    function cancelNFTListing(uint256 listingId) external;
    function cancelNFTOffer(uint256 offerId) external;
    function deactivateListing(uint256 listingId) external;
    function deactivateOffer(uint256 offerId) external;

    // View functions to retrieve listings, offers, and pending commits
    function getNFTListing(uint256 listingId) external view returns (NFTListing memory);
    function getNFTOffer(uint256 offerId) external view returns (NFTOffer memory);
    function getPendingCommit(uint256 commitId) external view returns (PendingCommit memory);
    function getActiveListing(address collection, uint256 tokenId) external view returns (uint256 listingId);
}