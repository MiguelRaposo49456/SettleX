// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ICustodian {

    //-----------------------------------------------ERC20 Functions------------------------------------------------

    // Locks some funds from a client's available balance, moving them to locked balance 
    function lockFunds(address client, address token, uint256 amount) external;

    // Unlocks some funds from a client's locked balance, moving them back to available balance
    function unlockFunds(address client, address token, uint256 amount) external;

    // Performs an internal transfer between two clients updating their balances
    function internalTransfer(address from, address to, address token, uint256 amount) external;

    // Check available balance
    function balanceOf(address client, address token) external view returns (uint256);

    // Check locked balance
    function lockedBalanceOf(address client, address token) external view returns (uint256);


    //------------------------------------------------NFT Functions------------------------------------------------

    // Locks an NFT from a client's available balance, moving it to locked balance
    function lockNFT(address client, address collection, uint256 tokenId) external;

    // Unlocks an NFT from a client's locked balance, moving it back to available balance
    function unlockNFT(address client, address collection, uint256 tokenId) external;

    // Performs an internal transfer of an NFT between two clients updating their balances
    function internalTransferNFT(address from, address to, address collection, uint256 tokenId) external;

    // Check if the client holds or has locked a specific NFT
    function nftBalanceOf(address client, address collection, uint256 tokenId) external view returns (bool held, bool locked);
}