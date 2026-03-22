// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../interfaces/mocks/IMockLendingPool.sol";

/**
 * @notice Interest-bearing token representing a deposit in the MockLendingPool
 *         Each supported token has its own AToken
 * @dev Minted on supply, burned on withdraw. Only the MockLendingPool can mint/burn
 */
contract AToken is ERC20 {
    address public immutable pool;
    address public immutable underlying;

    error NotPool();

    modifier onlyPool() {
        if (msg.sender != pool) revert NotPool();
        _;
    }

    constructor(address _pool, address _underlying, string memory name, string memory symbol) ERC20(name, symbol) {
        pool = _pool;
        underlying = _underlying;
    }

    function mint(address to, uint256 amount) external onlyPool {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyPool {
        _burn(from, amount);
    }
}


/**
 * @notice Simplified lending pool that simulates Aave v3 behaviour
 */
contract MockLendingPool is IMockLendingPool {
    using SafeERC20 for IERC20;

    uint256 public constant RAY = 1e27;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant RATE_PRECISION = 10_000; // 100% = 10000 bps

    struct Pool {
        AToken  aToken;                              // interest-bearing token for this pool
        uint256 liquidityIndex;                      // starts at RAY, grows over time
        uint256 lastUpdateTimestamp;                 // last time index was updated
        uint256 interestRate;                        // fixed interest rate (e.g. 500 = 5%)
        mapping(address => uint256) scaledBalances;  // user => scaled deposit amount
        bool exists;                                 // guard against unregistered tokens
    }

    mapping(address => Pool) private _pools; // underlying token => Pool
    address[] public supportedTokens; // list of all registered tokens

    address public immutable admin;

    //--------------------------------------------Events--------------------------------------------
    event PoolAdded(address indexed token, address indexed aToken, uint256 interestRate);
    event Supplied(address indexed user, address indexed token, uint256 amount, uint256 scaledAmount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event YieldSimulated(address indexed token, uint256 oldIndex, uint256 newIndex);


    //--------------------------------------------Errors--------------------------------------------
    error NotAdmin();
    error PoolAlreadyExists(address token);
    error PoolNotFound(address token);
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance(uint256 available, uint256 requested);


    //--------------------------------------------Modifiers--------------------------------------------
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier poolExists(address token) {
        if (!_pools[token].exists) revert PoolNotFound(token);
        _;
    }


    //--------------------------------------------Constructor--------------------------------------------
    constructor() {
        admin = msg.sender;
    }


    //--------------------------------------------Admin functions----------------------------------------
    /**
     * @notice Register a new token pool with a fixed interest rate
     * @dev Deploys a new AToken contract for this pool
     * @param token Address of the underlying ERC20 token
     * @param interestRate Fixed interest rate: 500 = 5%
     * @param name Name for the aToken (e.g. "Aave USDC")
     * @param symbol Symbol for the aToken (e.g. "aUSDC")
     */
    function addPool(address token, uint256 interestRate, string calldata name, string calldata symbol) external onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
        if (_pools[token].exists) revert PoolAlreadyExists(token);

        AToken aToken = new AToken(address(this), token, name, symbol);

        Pool storage pool = _pools[token];
        pool.aToken = aToken;
        pool.liquidityIndex = RAY;
        pool.lastUpdateTimestamp = block.timestamp;
        pool.interestRate = interestRate;
        pool.exists = true;

        supportedTokens.push(token);

        emit PoolAdded(token, address(aToken), interestRate);
    }

    /**
     * @notice Inject funds into the pool to cover yield payments
     * @dev Simulates borrower interest payments in a real lending protocol
     */
    function addLiquidity(address token, uint256 amount) external onlyAdmin poolExists(token) {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }


    //----------------------------------------Simulated time functions-----------------------------------
    /**
     * @notice Manually advance the liquidity index for a token
     * @dev Simulates the passage of time without actually waiting
     *      In a real system this function would not exist
     * @param token Token pool to advance
     * @param secs Number of seconds to simulate
     */
    function simulateYield(address token, uint256 secs) external onlyAdmin poolExists(token) {
        Pool storage pool = _pools[token];

        uint256 oldIndex = pool.liquidityIndex;

        uint256 newIndex = _computeNewIndex(pool.liquidityIndex, pool.interestRate, secs);
        pool.liquidityIndex = newIndex;
        pool.lastUpdateTimestamp = block.timestamp;

        emit YieldSimulated(token, oldIndex, newIndex);
    }


    //--------------------------------------------User functions-----------------------------------------
    /**
     * @notice Supply tokens to the pool and receive aTokens
     * @dev Updates the liquidity index before computing the scaled amount
     *      Scaled amount = amount * RAY / currentIndex
     * @param token Underlying token to supply
     * @param amount Amount to supply
     * @param user Address of the user supplying the tokens
     */
    function supply(address token, uint256 amount, address user) external poolExists(token) returns (uint256) {
        if (amount == 0) revert ZeroAmount();

        Pool storage pool = _pools[token];

        // Update index before any balance changes
        _updateIndex(token);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        // Compute scaled amount — divides by current index to ensure that the future index growth becomes yield
        uint256 scaledAmount = (amount * RAY) / pool.liquidityIndex;
        pool.scaledBalances[user] += scaledAmount;

        // Mint aTokens to represent the deposit
        pool.aToken.mint(user, scaledAmount);

        emit Supplied(user, token, amount, scaledAmount);

        return scaledAmount;
    }

    /**
     * @notice Withdraw tokens from the pool and burn aTokens
     * @dev Updates the liquidity index before computing the actual amount.
     *      Actual amount = scaledBalance * currentIndex / RAY
     * @param token Underlying token to withdraw
     * @param scaledAmount Amount of underlying to withdraw (not scaled)
     * @param user Address of the user withdrawing the tokens
     * @return Actual amount withdrawn
     */
    function withdraw(address token, uint256 scaledAmount, address user) external poolExists(token) returns (uint256) {
        if (scaledAmount == 0) revert ZeroAmount();

        Pool storage pool = _pools[token];

        // Update index before any balance changes
        _updateIndex(token);

        uint256 scaledBalance = pool.scaledBalances[user];
        if (scaledBalance < scaledAmount) revert InsufficientBalance(scaledBalance, scaledAmount);

        pool.scaledBalances[user] -= scaledAmount;

        // Burn aTokens
        pool.aToken.burn(user, scaledAmount);

        uint256 actualAmount = (scaledAmount * pool.liquidityIndex) / RAY;
        IERC20(token).safeTransfer(user, actualAmount);

        emit Withdrawn(user, token, actualAmount);

        return actualAmount;
    }


    //----------------------------------------View functions -----------------------------------

    /**
     * @notice Get the current actual balance of a user for a token
     * @dev Includes yield accrued since last index update
     */
    function balanceOf(address token, address user) external view poolExists(token) returns (uint256) {
        Pool storage pool = _pools[token];
        uint256 currentIndex = _previewIndex(token);
        return (pool.scaledBalances[user] * currentIndex) / RAY;
    }

    /**
     * @notice Get the current liquidity index for a token
     */
    function getLiquidityIndex(address token) external view poolExists(token) returns (uint256) {
        return _previewIndex(token);
    }

    /**
     * @notice Get the aToken address for a token
     */
    function getAToken(address token) external view returns (address) {
        if (!_pools[token].exists) return address(0);
        return address(_pools[token].aToken);
    }

    /**
     * @notice Check if a token is supported
     */
    function isSupported(address token) external view returns (bool) {
        return _pools[token].exists;
    }

    /**
     * @notice Get all supported tokens
     */
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }


    //--------------------------------------------Internal functions-----------------------------------------

    /**
     * @notice Update the liquidity index for a token based on elapsed time
     * @dev Called before every supply/withdraw to ensure index is current.
     *      Index grows by: (index * interestRate * elapsed) / (RATE_PRECISION * SECONDS_PER_YEAR)
     */
    function _updateIndex(address token) internal {
        Pool storage pool = _pools[token];
        uint256 elapsed = block.timestamp - pool.lastUpdateTimestamp;

        if (elapsed == 0) return;

        pool.liquidityIndex = _computeNewIndex(pool.liquidityIndex, pool.interestRate, elapsed);
        pool.lastUpdateTimestamp = block.timestamp;
    }

    /**
     * @notice Compute a new index given current index, interest rate and elapsed seconds
     * @dev Uses simple interest approximation:
     *      newIndex = currentIndex + (currentIndex * interestRate * elapsed) / (RATE_PRECISION * SECONDS_PER_YEAR)
     */
    function _computeNewIndex(uint256 currentIndex, uint256 interestRate, uint256 elapsed) internal pure returns (uint256) {
        uint256 growth = (currentIndex * interestRate * elapsed) / (RATE_PRECISION * SECONDS_PER_YEAR);
        return currentIndex + growth;
    }

    /**
     * @notice Preview the current index without writing to storage
     * @dev Used in view functions to show accurate balances without state changes
     */
    function _previewIndex(address token) internal view returns (uint256) {
        Pool storage pool = _pools[token];
        uint256 elapsed = block.timestamp - pool.lastUpdateTimestamp;
        if (elapsed == 0) return pool.liquidityIndex;
        return _computeNewIndex(pool.liquidityIndex, pool.interestRate, elapsed);
    }
}
