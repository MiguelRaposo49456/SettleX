// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IOrderBook {

    enum CommitType { Order, Take }

    struct Order {
        uint256 id;             // Unique order ID
        address client;         // Trader who created the order
        bytes32 pairId;         // Canonical ID for the token pair (hash of tokenIn and tokenOut addresses)
        address tokenIn;        // Token the user is buying
        address tokenOut;       // Token the user is selling
        uint256 price;          // Price expressed in tokenOut/tokenIn or the quote token for each base token like USDC per ETH
        uint256 amount;         // Amount of tokenIn the user wants to buy
        uint8 side;             // Buy or Sell side of the order
        bool active;            // Whether the order is active or has been filled/cancelled
        uint256 block;          // Block number when the order was created
        bool partialAllowed;    // Whether the order can be partially filled
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
}