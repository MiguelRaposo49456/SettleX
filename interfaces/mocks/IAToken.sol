// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IAToken {
    function underlying() external view returns (address);
}