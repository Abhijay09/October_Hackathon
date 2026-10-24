// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A yield-bearing vault used by the attack suite. RBI's e₹ is non-remunerative, so an agent
///         must never be able to move wallet funds into something like this.
contract MockYieldVault {
    IERC20 public immutable asset;
    mapping(address => uint256) public deposits;

    constructor(IERC20 asset_) {
        asset = asset_;
    }

    function deposit(uint256 amount) external {
        asset.transferFrom(msg.sender, address(this), amount);
        deposits[msg.sender] += amount;
    }
}
