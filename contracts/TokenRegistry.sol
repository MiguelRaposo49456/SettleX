// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/ITokenRegistry.sol";

contract TokenRegistry is ITokenRegistry {
    
    mapping(address => UserStatus) public userStatus;
    mapping(address => bool) public blacklistedTokens;

    // Events
    event TokenBlacklisted(address indexed token);
    event TokenUnblacklisted(address indexed token);

    event UserStatusUpdated(address indexed user, UserStatus status);

    // Token Management

    function blacklistToken(address _token) external {
        blacklistedTokens[_token] = true;
        emit TokenBlacklisted(_token);
    }

    function unblacklistToken(address _token) external {
        blacklistedTokens[_token] = false;
        emit TokenUnblacklisted(_token);
    }

    function isTokenAllowed(address _token) external view returns (bool) {
        return !blacklistedTokens[_token];
    }

    // User Management

    function setUserStatus(address _user, UserStatus _status) external {
        userStatus[_user] = _status;
        emit UserStatusUpdated(_user, _status);
    }

    function isUserAllowed(address _user) external view returns (bool) {
        return userStatus[_user] == UserStatus.Allowed;
    }

    function canUserWithdraw(address _user) external view returns (bool) {
        return userStatus[_user] != UserStatus.Blacklisted;
    }
}