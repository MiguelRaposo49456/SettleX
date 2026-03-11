// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../interfaces/IComplianceManager.sol";

contract ComplianceManager is IComplianceManager, AccessControl, Pausable {
    
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    mapping(address => UserStatus) public userStatus;
    mapping(address => bool) public blacklistedTokens;

    //----------------------------------------------Events-----------------------------------------------------------
    event TokenBlacklisted(address indexed token);
    event TokenUnblacklisted(address indexed token);
    event UserStatusUpdated(address indexed user, UserStatus status);


    //----------------------------------------------Constructor-----------------------------------------------------
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }


    //----------------------------------------------Circuit Breaker-------------------------------------------------
    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }

    function isSystemPaused() external view returns (bool) {
        return paused();
    }


    //----------------------------------------------Functions-------------------------------------------------------
    /**
     * @notice Blacklist a token, preventing it from being used in the system
     * @param _token Address of the token to blacklist
     */
    function blacklistToken(address _token) external onlyRole(OPERATOR_ROLE) {
        blacklistedTokens[_token] = true;
        emit TokenBlacklisted(_token);
    }

    /**
    * @notice Unblacklist a token, allowing it to be used in the system again
    * @param _token Address of the token to unblacklist
    */
    function unblacklistToken(address _token) external onlyRole(OPERATOR_ROLE) {
        blacklistedTokens[_token] = false;
        emit TokenUnblacklisted(_token);
    }

    /** 
     * @notice Check if a token is allowed in the system
     * @param _token Address of the token to check
     * @return True if the token is allowed, false if it is blacklisted
     */
    function isTokenAllowed(address _token) external view returns (bool) {
        return !blacklistedTokens[_token];
    }

    /**
     * @notice Set the status of a user (Allowed, BlacklistedWithWithdrawal, Blacklisted)
     * @param _user Address of the user
     * @param _status New status for the user
     */
    function setUserStatus(address _user, UserStatus _status) external onlyRole(OPERATOR_ROLE) {
        userStatus[_user] = _status;
        emit UserStatusUpdated(_user, _status);
    }

    /**
    * @notice Check if a user is allowed to interact with the system
    * @param _user Address of the user to check
    * @return True if the user is allowed, false if they are blacklisted
    */
    function isUserAllowed(address _user) external view returns (bool) {
        return userStatus[_user] == UserStatus.Allowed;
    }

    /**
     * @notice Check if a user can withdraw funds from the system
     * @param _user Address of the user to check
     * @return True if the user can withdraw, false if they are fully blacklisted
     */
    function canUserWithdraw(address _user) external view returns (bool) {
        return userStatus[_user] != UserStatus.Blacklisted;
    }
}