// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@uniswap/v2-periphery/contracts/interfaces/IWETH.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "../interfaces/ICustodian.sol";
import "../interfaces/IComplianceManager.sol";
import "../interfaces/IFungibleOrderbook.sol";
import "../interfaces/INFTOrderbook.sol";
import "../interfaces/mocks/IMockLendingPool.sol";
import "../interfaces/mocks/IAToken.sol";


contract Custodian is ICustodian, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    address public constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    address public settlementEngine;
    IFungibleOrderbook public fungibleOrderbook;
    INFTOrderbook public nftOrderbook;
    IComplianceManager public immutable complianceManager;
    IMockLendingPool public immutable lendingPool;
    IWETH public immutable weth;

    bool public initialized;
    address public immutable admin;

    //Available balance: client => token => amount
    mapping(address client => mapping(address token => uint256 amount)) private _balances;

    //Locked balance: client => token => amount
    mapping(address client => mapping(address token => uint256 amount)) private _lockedBalances;

    // Available NFTs: client => collection => tokenId => held
    mapping(address client => mapping(address collection => mapping(uint256 tokenId => bool))) private _nftHoldings;

    // Locked NFTs: client => collection => tokenId => locked
    mapping(address client => mapping(address collection => mapping(uint256 tokenId => bool))) private _lockedNFTs;


    //---------------------------------------------Withdrawal Queue--------------------------------------------------
    uint256 public constant MAX_QUEUE_PROCESS = 5;

    struct WithdrawalRequest {
        address client;
        address token;
        uint256 amount;
        uint256 requestedAt;
        bool receiveETH;
    }

    WithdrawalRequest[] public withdrawalQueue;
    uint256 public queueHead;


    //----------------------------------------------Events-----------------------------------------------------------
    event Deposited(address indexed client, address indexed token, uint256 amount);
    event Withdrawn(address indexed client, address indexed token, uint256 amount);
    event FundsLocked(address indexed client, address indexed token, uint256 amount);
    event FundsUnlocked(address indexed client, address indexed token, uint256 amount);
    event InternalTransfer(address indexed from, address indexed to, address indexed token, uint256 amount);
    event Initialized(address fungibleOrderBook, address nftOrderBook, address settlementEngine);
    event WithdrawalQueued(address indexed client, address indexed token, uint256 amount, bool receiveETH);
    event WithdrawalProcessed(address indexed client, address indexed token, uint256 amount, bool receiveETH);
    event NFTDeposited(address indexed client, address indexed collection, uint256 tokenId);
    event NFTWithdrawn(address indexed client, address indexed collection, uint256 tokenId);
    event NFTLocked(address indexed client, address indexed collection, uint256 tokenId);
    event NFTUnlocked(address indexed client, address indexed collection, uint256 tokenId);
    event NFTInternalTransfer(address indexed from, address indexed to, address indexed collection, uint256 tokenId);


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

    modifier onlyAuthorizedOrderBook() {
        if (msg.sender != address(fungibleOrderbook) && msg.sender != address(nftOrderbook))
            revert NotOrderbook();
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
    function initialize(address _fungibleOrderBook, address _nftOrderBook, address _settlementEngine) external onlyAdmin {
        if (initialized) revert AlreadyInitialized();
        if (_fungibleOrderBook == address(0) || _nftOrderBook == address(0) || _settlementEngine == address(0)) revert ZeroAddress();

        settlementEngine = _settlementEngine;
        fungibleOrderbook = IFungibleOrderbook(_fungibleOrderBook);
        nftOrderbook = INFTOrderbook(_nftOrderBook);
        initialized = true;

        emit Initialized(_fungibleOrderBook, _nftOrderBook, _settlementEngine);
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

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Supply to lending pool if token is supported
        address aToken = lendingPool.getAToken(token);
        if (aToken != address(0)) {
            IERC20(token).approve(address(lendingPool), amount);
            uint256 scaledAmount = lendingPool.supply(token, amount, address(this));
            _balances[msg.sender][aToken] += scaledAmount;
        }
        else {
            _balances[msg.sender][token] += amount;
        }

        _processWithdrawalQueue();

        emit Deposited(msg.sender, token, amount);
    }


    /**
     * @notice Withdraw available (unlocked) tokens from the vault
     * @dev Locked funds cannot be withdrawn while their order is open
     *      Blacklisted users cannot withdraw (regulatory freeze)
     * @param token Address of the token
     * @param amount Amount to withdraw
     * @param receiveETH Whether to receive ETH (if withdrawing WETH)
     */
    function withdraw(address token, uint256 amount, bool receiveETH) external nonReentrant whenNotPaused whenInitialized {
        if (amount == 0) revert ZeroAmount();
        if (!complianceManager.canUserWithdraw(msg.sender)) revert UserCannotWithdraw(msg.sender);

        uint256 available = _balances[msg.sender][token];
        if (available < amount) revert InsufficientBalance(available, amount);

        _processWithdrawalQueue();

        _balances[msg.sender][token] -= amount;

        if (_isAToken(token)) {
            address underlying = IAToken(token).underlying();
            bool success = _tryWithdraw(underlying, amount, address(this), msg.sender, receiveETH);
            if (success) {
                emit Withdrawn(msg.sender, token, amount);
            } else {
                _enqueue(msg.sender, token, amount, receiveETH);
            }
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
            emit Withdrawn(msg.sender, token, amount);
        }
    }

    //------------------------------NFT Deposit and Withdrawal Functions---------------------------------------------
    /**
     * @notice Deposit an NFT, increasing available balance
     * @param collection Address of the NFT collection
     * @param tokenId ID of the NFT to deposit
     */
    function depositNFT(address collection, uint256 tokenId) external nonReentrant whenNotPaused whenInitialized {
        if (!complianceManager.isTokenAllowed(collection)) revert TokenNotAllowed(collection);
        if (!complianceManager.isUserAllowed(msg.sender))  revert UserNotAllowed(msg.sender);
        
        //NFTs are held 1:1
        IERC721(collection).safeTransferFrom(msg.sender, address(this), tokenId);
        _nftHoldings[msg.sender][collection][tokenId] = true;

        emit NFTDeposited(msg.sender, collection, tokenId);
    }

    /**
    * @notice Withdraw an NFT, decreasing available balance
    * @param collection Address of the NFT collection
    * @param tokenId ID of the NFT to withdraw
    */
    function withdrawNFT(address collection, uint256 tokenId) external nonReentrant whenNotPaused whenInitialized {
        if (!complianceManager.canUserWithdraw(msg.sender)) revert UserCannotWithdraw(msg.sender);
        if (!_nftHoldings[msg.sender][collection][tokenId]) revert InsufficientBalance(0, 1);

        _nftHoldings[msg.sender][collection][tokenId] = false;
        IERC721(collection).safeTransferFrom(address(this), msg.sender, tokenId);

        emit NFTWithdrawn(msg.sender, collection, tokenId);
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

        address aToken = lendingPool.getAToken(address(weth));
        if (aToken != address(0)) {
            // Wrap ETH to WETH
            weth.deposit{value: msg.value}();

            IERC20(address(weth)).approve(address(lendingPool), msg.value);
            uint256 scaledAmount = lendingPool.supply(address(weth), msg.value, address(this));

            _balances[msg.sender][aToken] += scaledAmount;
        } else {
            _balances[msg.sender][ETH] += msg.value;
        }

        _processWithdrawalQueue();

        emit Deposited(msg.sender, ETH, msg.value);
    }

    /**
     * @notice Withdraw native ETH from the vault
     * @dev Only works when WETH pool does not exist in the lending pool
     * @param amount Amount of ETH to withdraw (in wei)
     */
    function withdrawETH(uint256 amount) external nonReentrant whenNotPaused whenInitialized {
        if (amount == 0) revert ZeroAmount();
        if (!complianceManager.canUserWithdraw(msg.sender)) revert UserCannotWithdraw(msg.sender);

        uint256 available = _balances[msg.sender][ETH];
        if (available < amount) revert InsufficientBalance(available, amount);

        _processWithdrawalQueue();

        // Effects
        _balances[msg.sender][ETH] -= amount;

        // Interactions
        (bool sent, ) = msg.sender.call{value: amount}("");
        if (!sent) revert ETHTransferFailed();

        emit Withdrawn(msg.sender, ETH, amount);
    }


    //------------------------------------------NFT Locking Functions--------------------------------------------
    /**
     * @notice Lock an NFT, moving it from available to locked
     * @param client Address of the client
     * @param collection Address of the NFT collection
     * @param tokenId ID of the NFT to lock
     */
    function lockNFT(address client, address collection, uint256 tokenId) external onlyAuthorizedOrderBook whenNotPaused whenInitialized {
        if (!_nftHoldings[client][collection][tokenId]) revert InsufficientBalance(0, 1);

        _nftHoldings[client][collection][tokenId] = false;
        _lockedNFTs[client][collection][tokenId]  = true;

        emit NFTLocked(client, collection, tokenId);
    }

    /**
    * @notice Unlock a previously locked NFT, moving it back to available
    * @param client Address of the client
    * @param collection Address of the NFT collection
    * @param tokenId ID of the NFT to unlock
    */
    function unlockNFT(address client, address collection, uint256 tokenId) external onlyAuthorizedOrderBook whenNotPaused whenInitialized {
        if (!_lockedNFTs[client][collection][tokenId]) revert InsufficientLockedBalance(0, 1);

        _lockedNFTs[client][collection][tokenId]  = false;
        _nftHoldings[client][collection][tokenId] = true;

        emit NFTUnlocked(client, collection, tokenId);
    }


    //---------------------------------------Fungible Funds Locking Functions--------------------------------------
    /**
     * @notice Lock funds for a pending order, moving them from available to locked
     * @dev Called by the Orderbook when an order is submitted
     * @param client Address of the client
     * @param token  Token to lock
     * @param amount Amount to lock
     */
    function lockFunds(address client, address token, uint256 amount) external onlyAuthorizedOrderBook whenNotPaused whenInitialized {
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
    function unlockFunds(address client, address token, uint256 amount) external onlyAuthorizedOrderBook whenNotPaused whenInitialized {
        if (amount == 0) revert ZeroAmount();

        uint256 locked = _lockedBalances[client][token];
        if (locked < amount) revert InsufficientLockedBalance(locked, amount);

        // Effects
        _lockedBalances[client][token] = locked - amount;
        _balances[client][token] += amount;

        emit FundsUnlocked(client, token, amount);
    }

    //----------------------------------------Internal Transfer Function--------------------------------------
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

    /**
     * @notice Transfer a locked NFT from one client to another's available balance
     * @dev Called by the SettlementEngine after a valid match is confirmed
     *      Debits `from`'s locked NFT and credits `to`'s available NFTs
     * @param from Client giving the NFT
     * @param to Client receiving the NFT
     * @param collection Address of the NFT collection
     * @param tokenId ID of the NFT being transferred
     */
    function internalTransferNFT(
        address from,
        address to, 
        address collection, 
        uint256 tokenId
    ) external onlySettlementEngine whenNotPaused whenInitialized {
        if (!_lockedNFTs[from][collection][tokenId]) revert InsufficientLockedBalance(0, 1);

        _lockedNFTs[from][collection][tokenId] = false;
        _nftHoldings[to][collection][tokenId] = true;

        emit NFTInternalTransfer(from, to, collection, tokenId);
    }


    //----------------------------------------------Withdraw Queue Functions---------------------------------------------
    function _tryWithdraw(address token, uint256 amount, address from, address to, bool receiveETH) internal returns (bool) {
        try lendingPool.withdraw(token, amount, from) returns (uint256 actualAmount) {
            if (token == address(weth) && receiveETH) {
                // Unwrap WETH → ETH → send to user
                weth.withdraw(actualAmount);
                (bool sent, ) = to.call{value: actualAmount}("");
                if (!sent) revert ETHTransferFailed();
            } else {
                IERC20(token).safeTransfer(to, actualAmount);
            }
            return true;
        } catch {
            return false;
        }
    }

    function _processWithdrawalQueue() internal {
        uint256 processed = 0;
        while (queueHead < withdrawalQueue.length && processed < MAX_QUEUE_PROCESS) {
            WithdrawalRequest storage req = withdrawalQueue[queueHead];
            address underlying = IAToken(req.token).underlying();
            bool success = _tryWithdraw(underlying, req.amount, address(this), req.client, req.receiveETH);
            if (!success) break;
            queueHead++;
            processed++;
            emit WithdrawalProcessed(req.client, underlying, req.amount, req.receiveETH);
        }
    }

    function _enqueue(address client, address token, uint256 amount, bool receiveETH) internal {
        withdrawalQueue.push(WithdrawalRequest({
            client: client,
            token: token,
            amount: amount,
            requestedAt: block.timestamp,
            receiveETH: receiveETH
        }));
        emit WithdrawalQueued(client, token, amount, receiveETH);
    }


    //----------------------------------------------Internal Functions---------------------------------------------------
    /**
     * @notice Check if an address is an aToken by trying to call underlying()
     */
    function _isAToken(address token) internal view returns (bool) {
        try IAToken(token).underlying() returns (address) {
            return true;
        } catch {
            return false;
        }
    }


    //----------------------------------------------- View Functions ----------------------------------------------------
    /**
     * @notice Available balance for a client and token
     */
    function balanceOf(address client, address token) external view returns (uint256) {
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

    function nftBalanceOf(address client, address collection, uint256 tokenId) external view returns (bool held, bool locked) {
        held = _nftHoldings[client][collection][tokenId];
        locked = _lockedNFTs[client][collection][tokenId];
    }

    //----------------------------------------------- Fallback -----------------------------------------------------
    /**
     * @notice Reject direct ETH transfers — use depositETH() instead
     * @dev This prevents accidental ETH sends from being lost
     */
    receive() external payable {
        if (msg.sender != address(weth)) revert("Use depositETH()");
    }

    //--------------------------------------------- ERC721 Receiver ------------------------------------------------
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}