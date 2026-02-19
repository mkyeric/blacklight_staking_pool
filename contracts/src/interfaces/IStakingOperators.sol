// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStakingOperators
/// @notice Interface for the Nillion Blacklight staking-to-node contract.
/// @dev    Deployed at 0x89c1312Cedb0B0F67e4913D2076bd4a860652B69 on the Blacklight L2.
///         Only the approved staker for an operator can call stakeTo / requestUnstake / withdrawUnstaked.
interface IStakingOperators {
    // ──────────────────────────────── Structs ────────────────────────────────

    struct OperatorInfo {
        bool active;
        string metadataURI;
    }

    struct Tranche {
        uint256 amount;
        uint64 releaseTime;
    }

    // ──────────────────────────────── Events ─────────────────────────────────

    event StakedTo(address indexed staker, address indexed operator, uint256 amount);
    event StakerApproved(address indexed operator, address indexed staker);
    event UnstakeRequested(
        address indexed staker, address indexed operator, uint256 amount, uint64 releaseTime
    );
    event UnstakedWithdrawn(address indexed staker, address indexed operator, uint256 amount);

    // ──────────────────────────────── Errors ─────────────────────────────────

    error InsufficientStake();
    error NotStaker();
    error UnauthorizedStaker();
    error ZeroAmount();
    error ZeroAddress();

    // ─────────────────────── Staking (caller = approved staker) ──────────────

    /// @notice Stake `amount` NIL to `operator`. Caller must be the approved staker
    ///         and must have approved the staking contract on the NIL token first.
    function stakeTo(address operator, uint256 amount) external;

    /// @notice Begin unbonding `amount` NIL from `operator`. A tranche is created
    ///         with a release time = now + unstakeDelay().
    function requestUnstake(address operator, uint256 amount) external;

    /// @notice Withdraw all matured unbonding tranches for `operator`.
    ///         NIL is sent back to the caller.
    function withdrawUnstaked(address operator) external;

    // ─────────────────────── Operator management ─────────────────────────────

    /// @notice Called by the operator to approve `staker` as its sole staker.
    function approveStaker(address staker) external;

    // ─────────────────────── View functions ──────────────────────────────────

    /// @notice Total active (non-unbonding) NIL staked to `operator`.
    function stakeOf(address operator) external view returns (uint256);

    /// @notice The approved staker address for `operator`.
    function approvedStaker(address operator) external view returns (address);

    /// @notice The bound staker for `operator` (set on first stakeTo, persists after approvedStaker is cleared).
    function operatorStaker(address operator) external view returns (address);

    /// @notice Whether `operator` is currently active.
    function isActiveOperator(address operator) external view returns (bool);

    /// @notice Operator metadata.
    function getOperatorInfo(address operator) external view returns (OperatorInfo memory);

    /// @notice List of unbonding tranches for `operator`.
    function getUnbondingTranches(address operator) external view returns (Tranche[] memory);

    /// @notice The ERC-20 token used for staking (NIL).
    function stakingToken() external view returns (address);

    /// @notice Delay in seconds between requestUnstake and withdrawUnstaked.
    function unstakeDelay() external view returns (uint256);

    /// @notice Total NIL staked across all operators.
    function totalStaked() external view returns (uint256);

    /// @notice Staked amount for `operator` at a historical `snapshotId`.
    function stakeAt(address operator, uint64 snapshotId) external view returns (uint256);

    /// @notice List of all currently active operators.
    function getActiveOperators() external view returns (address[] memory);
}
