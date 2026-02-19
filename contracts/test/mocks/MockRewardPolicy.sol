// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IRewardPolicy} from "../../src/interfaces/IRewardPolicy.sol";

/// @title MockRewardPolicy
/// @notice Minimal mock of the reward policy used for testing BlacklightPool.
contract MockRewardPolicy is IRewardPolicy {
    IERC20 public immutable token;

    mapping(address => uint256) internal _rewards;

    constructor(address _token) {
        token = IERC20(_token);
    }

    /// @notice Test helper to set rewards for an address.
    function setRewards(address recipient, uint256 amount) external {
        _rewards[recipient] = amount;
    }

    /// @inheritdoc IRewardPolicy
    function claim() external override {
        uint256 amount = _rewards[msg.sender];
        if (amount == 0) return;
        _rewards[msg.sender] = 0;
        token.transfer(msg.sender, amount);
        emit RewardClaimed(msg.sender, amount);
    }

    /// @inheritdoc IRewardPolicy
    function rewardToken() external view override returns (IERC20) {
        return token;
    }

    /// @inheritdoc IRewardPolicy
    function rewards(address recipient) external view override returns (uint256) {
        return _rewards[recipient];
    }
}

