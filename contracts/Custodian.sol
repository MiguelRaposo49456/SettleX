// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/ICustodian.sol";
import "../interfaces/ITokenRegistry.sol";
import "../interfaces/IOrderbook.sol";


contract Custodian is ICustodian, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable settlementEngine;
    IOrderBook public immutable orderBook;
    ITokenRegistry public immutable tokenRegistry;


    //Available balance: client => token => amount
    mapping(address client => mapping(address token => uint256 amount)) private _balances;

    //Locked balance: client => token => amount
    mapping(address client => mapping(address token => uint256 amount)) private _lockedBalances;


    //----------------------------------------------Events-----------------------------------------------------------
    event Deposited(address indexed client, address indexed token, uint256 amount);
    event Withdrawn(address indexed client, address indexed token, uint256 amount);
    event FundsLocked(address indexed client, address indexed token, uint256 amount);
    event FundsUnlocked(address indexed client, address indexed token, uint256 amount);
    event InternalTransfer(address indexed from, address indexed to, address indexed token, uint256 amount);


    //----------------------------------------------Errors-----------------------------------------------------------
    error NotSettlementEngine();
    error NotOrderBook();
    error NotSettlementEngineOrOrderBook();
    error SystemPaused();
    error TokenNotAllowed(address token);
    error UserNotAllowed(address user);
    error UserCannotWithdraw(address user);
    error InsufficientBalance(uint256 available, uint256 requested);
    error InsufficientLockedBalance(uint256 locked, uint256 requested);
    error ZeroAmount();
    error ZeroAddress();

    
    //---------------------------------------------Modifiers--------------------------------------------------------

    // Only allows the SettlementEngine to call certain functions that move funds
    modifier onlySettlementEngine() {
        if (msg.sender != settlementEngine) revert NotSettlementEngine();
        _;
    }

    modifier onlyOrderBook() {
        if (msg.sender != address(orderBook)) revert NotOrderBook();
        _;
    }

    modifier onlySettlementEngineOrOrderBook() {
    if (msg.sender != settlementEngine && msg.sender != address(orderBook))
        revert NotSettlementEngineOrOrderBook();
    _;
}

    // Checks the OrderBook's paused state
    modifier whenNotPaused() {
        if (orderBook.paused()) revert SystemPaused();
        _;
    }


    //----------------------------------------------Constructor-----------------------------------------------------
    constructor(address _tokenRegistry, address _settlementEngine, address _orderBook) {
        if (_tokenRegistry == address(0) || _settlementEngine == address(0) || _orderBook == address(0))
            revert ZeroAddress();

        tokenRegistry    = ITokenRegistry(_tokenRegistry);
        settlementEngine = _settlementEngine;
        orderBook        = IOrderBook(_orderBook);
    }


    //----------------------------------------------Functions-------------------------------------------------------

    /**
     * @notice Deposit tokens into the vault, increasing available balance
     * @dev Clients can only deposit allowed tokens, needing to allow the transfer on their behalf first.
     * @param token  Address of the ERC-20 token to deposit
     * @param amount Amount to deposit
     */
    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (!tokenRegistry.isTokenAllowed(token)) revert TokenNotAllowed(token);
        if (!tokenRegistry.isUserAllowed(msg.sender)) revert UserNotAllowed(msg.sender);

        // Effects
        _balances[msg.sender][token] += amount;

        // Interactions
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, token, amount);
    }


    /**
     * @notice Withdraw available (unlocked) tokens from the vault
     * @dev Locked funds cannot be withdrawn while their order is open
     *      Blacklisted users cannot withdraw (regulatory freeze)
     *      Pattern: Checks -> Effects -> Interactions
     * @param token  Address of the ERC-20 token
     * @param amount Amount to withdraw
     */
    function withdraw(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (!tokenRegistry.canUserWithdraw(msg.sender)) revert UserCannotWithdraw(msg.sender);

        uint256 available = _balances[msg.sender][token];
        if (available < amount) revert InsufficientBalance(available, amount);

        // Effects
        _balances[msg.sender][token] = available - amount;

        // Interactions
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, token, amount);
    }


    /**
     * @notice Lock funds for a pending order, moving them from available to locked
     * @dev Called by the Orderbook when an order is submitted
     * @param client Address of the client
     * @param token  Token to lock
     * @param amount Amount to lock
     */
    function lockFunds(address client, address token, uint256 amount) external onlyOrderBook whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        uint256 available = _balances[client][token];
        if (available < amount) revert InsufficientBalance(available, amount);

        // Effects
        _balances[client][token] = available - amount;
        _lockedBalances[client][token] += amount;

        emit FundsLocked(client, token, amount);
    }


    /**
     * @notice Unlock previously locked funds, returning them to available balance
     * @dev Called by the Orderbook when an order is cancelled and by the SettlementEngine when the settlement fails
     * @param client Address of the client
     * @param token  Token to unlock
     * @param amount Amount to unlock
     */
    function unlockFunds(address client, address token, uint256 amount) external onlySettlementEngineOrOrderBook whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        uint256 locked = _lockedBalances[client][token];
        if (locked < amount) revert InsufficientLockedBalance(locked, amount);

        // Effects
        _lockedBalances[client][token] = locked - amount;
        _balances[client][token] += amount;

        emit FundsUnlocked(client, token, amount);
    }


    /**
     * @notice Transfer locked funds from one client to another's available balance
     * @dev Called by the SettlementEngine after a valid match is confirmed
     *      Debits `from`'s locked balance and credits `to`'s available balance —
     *      no funds are created or destroyed
     * @param from   Client giving the tokens
     * @param to     Client receiving the tokens
     * @param token  Token being transferred
     * @param amount Amount to transfer
     */
    function internalTransfer(address from, address to, address token, uint256 amount) external onlySettlementEngine whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        uint256 locked = _lockedBalances[from][token];
        if (locked < amount) revert InsufficientLockedBalance(locked, amount);

        // Effects — no external calls, purely internal accounting
        _lockedBalances[from][token] = locked - amount;
        _balances[to][token] += amount;

        emit InternalTransfer(from, to, token, amount);
    }

    //----------------------------------------------- View Functions ----------------------------------------------------

    // Available balance for a client and token
    function balanceOf(address client, address token) external view returns (uint256) {
        return _balances[client][token];
    }

    // Locked balance for a client and token
    function lockedBalanceOf(address client, address token) external view returns (uint256) {
        return _lockedBalances[client][token];
    }

    // Available and locked balances in a single call
    function fullBalanceOf(address client, address token) external view returns (uint256 available, uint256 locked) {
        available = _balances[client][token];
        locked    = _lockedBalances[client][token];
        return (available, locked); //? could be removed
    }
}
