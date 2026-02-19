// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStakingOperators} from "../../src/interfaces/IStakingOperators.sol";

/// @title  MockStakingOperators
/// @notice Simplified mock of the Blacklight StakingOperators contract.
///         Implements the subset used by BlacklightPool so we can run local
///         tests without forking the L2.
contract MockStakingOperators is IStakingOperators {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public _unstakeDelay;

    // operator → approved staker
    mapping(address => address) public _approvedStakers;

    // operator → bound staker (set on first stakeTo, persists; distinct from approved)
    mapping(address => address) public _operatorStakers;

    // operator → active stake
    mapping(address => uint256) public _stakes;

    // operator → unbonding tranches
    mapping(address => Tranche[]) internal _tranches;

    // operator → active flag
    mapping(address => bool) public _activeOperators;

    constructor(address _token, uint256 unstakeDelaySec) {
        token = IERC20(_token);
        _unstakeDelay = unstakeDelaySec;
    }

    // ──────────────── Operator setup helpers (test only) ─────────────────

    function setApprovedStaker(address op, address staker) external {
        _approvedStakers[op] = staker;
        emit StakerApproved(op, staker);
    }

    function setActiveOperator(address op, bool active) external {
        _activeOperators[op] = active;
    }

    /// @notice Simulate the protocol adding rewards to an operator's stake.
    function addRewardToStake(address op, uint256 amount) external {
        _stakes[op] += amount;
    }

    // ────────────────────── IStakingOperators ────────────────────────────

    function stakeTo(address op, uint256 amount) external override {
        require(_approvedStakers[op] == msg.sender || _operatorStakers[op] == msg.sender, "not approved staker");
        require(amount > 0, "zero amount");

        token.safeTransferFrom(msg.sender, address(this), amount);
        _stakes[op] += amount;
        if (_operatorStakers[op] == address(0)) _operatorStakers[op] = msg.sender;

        emit StakedTo(msg.sender, op, amount);
    }

    function requestUnstake(address op, uint256 amount) external override {
        require(_approvedStakers[op] == msg.sender || _operatorStakers[op] == msg.sender, "not approved staker");
        require(amount > 0, "zero amount");
        require(_stakes[op] >= amount, "insufficient stake");

        _stakes[op] -= amount;
        _tranches[op].push(
            Tranche({amount: amount, releaseTime: uint64(block.timestamp + _unstakeDelay)})
        );

        emit UnstakeRequested(msg.sender, op, amount, uint64(block.timestamp + _unstakeDelay));
    }

    function withdrawUnstaked(address op) external override {
        require(_approvedStakers[op] == msg.sender || _operatorStakers[op] == msg.sender, "not approved staker");

        uint256 total;
        Tranche[] storage tranches = _tranches[op];

        // Collect matured tranches (simple: iterate and delete)
        uint256 writeIdx;
        for (uint256 i; i < tranches.length; i++) {
            if (tranches[i].releaseTime <= block.timestamp) {
                total += tranches[i].amount;
            } else {
                if (writeIdx != i) {
                    tranches[writeIdx] = tranches[i];
                }
                writeIdx++;
            }
        }
        // Remove consumed entries
        while (tranches.length > writeIdx) {
            tranches.pop();
        }

        require(total > 0, "nothing to withdraw");
        token.safeTransfer(msg.sender, total);

        emit UnstakedWithdrawn(msg.sender, op, total);
    }

    function approveStaker(address staker) external override {
        _approvedStakers[msg.sender] = staker;
        emit StakerApproved(msg.sender, staker);
    }

    // ────────────────────── Views ────────────────────────────────────────

    function stakeOf(address op) external view override returns (uint256) {
        return _stakes[op];
    }

    function approvedStaker(address op) external view override returns (address) {
        return _approvedStakers[op];
    }

    function operatorStaker(address op) external view override returns (address) {
        return _operatorStakers[op];
    }

    function isActiveOperator(address op) external view override returns (bool) {
        return _activeOperators[op];
    }

    function getOperatorInfo(address op) external view override returns (OperatorInfo memory) {
        return OperatorInfo({active: _activeOperators[op], metadataURI: ""});
    }

    function getUnbondingTranches(address op) external view override returns (Tranche[] memory) {
        return _tranches[op];
    }

    function stakingToken() external view override returns (address) {
        return address(token);
    }

    function unstakeDelay() external view override returns (uint256) {
        return _unstakeDelay;
    }

    function totalStaked() external pure override returns (uint256) {
        // Simplified: not tracking global total in mock
        return 0;
    }

    function stakeAt(address, uint64) external pure override returns (uint256) {
        return 0;
    }

    function getActiveOperators() external pure override returns (address[] memory) {
        return new address[](0);
    }
}
