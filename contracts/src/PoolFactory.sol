// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BlacklightPool} from "./BlacklightPool.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @title  PoolFactory
/// @notice Creates new BlacklightPool instances as minimal proxies (clones) of a single implementation.
///         This is the only supported way to create pools: clone and initialize happen in one
///         transaction, preventing front-running of initialize() (which has no access control).
///         Use for one pool (acceptance test) or many pools (multi-operator platform).
///         Platform operation fee is hardcoded at 1% (PLATFORM_FEE_BPS); rewards will deduct
///         this amount to the platform fee recipient before distribution when settleEpoch exists.
contract PoolFactory {
    /// @notice Platform operation fee: 1% of pool rewards. Hardcoded for transparency; cannot be
    ///         increased. See public repo for auditability.
    uint256 public constant PLATFORM_FEE_BPS = 100;

    /// @notice The implementation contract; all new pools are clones of this.
    BlacklightPool public immutable implementation;

    /// @notice NIL token, staking contract, and reward policy used for all pools (chain-wide).
    address public immutable nilToken;
    address public immutable stakingContract;
    address public immutable rewardPolicy;

    /// @notice Recipient of the 1% platform operation fee (deducted during reward distribution).
    address public immutable platformFeeRecipient;

    event PoolCreated(address indexed owner, address indexed operator, address pool);

    error InvalidAddress();
    /// @notice Thrown when createPool is called with operator == owner (operator and owner must differ).
    error OperatorCannotBeOwner();

    /// @param _nilToken              NIL ERC-20 address on the Blacklight L2.
    /// @param _stakingContract       StakingOperators contract address.
    /// @param _rewardPolicy          Reward policy contract that pays NIL to pools.
    /// @param _platformFeeRecipient  Address to receive 1% platform fee during reward distribution.
    ///                               Required (must not be address(0)).
    constructor(
        address _nilToken,
        address _stakingContract,
        address _rewardPolicy,
        address _platformFeeRecipient
    ) {
        if (_nilToken == address(0)) revert InvalidAddress();
        if (_stakingContract == address(0)) revert InvalidAddress();
        if (_rewardPolicy == address(0)) revert InvalidAddress();
        if (_platformFeeRecipient == address(0)) revert InvalidAddress();
        nilToken = _nilToken;
        stakingContract = _stakingContract;
        rewardPolicy = _rewardPolicy;
        platformFeeRecipient = _platformFeeRecipient;
        implementation = new BlacklightPool(
            _nilToken,
            _stakingContract,
            _rewardPolicy,
            _platformFeeRecipient
        );
    }

    /// @notice Creates a new pool for the given operator and owner. Use this exclusively to create
    ///         pools; do not deploy or clone BlacklightPool and call initialize() separately.
    /// @param _operator        Blacklight node wallet the pool will stake to.
    /// @param _owner           Pool owner (e.g. msg.sender); receives commission and manages the pool.
    /// @param _commissionBps   Commission in basis points (≤ 5000).
    /// @param _minStakePerUser Minimum NIL per staker (≥ 500 * 1e6, 6 decimals).
    /// @return pool            Address of the new pool (clone).
    function createPool(
        address _operator,
        address _owner,
        uint256 _commissionBps,
        uint256 _minStakePerUser
    ) external returns (address pool) {
        if (_operator == _owner) revert OperatorCannotBeOwner();
        pool = Clones.clone(address(implementation));
        BlacklightPool(pool).initialize(
            _operator,
            _owner,
            _commissionBps,
            _minStakePerUser
        );
        emit PoolCreated(_owner, _operator, pool);
        return pool;
    }
}
