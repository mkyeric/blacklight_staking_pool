// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IRewardPolicy
/// @notice Minimal interface for the Nillion reward policy contract used by Blacklight nodes.
/// @dev    This contract streams NIL into per-recipient balances. A recipient calls `claim()`
///         to pull their currently accrued rewards.
interface IRewardPolicy {
    // ──────────────────────────────── Events ────────────────────────────────

    /// @notice Emitted when a recipient successfully claims rewards.
    event RewardClaimed(address indexed recipient, uint256 amount);

    // ──────────────────────────────── Claiming ─────────────────────────────

    /// @notice Claim all currently accrued rewards for msg.sender.
    /// @dev    Transfers `rewardToken` directly to msg.sender.
    function claim() external;

    // ──────────────────────────────── Views ────────────────────────────────

    /// @notice ERC-20 token used for rewards (expected to be NIL on Blacklight).
    function rewardToken() external view returns (IERC20);

    /// @notice Currently accrued (unclaimed) rewards for a recipient.
    function rewards(address recipient) external view returns (uint256);
}

