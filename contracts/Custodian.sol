// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@uniswap/v2-periphery/contracts/interfaces/IWETH.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/ICustodian.sol";
import "../interfaces/IComplianceManager.sol";
import "../interfaces/IOrderbook.sol";
import "../interfaces/mocks/IMockLendingPool.sol";


contract Custodian is ICustodian, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    address public settlementEngine;
    IOrderBook public orderBook;
    IComplianceManager public immutable complianceManager;
    IMockLendingPool public immutable lendingPool;
    IWETH public immutable weth;

    bool public initialized;
    address public immutable admin;

    //Available balance: client => token => amount
    mapping(address client => mapping(address token => uint256 amount)) private _balances;

    //Locked balance: client => token => amount
    mapping(address client => mapping(address token => uint256 amount)) private _lockedBalances;


    //---------------------------------------------Withdrawal Queue--------------------------------------------------
    uint256 public constant MAX_QUEUE_PROCESS = 5;

    struct WithdrawalRequest {
        address client;
        address token;
        uint256 amount;
        uint256 requestedAt;
    }

    WithdrawalRequest[] public withdrawalQueue;
    uint256 public queueHead;


    //----------------------------------------------Events-----------------------------------------------------------
    event Deposited(address indexed client, address indexed token, uint256 amount);
    event Withdrawn(address indexed client, address indexed token, uint256 amount);
    event FundsLocked(address indexed client, address indexed token, uint256 amount);
    event FundsUnlocked(address indexed client, address indexed token, uint256 amount);
    event InternalTransfer(address indexed from, address indexed to, address indexed token, uint256 amount);
    event Initialized(address orderbook, address settlementEngine);
    event WithdrawalQueued(address indexed client, address indexed token, uint256 amount);
    event WithdrawalProcessed(address indexed client, address indexed token, uint256 amount);


    //----------------------------------------------Errors-----------------------------------------------------------
    error AlreadyInitialized();
    error ETHTransferFailed();
    error NotAdmin();
    error NotInitialized();
    error NotSettlementEngine();
    error NotOrderbook();
    error SystemPaused();
    error TokenNotAllowed(address token);
    error UserNotAllowed(address user);
    error UserCannotWithdraw(address user);
    error InsufficientBalance(uint256 available, uint256 requested);
    error InsufficientLockedBalance(uint256 locked, uint256 requested);
    error ZeroAmount();
    error ZeroAddress();

    
    //---------------------------------------------Modifiers--------------------------------------------------------

    // Only allows the SettlementEngine to call the functions
    modifier onlySettlementEngine() {
        if (msg.sender != settlementEngine) revert NotSettlementEngine();
        _;
    }

    // Only allows the Orderbook to call the functions
    modifier onlyOrderBook() {
        if (msg.sender != address(orderBook)) revert NotOrderbook();
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
    constructor(address _complianceManager, address _lendingPool, address _weth) {
        if (_complianceManager == address(0)) revert ZeroAddress();
        if (_lendingPool == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();

        complianceManager = IComplianceManager(_complianceManager);
        lendingPool = IMockLendingPool(_lendingPool);
        weth = IWETH(_weth);
        admin = msg.sender;
    }


    //--------------------------------Initialization — resolves circular dependency---------------------------------
    /**
     * @notice Wire up Orderbook and SettlementEngine after all three contracts are deployed
     * @dev Can only be called once by the admin
     */
    function initialize(address _orderBook, address _settlementEngine) external onlyAdmin {
        if (initialized) revert AlreadyInitialized();
        if (_orderBook == address(0) || _settlementEngine == address(0)) revert ZeroAddress();

        settlementEngine = _settlementEngine;
        orderBook = IOrderBook(_orderBook);
        initialized = true;

        emit Initialized(_orderBook, _settlementEngine);
    }

    //----------------------------------------------Functions-------------------------------------------------------

    /**
     * @notice Deposit tokens into the vault, increasing available balance
     * @dev Clients can only deposit allowed tokens, needing to allow the transfer on their behalf first.
     * @param token  Address of the token to deposit
     * @param amount Amount to deposit
     */
    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused whenInitialized {
        if (amount == 0) revert ZeroAmount();
        if (!complianceManager.isTokenAllowed(token)) revert TokenNotAllowed(token);
        if (!complianceManager.isUserAllowed(msg.sender)) revert UserNotAllowed(msg.sender);

        // Effects
        _balances[msg.sender][token] += amount;

        // Interactions
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Supply to lending pool if token is supported
        address aToken = lendingPool.getAToken(token);
        if (aToken != address(0)) {
            IERC20(token).approve(address(lendingPool), amount);
            lendingPool.supply(token, amount, msg.sender);
        }

        _processWithdrawalQueue();

        emit Deposited(msg.sender, token, amount);
    }


    /**
     * @notice Withdraw available (unlocked) tokens from the vault
     * @dev Locked funds cannot be withdrawn while their order is open
     *      Blacklisted users cannot withdraw (regulatory freeze)
     *      Pattern: Checks -> Effects -> Interactions
     * @param token Address of the token
     * @param amount Amount to withdraw
     */
    function withdraw(address token, uint256 amount) external nonReentrant whenNotPaused whenInitialized {
        if (amount == 0) revert ZeroAmount();
        if (!complianceManager.canUserWithdraw(msg.sender)) revert UserCannotWithdraw(msg.sender);

        uint256 available = _balances[msg.sender][token];
        if (available < amount) revert InsufficientBalance(available, amount);

        _processWithdrawalQueue();

        // Effects
        _balances[msg.sender][token] = available - amount;

        address aToken = lendingPool.getAToken(token);
        if (aToken != address(0)) {
            bool success = _tryWithdraw(token, amount, msg.sender);
            if (success) {
                emit Withdrawn(msg.sender, token, amount);
            } else {
                _enqueue(msg.sender, token, amount);
            }
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
            emit Withdrawn(msg.sender, token, amount);
        }
    }


    //----------------------------------------------ETH Functions---------------------------------------------------
    /**
     * @notice Deposit native ETH into the vault, increasing available ETH balance
     * @dev Same compliance checks as ERC20 deposits apply.
     */
    function depositETH() external payable nonReentrant whenNotPaused whenInitialized {
        if (msg.value == 0) revert ZeroAmount();
        if (!complianceManager.isTokenAllowed(ETH)) revert TokenNotAllowed(ETH);
        if (!complianceManager.isUserAllowed(msg.sender)) revert UserNotAllowed(msg.sender);

        // Effects only — ETH is already in the contract via msg.value
        _balances[msg.sender][ETH] += msg.value;

        // Supply WETH to lending pool
        address aToken = lendingPool.getAToken(address(weth));
        if (aToken != address(0)) {
            // Wrap ETH to WETH
            weth.deposit{value: msg.value}();

            IERC20(address(weth)).approve(address(lendingPool), msg.value);
            lendingPool.supply(address(weth), msg.value, msg.sender);
        }

        _processWithdrawalQueue();

        emit Deposited(msg.sender, ETH, msg.value);
    }


    /**
     * @notice Withdraw native ETH from the vault
     * @dev Uses call{value} instead of transfer to avoid gas stipend issues.
     *      Same compliance checks as ERC20 withdrawals apply.
     * @param amount Amount of ETH to withdraw (in wei)
     */
    function withdrawETH(uint256 amount) external nonReentrant whenNotPaused whenInitialized {
        if (amount == 0) revert ZeroAmount();
        if (!complianceManager.canUserWithdraw(msg.sender)) revert UserCannotWithdraw(msg.sender);

        uint256 available = _balances[msg.sender][ETH];
        if (available < amount) revert InsufficientBalance(available, amount);

        _processWithdrawalQueue();

        // Effects
        _balances[msg.sender][ETH] = available - amount;

        address aToken = lendingPool.getAToken(address(weth));
        if (aToken != address(0)) {
            bool succeed = _tryWithdraw(ETH, amount, msg.sender);
            if (succeed) {
                emit Withdrawn(msg.sender, ETH, amount);
            } else {
                _enqueue(msg.sender, ETH, amount);
            }
        } else {
            // Interactions — low-level call is the safe way to send ETH post EIP-1884
            (bool sent, ) = msg.sender.call{value: amount}("");
            if (!sent) revert ETHTransferFailed();
            emit Withdrawn(msg.sender, ETH, amount);
        }
    }


    /**
     * @notice Lock funds for a pending order, moving them from available to locked
     * @dev Called by the Orderbook when an order is submitted
     * @param client Address of the client
     * @param token  Token to lock
     * @param amount Amount to lock
     */
    function lockFunds(address client, address token, uint256 amount) external onlyOrderBook whenNotPaused whenInitialized {
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
    function unlockFunds(address client, address token, uint256 amount) external onlyOrderBook whenNotPaused whenInitialized {
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
    function internalTransfer(
        address from,
        address to, 
        address token, 
        uint256 amount
    ) external onlySettlementEngine whenNotPaused whenInitialized {
        if (amount == 0) revert ZeroAmount();

        uint256 locked = _lockedBalances[from][token];
        if (locked < amount) revert InsufficientLockedBalance(locked, amount);

        // Effects — no external calls, purely internal accounting
        _lockedBalances[from][token] = locked - amount;
        _balances[to][token] += amount;

        emit InternalTransfer(from, to, token, amount);
    }


    //----------------------------------------------Withdraw Queue Functions---------------------------------------------
    function _tryWithdraw(address token, uint256 amount, address recipient) internal returns (bool) {
        if (token == ETH) {
            try lendingPool.withdraw(address(weth), amount, address(this)) {
                weth.withdraw(amount);
                (bool sent, ) = recipient.call{value: amount}("");
                if (!sent) revert ETHTransferFailed();
                return true;
            } catch {
                return false;
            }
        } else {
            try lendingPool.withdraw(token, amount, recipient) {
                return true;
            } catch {
                return false;
            }
        }
    }

    function _processWithdrawalQueue() internal {
        uint256 processed = 0;
        while (queueHead < withdrawalQueue.length && processed < MAX_QUEUE_PROCESS) {
            WithdrawalRequest storage req = withdrawalQueue[queueHead];
            bool success = _tryWithdraw(req.token, req.amount, req.client);
            if (!success) break;
            queueHead++;
            processed++;
            emit WithdrawalProcessed(req.client, req.token, req.amount);
        }
    }

    function _enqueue(address client, address token, uint256 amount) internal {
        withdrawalQueue.push(WithdrawalRequest({
            client: client,
            token: token,
            amount: amount,
            requestedAt: block.timestamp
        }));
        emit WithdrawalQueued(client, token, amount);
    }


    //----------------------------------------------- View Functions ----------------------------------------------------

    /**
     * @notice Available balance for a client and token
     */
    function balanceOf(address client, address token) external view returns (uint256) {
        address aToken = lendingPool.getAToken(token == ETH ? address(weth) : token);
        if (aToken != address(0)) {
            // Real balance is in lending pool — includes yield
            return lendingPool.balanceOf(token == ETH ? address(weth) : token, client);
        }
        // Token held directly in Custodian
        return _balances[client][token];
    }

    /** 
     * @notice Locked balance for a client and token
     */
    function lockedBalanceOf(address client, address token) external view returns (uint256) {
        return _lockedBalances[client][token];
    }

    /**
     * @notice Full balance (available + locked) for a client and token
     */
    function fullBalanceOf(address client, address token) external view returns (uint256 available, uint256 locked) {
        available = _balances[client][token];
        locked = _lockedBalances[client][token];
    }

    //----------------------------------------------- Fallback -----------------------------------------------------
    /**
     * @notice Reject direct ETH transfers — use depositETH() instead
     * @dev This prevents accidental ETH sends from being lost
     */
    receive() external payable {
        if (msg.sender != address(weth)) revert("Use depositETH()");
    }
}
