// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {BlacklightPool} from "../src/BlacklightPool.sol";
import {PoolFactory} from "../src/PoolFactory.sol";
import {MockNILToken} from "./mocks/MockNILToken.sol";
import {MockStakingOperators} from "./mocks/MockStakingOperators.sol";
import {MockRewardPolicy} from "./mocks/MockRewardPolicy.sol";

/// @title BlacklightPoolTest
/// @notice Tests for BlacklightPool (constructor + initialize, clone-ready) and PoolFactory.
contract BlacklightPoolTest is Test {
    address owner = makeAddr("owner");
    address operatorNode = makeAddr("operatorNode");
    address alice = makeAddr("alice");
    address platformFeeRecipient = makeAddr("platform");

    MockNILToken nil;
    MockStakingOperators staking;
    MockRewardPolicy rewardPolicy;
    BlacklightPool pool;
    PoolFactory factory;

    uint256 constant COMMISSION_BPS = 500; // 5%
    uint256 constant MIN_STAKE = 500 * 1e6; // 500 NIL (6 decimals)
    uint256 constant UNSTAKE_DELAY = 7 days;
    uint256 constant OPERATOR_INIT_STAKE = 90_000 * 1e6; // 90,000 NIL (6 decimals)

    function setUp() public {
        nil = new MockNILToken();
        staking = new MockStakingOperators(address(nil), UNSTAKE_DELAY);
        rewardPolicy = new MockRewardPolicy(address(nil));
        pool = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        pool.initialize(operatorNode, owner, COMMISSION_BPS, MIN_STAKE);
        // Pool must be approved staker so it can requestUnstake / withdrawUnstaked for the operator
        vm.prank(operatorNode);
        staking.approveStaker(address(pool));
    }

    function _initOperatorForPool() internal {
        // Simulate existing node stake at the protocol level and initialize it in the pool
        staking.addRewardToStake(operatorNode, OPERATOR_INIT_STAKE);
        vm.prank(owner);
        pool.initOwnerNodeStake();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR (implementation: immutables only)
    // ═══════════════════════════════════════════════════════════════════

    function test_constructor_setsImmutables() public view {
        assertEq(address(pool.nilToken()), address(nil));
        assertEq(address(pool.stakingContract()), address(staking));
    }

    function test_constructor_revertsOnZeroNilToken() public {
        vm.expectRevert(BlacklightPool.InvalidAddress.selector);
        new BlacklightPool(address(0), address(staking), address(rewardPolicy), platformFeeRecipient);
    }

    function test_constructor_revertsOnZeroStakingContract() public {
        vm.expectRevert(BlacklightPool.InvalidAddress.selector);
        new BlacklightPool(address(nil), address(0), address(rewardPolicy), platformFeeRecipient);
    }

    function test_constructor_revertsOnZeroPlatformFeeRecipient() public {
        vm.expectRevert(BlacklightPool.InvalidAddress.selector);
        new BlacklightPool(address(nil), address(staking), address(rewardPolicy), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INITIALIZE — happy path
    // ═══════════════════════════════════════════════════════════════════

    function test_initialize_setsOperatorAndOwner() public view {
        assertEq(pool.operator(), operatorNode);
        assertEq(pool.owner(), owner);
    }

    function test_initialize_setsCommissionAndStakeLimits() public view {
        assertEq(pool.commissionBps(), COMMISSION_BPS);
        assertEq(pool.minStakePerUser(), MIN_STAKE);
    }

    function test_minStakePerUserConstantIs500NIL() public view {
        assertEq(pool.MIN_STAKE_PER_USER(), 500 * 1e6);
    }

    function test_MAX_STAKERS_constantIs100() public view {
        assertEq(pool.MAX_STAKERS(), 100);
    }

    function test_MAX_STAKER_STAKE_constantIs100kNIL() public view {
        assertEq(pool.MAX_STAKER_STAKE(), 100_000 * 1e6);
    }

    function test_constants() public view {
        assertEq(pool.MAX_COMMISSION_BPS(), 5_000);
        assertEq(pool.BPS_DENOMINATOR(), 10_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INITIALIZE — revert on invalid inputs
    // ═══════════════════════════════════════════════════════════════════

    function test_initialize_revertsOnZeroOperator() public {
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        vm.expectRevert(BlacklightPool.InvalidAddress.selector);
        p.initialize(address(0), owner, COMMISSION_BPS, MIN_STAKE);
    }

    function test_initialize_revertsOnZeroOwner() public {
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        vm.expectRevert(BlacklightPool.InvalidAddress.selector);
        p.initialize(operatorNode, address(0), COMMISSION_BPS, MIN_STAKE);
    }

    function test_initialize_revertsOnCommissionTooHigh() public {
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        vm.expectRevert(BlacklightPool.CommissionTooHigh.selector);
        p.initialize(operatorNode, owner, 5_001, MIN_STAKE);
    }

    function test_initialize_revertsOnMinStakeTooLow() public {
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        vm.expectRevert(BlacklightPool.MinStakeTooLow.selector);
        p.initialize(operatorNode, owner, COMMISSION_BPS, 499 * 1e6);
    }

    function test_initialize_revertsWhenAlreadyInitialized() public {
        vm.expectRevert(BlacklightPool.AlreadyInitialized.selector);
        pool.initialize(operatorNode, owner, COMMISSION_BPS, MIN_STAKE);
    }

    function test_initialize_revertsWhenOperatorAlreadyInUse() public {
        // Pool from setUp has operatorNode approved. Stake and activate so operator gets operatorStaker + stakeOf > 0.
        nil.mint(alice, 100_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 100_000 * 1e6);
        pool.stake(100_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.activateOperator(100_000 * 1e6);
        // operatorNode now has operatorStaker = pool and stakeOf > 0
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        vm.expectRevert(BlacklightPool.OperatorAlreadyInUse.selector);
        p.initialize(operatorNode, owner, COMMISSION_BPS, MIN_STAKE);
    }

    function test_initialize_acceptsMinStakeExactly500NIL() public {
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        p.initialize(operatorNode, owner, COMMISSION_BPS, 500 * 1e6);
        assertEq(p.minStakePerUser(), 500 * 1e6);
    }

    function test_initialize_acceptsMinStakeAbove500NIL() public {
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        p.initialize(operatorNode, owner, COMMISSION_BPS, 5000 * 1e6);
        assertEq(p.minStakePerUser(), 5000 * 1e6);
    }

    function test_initialize_acceptsMaxCommission() public {
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        p.initialize(operatorNode, owner, 5_000, MIN_STAKE);
        assertEq(p.commissionBps(), 5_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  OPERATOR INIT (initOperatorStake)
    // ═══════════════════════════════════════════════════════════════════

    function test_initOwnerNodeStake_onlyOwnerCanCall() public {
        // Fresh pool without owner’s node stake initialized
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        p.initialize(operatorNode, owner, COMMISSION_BPS, MIN_STAKE);
        vm.prank(operatorNode);
        staking.approveStaker(address(p));
        staking.addRewardToStake(operatorNode, OPERATOR_INIT_STAKE);

        // Non-owner should be rejected by onlyOwner modifier
        vm.prank(alice);
        vm.expectRevert(BlacklightPool.NotPoolOwner.selector);
        p.initOwnerNodeStake();
    }

    function test_initOwnerNodeStake_recordsOwnerStake_andCanOnlyBeCalledOnce() public {
        // Fresh pool without owner’s node stake initialized
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        p.initialize(operatorNode, owner, COMMISSION_BPS, MIN_STAKE);
        vm.prank(operatorNode);
        staking.approveStaker(address(p));

        // Simulate node already having stake at the protocol level
        staking.addRewardToStake(operatorNode, OPERATOR_INIT_STAKE);

        // Owner initializes their node-backed stake as a staker position in the pool
        vm.prank(owner);
        p.initOwnerNodeStake();

        (uint256 proc, uint256 staked,,) = p.stakers(owner);
        assertEq(proc, 0);
        assertEq(staked, OPERATOR_INIT_STAKE);
        assertEq(p.totalUserStakes(), OPERATOR_INIT_STAKE);
        assertTrue(p.isStaker(owner));
        assertEq(p.stakerCount(), 1);

        // Second call should revert since owner’s node-backed stake is already initialized as a staker
        vm.prank(owner);
        vm.expectRevert(BlacklightPool.OperatorAlreadyInitialized.selector);
        p.initOwnerNodeStake();
    }

    function test_initOwnerNodeStake_calledBeforeOtherStakers_join() public {
        // Node has protocol stake first
        staking.addRewardToStake(operatorNode, OPERATOR_INIT_STAKE);

        // Owner initializes their node-backed stake in the pool before any user stakes
        vm.prank(owner);
        pool.initOwnerNodeStake();

        // Now a normal user (alice) stakes into the pool
        uint256 aliceAmount = 5_000 * 1e6;
        nil.mint(alice, aliceAmount);
        vm.startPrank(alice);
        nil.approve(address(pool), aliceAmount);
        pool.stake(aliceAmount);
        vm.stopPrank();

        // Both owner (node-backed stake) and alice should now be stakers
        assertTrue(pool.isStaker(owner));
        assertTrue(pool.isStaker(alice));
        assertEq(pool.stakerCount(), 2);
        (uint256 opProc, uint256 opStaked,,) = pool.stakers(owner);
        (uint256 aliceProc, uint256 aliceStaked,,) = pool.stakers(alice);
        assertEq(opProc, 0);
        assertEq(opStaked, OPERATOR_INIT_STAKE);
        assertEq(aliceProc, aliceAmount);
        assertEq(aliceStaked, 0);
        assertEq(pool.totalUserStakes(), 90_000 * 1e6 + aliceAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  POOL FACTORY
    // ═══════════════════════════════════════════════════════════════════

    // --- PoolFactory constructor ---

    function test_factory_constructor_setsImmutables() public {
        factory = new PoolFactory(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        assertEq(factory.nilToken(), address(nil));
        assertEq(factory.stakingContract(), address(staking));
        assertEq(factory.rewardPolicy(), address(rewardPolicy));
        assertEq(factory.platformFeeRecipient(), platformFeeRecipient);
    }

    function test_factory_constructor_platformFeeBpsIs100() public {
        factory = new PoolFactory(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        assertEq(factory.PLATFORM_FEE_BPS(), 100, "platform fee must be 1% (100 bps), hardcoded for transparency");
    }

    function test_factory_constructor_revertsOnZeroNilToken() public {
        vm.expectRevert(PoolFactory.InvalidAddress.selector);
        new PoolFactory(address(0), address(staking), address(rewardPolicy), platformFeeRecipient);
    }

    function test_factory_constructor_revertsOnZeroStakingContract() public {
        vm.expectRevert(PoolFactory.InvalidAddress.selector);
        new PoolFactory(address(nil), address(0), address(rewardPolicy), platformFeeRecipient);
    }

    function test_factory_constructor_revertsOnZeroRewardPolicy() public {
        vm.expectRevert(BlacklightPool.InvalidAddress.selector);
        new PoolFactory(address(nil), address(staking), address(0), platformFeeRecipient);
    }

    function test_factory_constructor_revertsOnZeroPlatformFeeRecipient() public {
        vm.expectRevert(PoolFactory.InvalidAddress.selector);
        new PoolFactory(address(nil), address(staking), address(rewardPolicy), address(0));
    }

    function test_factory_constructor_clonesGetPlatformFeeRecipient() public {
        factory = new PoolFactory(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        address poolAddr = factory.createPool(operatorNode, owner, COMMISSION_BPS, MIN_STAKE);
        BlacklightPool created = BlacklightPool(poolAddr);
        assertEq(created.platformFeeRecipient(), platformFeeRecipient);
        assertEq(created.PLATFORM_FEE_BPS(), 100);
    }

    function test_factory_createPool_deploysCloneAndSetsState() public {
        factory = new PoolFactory(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        address poolAddr = factory.createPool(
            operatorNode,
            owner,
            COMMISSION_BPS,
            MIN_STAKE
        );
        assertTrue(poolAddr != address(0));
        BlacklightPool created = BlacklightPool(poolAddr);
        assertEq(created.operator(), operatorNode);
        assertEq(created.owner(), owner);
        assertEq(created.commissionBps(), COMMISSION_BPS);
        assertEq(created.minStakePerUser(), MIN_STAKE);
        assertEq(created.MAX_STAKERS(), 100);
        assertEq(created.MAX_STAKER_STAKE(), 100_000 * 1e6);
        assertEq(address(created.nilToken()), address(nil));
        assertEq(address(created.stakingContract()), address(staking));
    }

    function test_factory_createPool_emitsPoolCreated() public {
        factory = new PoolFactory(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        vm.recordLogs();
        address poolAddr = factory.createPool(
            operatorNode,
            owner,
            COMMISSION_BPS,
            MIN_STAKE
        );
        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 1);
        assertEq(entries[0].topics[0], keccak256("PoolCreated(address,address,address)"));
        assertEq(entries[0].topics[1], bytes32(uint256(uint160(owner))));
        assertEq(entries[0].topics[2], bytes32(uint256(uint160(operatorNode))));
        assertEq(abi.decode(entries[0].data, (address)), poolAddr);
    }

    function test_factory_createPool_revertsWhenOperatorEqualsOwner() public {
        factory = new PoolFactory(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        address sameAddr = makeAddr("same");
        vm.expectRevert(PoolFactory.OperatorCannotBeOwner.selector);
        factory.createPool(sameAddr, sameAddr, COMMISSION_BPS, MIN_STAKE);
    }

    function test_factory_createPool_succeedsWhenOperatorDiffersFromOwner() public {
        factory = new PoolFactory(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        address op = makeAddr("op");
        address own = makeAddr("own");
        address poolAddr = factory.createPool(op, own, COMMISSION_BPS, MIN_STAKE);
        assertTrue(poolAddr != address(0));
        assertEq(BlacklightPool(poolAddr).operator(), op);
        assertEq(BlacklightPool(poolAddr).owner(), own);
    }

    function test_factory_createPool_multiplePoolsHaveIndependentState() public {
        factory = new PoolFactory(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        address alicePool = factory.createPool(
            makeAddr("op1"),
            makeAddr("aliceOwner"),
            300,
            2000 * 1e6
        );
        address bobPool = factory.createPool(
            makeAddr("op2"),
            makeAddr("bobOwner"),
            700,
            5000 * 1e6
        );
        assertTrue(alicePool != bobPool);
        assertEq(BlacklightPool(alicePool).owner(), makeAddr("aliceOwner"));
        assertEq(BlacklightPool(alicePool).commissionBps(), 300);
        assertEq(BlacklightPool(alicePool).minStakePerUser(), 2000 * 1e6);
        assertEq(BlacklightPool(alicePool).MAX_STAKERS(), 100);
        assertEq(BlacklightPool(alicePool).MAX_STAKER_STAKE(), 100_000 * 1e6);
        assertEq(BlacklightPool(bobPool).owner(), makeAddr("bobOwner"));
        assertEq(BlacklightPool(bobPool).commissionBps(), 700);
        assertEq(BlacklightPool(bobPool).minStakePerUser(), 5000 * 1e6);
        assertEq(BlacklightPool(bobPool).MAX_STAKERS(), 100);
        assertEq(BlacklightPool(bobPool).MAX_STAKER_STAKE(), 100_000 * 1e6);
    }

    function test_factory_implementationIsNotInitialized() public {
        factory = new PoolFactory(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        BlacklightPool impl = factory.implementation();
        assertEq(impl.owner(), address(0));
        assertEq(impl.operator(), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  STAKE — happy path
    // ═══════════════════════════════════════════════════════════════════

    function test_stake_happyPath() public {
        _initOperatorForPool();
        uint256 amount = 5_000 * 1e6;
        nil.mint(alice, amount);
        vm.startPrank(alice);
        nil.approve(address(pool), amount);

        vm.expectEmit(true, true, true, true);
        emit BlacklightPool.Staked(alice, amount);
        pool.stake(amount);

        (uint256 proc, uint256 staked,,) = pool.stakers(alice);
        assertEq(proc, amount);
        assertEq(staked, 0);
        assertEq(pool.totalUserStakes(), OPERATOR_INIT_STAKE + amount);
        assertEq(pool.stakerCount(), 2);
        assertTrue(pool.isStaker(alice));
        assertEq(nil.balanceOf(address(pool)), amount);
        assertEq(nil.balanceOf(alice), 0);
    }

    function test_stake_addsToExistingStake() public {
        _initOperatorForPool();
        uint256 firstAmount = 3_000 * 1e6;
        uint256 secondAmount = 2_000 * 1e6;
        nil.mint(alice, firstAmount + secondAmount);
        vm.startPrank(alice);
        nil.approve(address(pool), firstAmount + secondAmount);

        pool.stake(firstAmount);
        pool.stake(secondAmount);

        (uint256 proc, uint256 staked,,) = pool.stakers(alice);
        assertEq(proc + staked, 5_000 * 1e6);
        assertEq(pool.totalUserStakes(), OPERATOR_INIT_STAKE + 5_000 * 1e6);
        assertEq(pool.stakerCount(), 2);
        assertEq(nil.balanceOf(address(pool)), 5_000 * 1e6);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  STAKE — reverts
    // ═══════════════════════════════════════════════════════════════════

    function test_stake_revertsOnZeroAmount() public {
        _initOperatorForPool();
        nil.mint(alice, MIN_STAKE);
        vm.prank(alice);
        nil.approve(address(pool), MIN_STAKE);
        vm.prank(alice);
        vm.expectRevert(BlacklightPool.ZeroAmount.selector);
        pool.stake(0);
    }

    function test_stake_revertsBelowMinimum() public {
        _initOperatorForPool();
        nil.mint(alice, 499 * 1e6);
        vm.prank(alice);
        nil.approve(address(pool), 499 * 1e6);
        vm.prank(alice);
        vm.expectRevert(BlacklightPool.BelowMinimumStake.selector);
        pool.stake(499 * 1e6);
    }

    function test_stake_revertsExceedsStakerCap() public {
        _initOperatorForPool();
        uint256 amount = 100_001 * 1e6;
        nil.mint(alice, amount);
        vm.prank(alice);
        nil.approve(address(pool), amount);
        vm.prank(alice);
        vm.expectRevert(BlacklightPool.ExceedsStakerCap.selector);
        pool.stake(amount);
    }

    function test_stake_revertsExceedsStakerCap_whenAddingToExistingStake() public {
        _initOperatorForPool();
        uint256 firstStake = 60_000 * 1e6;
        uint256 secondStake = 50_000 * 1e6; // 60k + 50k = 110k > 100k cap
        nil.mint(alice, firstStake + secondStake);
        vm.startPrank(alice);
        nil.approve(address(pool), firstStake + secondStake);
        pool.stake(firstStake);
        vm.expectRevert(BlacklightPool.ExceedsStakerCap.selector);
        pool.stake(secondStake);
    }

    function test_stake_revertsMaxStakersReached() public {
        _initOperatorForPool();
        uint256 amount = MIN_STAKE;
        // Operator already occupies one staker slot, so fill up the remaining slots
        for (uint256 i; i < pool.MAX_STAKERS() - 1; i++) {
            address user = address(uint160(0x1000 + i));
            nil.mint(user, amount);
            vm.prank(user);
            nil.approve(address(pool), amount);
            vm.prank(user);
            pool.stake(amount);
        }
        // Next staker beyond MAX_STAKERS should fail
        address bob = makeAddr("bob");
        nil.mint(bob, amount);
        vm.prank(bob);
        nil.approve(address(pool), amount);
        vm.prank(bob);
        vm.expectRevert(BlacklightPool.MaxStakersReached.selector);
        pool.stake(amount);
    }

    function test_stake_acceptsMinStakeExactly() public {
        _initOperatorForPool();
        nil.mint(alice, MIN_STAKE);
        vm.prank(alice);
        nil.approve(address(pool), MIN_STAKE);
        vm.prank(alice);
        pool.stake(MIN_STAKE);
        (uint256 proc, uint256 staked,,) = pool.stakers(alice);
        assertEq(proc + staked, MIN_STAKE);
    }

    function test_stake_acceptsMaxStakerStake() public {
        _initOperatorForPool();
        uint256 amount = pool.MAX_STAKER_STAKE();
        nil.mint(alice, amount);
        vm.prank(alice);
        nil.approve(address(pool), amount);
        vm.prank(alice);
        pool.stake(amount);
        (uint256 proc, uint256 staked,,) = pool.stakers(alice);
        assertEq(proc + staked, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAWAL — requestWithdraw
    // ═══════════════════════════════════════════════════════════════════

    function test_MIN_OPERATOR_STAKE_constantIs70kNIL() public view {
        assertEq(pool.MIN_OPERATOR_STAKE(), 70_000 * 1e6);
    }

    function test_stake_revertsBeforeOperatorInit() public {
        // Fresh pool where initialize() has not been called (poolPhase == Uninitialized)
        MockStakingOperators localStaking = new MockStakingOperators(address(nil), UNSTAKE_DELAY);
        MockRewardPolicy localRewardPolicy = new MockRewardPolicy(address(nil));
        BlacklightPool p = new BlacklightPool(address(nil), address(localStaking), address(localRewardPolicy), platformFeeRecipient);
        // Do NOT call initialize — pool remains Uninitialized

        nil.mint(alice, MIN_STAKE);
        vm.prank(alice);
        nil.approve(address(p), MIN_STAKE);

        vm.prank(alice);
        vm.expectRevert(BlacklightPool.OperatorNotInitialized.selector);
        p.stake(MIN_STAKE);
    }

    /// @notice Staking is blocked until the operator has approved the pool as staker.
    function test_stake_revertsWhenOperatorNotApproved() public {
        MockStakingOperators localStaking = new MockStakingOperators(address(nil), UNSTAKE_DELAY);
        MockRewardPolicy localRewardPolicy = new MockRewardPolicy(address(nil));
        BlacklightPool p = new BlacklightPool(address(nil), address(localStaking), address(localRewardPolicy), platformFeeRecipient);
        p.initialize(operatorNode, owner, COMMISSION_BPS, MIN_STAKE);
        // Do NOT call approveStaker — operator has not approved this pool

        nil.mint(alice, MIN_STAKE);
        vm.prank(alice);
        nil.approve(address(p), MIN_STAKE);
        vm.prank(alice);
        vm.expectRevert(BlacklightPool.OperatorNotApproved.selector);
        p.stake(MIN_STAKE);
    }

    /// @notice The operator address cannot call stake(); only owner or other users may stake.
    function test_stake_revertsWhenCallerIsOperator() public {
        _initOperatorForPool();
        nil.mint(operatorNode, MIN_STAKE);
        vm.prank(operatorNode);
        nil.approve(address(pool), MIN_STAKE);
        vm.prank(operatorNode);
        vm.expectRevert(BlacklightPool.OperatorCannotStake.selector);
        pool.stake(MIN_STAKE);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ACTIVATE OPERATOR — reverts
    // ═══════════════════════════════════════════════════════════════════

    /// @notice activateOperator reverts when the operator has not approved this pool as staker.
    function test_activateOperator_revertsWhenOperatorNotApproved() public {
        MockStakingOperators localStaking = new MockStakingOperators(address(nil), UNSTAKE_DELAY);
        MockRewardPolicy localRewardPolicy = new MockRewardPolicy(address(nil));
        BlacklightPool p = new BlacklightPool(address(nil), address(localStaking), address(localRewardPolicy), platformFeeRecipient);
        p.initialize(operatorNode, owner, COMMISSION_BPS, MIN_STAKE);
        // Do NOT call approveStaker — operator has not approved this pool
        // Fund pool with NIL by minting directly so we don't need to call stake()
        nil.mint(address(p), 70_000 * 1e6);

        vm.prank(owner);
        vm.expectRevert(BlacklightPool.OperatorNotUsingPoolAsStaker.selector);
        p.activateOperator(70_000 * 1e6);
    }

    /// @notice activateOperator reverts when pool NIL balance is below totalProcessingStake (accounting invariant).
    function test_activateOperator_revertsWhenBalanceBelowTotalProcessingStake() public {
        vm.prank(operatorNode);
        staking.approveStaker(address(pool));
        uint256 stakeAmount = 75_000 * 1e6;
        nil.mint(alice, stakeAmount);
        vm.prank(alice);
        nil.approve(address(pool), stakeAmount);
        vm.prank(alice);
        pool.stake(stakeAmount);
        assertEq(pool.totalProcessingStake(), stakeAmount);
        assertEq(nil.balanceOf(address(pool)), stakeAmount);
        // Simulate balance < totalProcessingStake but >= 70k so InsufficientPoolBalance is hit (not OperatorStakeTooLow)
        deal(address(nil), address(pool), 72_000 * 1e6);
        vm.prank(owner);
        vm.expectRevert(BlacklightPool.InsufficientPoolBalance.selector);
        pool.activateOperator(70_000 * 1e6);
    }

    function test_requestWithdraw_queuesAndUpdatesState() public {
        _initOperatorForPool();
        uint256 amount = 10_000 * 1e6;
        nil.mint(alice, amount);
        vm.startPrank(alice);
        nil.approve(address(pool), amount);
        pool.stake(amount);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit BlacklightPool.WithdrawQueued(alice, 3_000 * 1e6, 0, 0);
        pool.requestWithdraw(3_000 * 1e6);

        // Staked and totals are NOT reduced until processWithdrawalBatch
        (uint256 proc, uint256 staked,,) = pool.stakers(alice);
        assertEq(proc, 0);
        assertEq(staked, 10_000 * 1e6, "staked unchanged until batch");
        assertEq(pool.getPendingWithdrawalSum(alice), 3_000 * 1e6);
        assertEq(pool.totalUserStakes(), OPERATOR_INIT_STAKE + 10_000 * 1e6);
        assertEq(pool.totalStakedAtNode(), OPERATOR_INIT_STAKE + 10_000 * 1e6);
        assertEq(pool.totalPendingWithdrawals(), 3_000 * 1e6);
        assertEq(pool.totalStakedAtNode(), staking.stakeOf(pool.operator()), "sum(stakers.staked) = node stake");

        BlacklightPool.WithdrawalRequest[] memory q = pool.getWithdrawalQueue(alice);
        assertEq(q.length, 1);
        assertEq(q[0].amount, 3_000 * 1e6);
        assertEq(q[0].unlockTimestamp, 0);
        assertFalse(q[0].claimed);
    }

    function test_requestWithdraw_revertsOnZeroAmount() public {
        _initOperatorForPool();
        nil.mint(alice, MIN_STAKE);
        vm.prank(alice);
        nil.approve(address(pool), MIN_STAKE);
        vm.prank(alice);
        pool.stake(MIN_STAKE);
        vm.prank(alice);
        vm.expectRevert(BlacklightPool.ZeroAmount.selector);
        pool.requestWithdraw(0);
    }

    function test_requestWithdraw_revertsWhenAmountExceedsStaked() public {
        _initOperatorForPool();
        nil.mint(alice, MIN_STAKE);
        vm.prank(alice);
        nil.approve(address(pool), MIN_STAKE);
        vm.prank(alice);
        pool.stake(MIN_STAKE);
        vm.prank(alice);
        vm.expectRevert(BlacklightPool.InsufficientStake.selector);
        pool.requestWithdraw(MIN_STAKE + 1);
    }

    function test_requestWithdraw_revertsInIdlePhase() public {
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.expectRevert(BlacklightPool.IdlePhaseUseWithdrawProcessingStake.selector);
        pool.requestWithdraw(1_000 * 1e6);
        vm.stopPrank();
    }

    function test_requestWithdraw_enforcesMinStakePerUser() public {
        _initOperatorForPool();
        nil.mint(alice, 5_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 5_000 * 1e6);
        pool.stake(5_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        // 5000 - 4501 = 499 < minStakePerUser (500)
        vm.expectRevert(BlacklightPool.BelowMinimumStake.selector);
        pool.requestWithdraw(4_501 * 1e6);
    }

    /// @notice requestWithdraw allows withdrawing all (remaining == 0); staker is removed after batch.
    function test_requestWithdraw_removesStakerOnZeroBalance() public {
        _initOperatorForPool();
        nil.mint(alice, MIN_STAKE);
        vm.startPrank(alice);
        nil.approve(address(pool), MIN_STAKE);
        pool.stake(MIN_STAKE);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(MIN_STAKE); // withdraw all staked; remaining 0 must not revert
        // Staked not reduced on request; alice remains until processWithdrawalBatch
        assertEq(pool.stakerCount(), 2);
        assertTrue(pool.isStaker(alice));
        (uint256 proc, uint256 staked,,) = pool.stakers(alice);
        assertEq(proc, 0);
        assertEq(staked, MIN_STAKE);
        assertEq(pool.getPendingWithdrawalSum(alice), MIN_STAKE);
        vm.prank(owner);
        pool.processWithdrawalBatch(10);
        (proc, staked,,) = pool.stakers(alice);
        assertEq(staked, 0);
        assertEq(pool.stakerCount(), 1);
        assertFalse(pool.isStaker(alice));
    }

    function test_requestWithdraw_revertsWhenTooManyConcurrentRequests() public {
        _initOperatorForPool();
        nil.mint(alice, 100_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 100_000 * 1e6);
        pool.stake(100_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.startPrank(alice);
        for (uint256 i; i < pool.MAX_CONCURRENT_WITHDRAWAL_REQUESTS(); i++) {
            pool.requestWithdraw(1 * 1e6);
        }
        assertEq(pool.getPendingWithdrawalRequestCount(alice), 5);
        vm.expectRevert(BlacklightPool.TooManyWithdrawalRequests.selector);
        pool.requestWithdraw(1 * 1e6);
        vm.stopPrank();
    }

    function test_requestWithdraw_quotaReleasedAfterClaim() public {
        _initOperatorForPool();
        nil.mint(alice, 100_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 100_000 * 1e6);
        pool.stake(100_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.startPrank(alice);
        for (uint256 i; i < 5; i++) {
            pool.requestWithdraw(1_000 * 1e6);
        }
        vm.stopPrank();
        assertEq(pool.getPendingWithdrawalRequestCount(alice), 5);
        vm.prank(owner);
        pool.processWithdrawalBatch(10);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();
        vm.prank(alice);
        pool.claimWithdrawals();
        assertEq(pool.getPendingWithdrawalRequestCount(alice), 0, "all claimed frees quota");

        vm.prank(alice);
        pool.requestWithdraw(1 * 1e6);
        assertEq(pool.getPendingWithdrawalRequestCount(alice), 1);
    }

    function test_requestWithdraw_ownerRevertsIfBelow70kFloor() public {
        _initOperatorForPool();
        // Owner starts with OPERATOR_INIT_STAKE (90k) backed by the node. Withdrawing 21k would
        // leave 69k, below the 70k floor, so this should revert.
        vm.startPrank(owner);
        vm.expectRevert(BlacklightPool.OperatorStakeTooLow.selector);
        pool.requestWithdraw(21_000 * 1e6);
        vm.stopPrank();
    }

    function test_requestWithdraw_ownerSucceedsWhenRemainingAtOrAbove70k() public {
        _initOperatorForPool();
        // Owner starts with OPERATOR_INIT_STAKE (90k) backed by the node. Withdrawing 20k leaves
        // exactly 70k after batch, which is allowed. Staked unchanged until batch.
        vm.startPrank(owner);
        pool.requestWithdraw(20_000 * 1e6);
        vm.stopPrank();
        (uint256 proc, uint256 staked,,) = pool.stakers(owner);
        assertEq(staked, 90_000 * 1e6, "staked unchanged until batch");
        assertEq(proc, 0);
        assertEq(pool.getPendingWithdrawalSum(owner), 20_000 * 1e6);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAWAL — cancelPendingWithdrawal
    // ═══════════════════════════════════════════════════════════════════

    function test_cancelPendingWithdrawal_succeedsAndRestoresStake() public {
        _initOperatorForPool();
        uint256 amount = 10_000 * 1e6;
        nil.mint(alice, amount);
        vm.startPrank(alice);
        nil.approve(address(pool), amount);
        pool.stake(amount);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(3_000 * 1e6);

        (uint256 proc, uint256 staked,,) = pool.stakers(alice);
        assertEq(staked, 10_000 * 1e6, "staked unchanged until batch");
        assertEq(pool.getPendingWithdrawalSum(alice), 3_000 * 1e6);
        assertEq(pool.totalPendingWithdrawals(), 3_000 * 1e6);

        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit BlacklightPool.WithdrawalCancelled(alice, 3_000 * 1e6, 0);
        pool.cancelPendingWithdrawal(0);

        (proc, staked,,) = pool.stakers(alice);
        assertEq(staked, 10_000 * 1e6, "staked was never reduced");
        assertEq(pool.totalPendingWithdrawals(), 0);
        assertEq(pool.totalStakedAtNode(), OPERATOR_INIT_STAKE + 10_000 * 1e6);
        BlacklightPool.WithdrawalRequest[] memory q = pool.getWithdrawalQueue(alice);
        assertEq(q.length, 1);
        assertTrue(q[0].cancelled);
        assertEq(pool.getPendingWithdrawalRequestCount(alice), 0);
    }

    function test_cancelPendingWithdrawal_revertsWhenAlreadyBatched() public {
        _initOperatorForPool();
        nil.mint(alice, 20_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 20_000 * 1e6);
        pool.stake(20_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(5_000 * 1e6);
        pool.processWithdrawalBatch(10);

        vm.prank(alice);
        vm.expectRevert(BlacklightPool.WithdrawalNotPending.selector);
        pool.cancelPendingWithdrawal(0);
    }

    function test_cancelPendingWithdrawal_revertsWhenInvalidIndex() public {
        _initOperatorForPool();
        nil.mint(alice, 2_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 2_000 * 1e6);
        pool.stake(2_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(500 * 1e6); // one request at index 0

        vm.prank(alice);
        vm.expectRevert(BlacklightPool.WithdrawalNotPending.selector);
        pool.cancelPendingWithdrawal(1); // index 1 does not exist
    }

    function test_cancelPendingWithdrawal_stakerRemainsUntilBatch() public {
        _initOperatorForPool();
        nil.mint(alice, MIN_STAKE);
        vm.startPrank(alice);
        nil.approve(address(pool), MIN_STAKE);
        pool.stake(MIN_STAKE);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(MIN_STAKE);
        // Staked not reduced on request; alice remains in stakerList until processWithdrawalBatch
        assertTrue(pool.isStaker(alice));
        assertEq(pool.stakerCount(), 2);
        (uint256 proc, uint256 staked,,) = pool.stakers(alice);
        assertEq(staked, MIN_STAKE);
        assertEq(proc, 0);
        assertEq(pool.getPendingWithdrawalSum(alice), MIN_STAKE);

        vm.prank(alice);
        pool.cancelPendingWithdrawal(0);
        assertTrue(pool.isStaker(alice));
        assertEq(pool.stakerCount(), 2);
        (proc, staked,,) = pool.stakers(alice);
        assertEq(staked, MIN_STAKE);
        assertEq(proc, 0);
    }

    /// @notice Staked and totalStakedAtNode stay equal to node stake until processWithdrawalBatch.
    ///         Rewards continue to accrue on full staked until batch. Two requests: first batched, second not yet.
    function test_requestWithdraw_stakedUnchangedUntilBatch_sumEqualsNodeStake() public {
        _initOperatorForPool();
        uint256 aliceStake = 71_000 * 1e6;
        nil.mint(alice, aliceStake);
        vm.startPrank(alice);
        nil.approve(address(pool), aliceStake);
        pool.stake(aliceStake);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        assertEq(pool.totalStakedAtNode(), staking.stakeOf(pool.operator()), "after forward: totalStakedAtNode = node");

        vm.prank(alice);
        pool.requestWithdraw(2_000 * 1e6);
        (uint256 _proc, uint256 _atNode) = pool.getStakerStakeBreakdown(alice);
        assertEq(_atNode, aliceStake, "staked unchanged after first request");
        assertEq(pool.totalStakedAtNode(), staking.stakeOf(pool.operator()), "totalStakedAtNode = node until batch");
        assertEq(pool.getPendingWithdrawalSum(alice), 2_000 * 1e6);

        vm.prank(owner);
        pool.processWithdrawalBatch(10);
        (, uint256 staked,,) = pool.stakers(alice);
        assertEq(staked, aliceStake - 2_000 * 1e6, "staked reduced after batch");
        assertEq(pool.totalStakedAtNode(), staking.stakeOf(pool.operator()), "totalStakedAtNode = node after batch");

        vm.prank(alice);
        pool.requestWithdraw(1_001 * 1e6);
        (_proc, _atNode) = pool.getStakerStakeBreakdown(alice);
        assertEq(_atNode, aliceStake - 2_000 * 1e6, "staked unchanged after second request");
        assertEq(pool.totalStakedAtNode(), staking.stakeOf(pool.operator()), "totalStakedAtNode = node until second batch");
        assertEq(pool.getPendingWithdrawalSum(alice), 2_000 * 1e6 + 1_001 * 1e6, "processing unstake = all unclaimed pending (2k + 1001)");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAWAL — processWithdrawalBatch
    // ═══════════════════════════════════════════════════════════════════

    function test_processWithdrawalBatch_aggregatesAndCallsStaking() public {
        _initOperatorForPool();
        nil.mint(alice, 20_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 20_000 * 1e6);
        pool.stake(20_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(5_000 * 1e6);

        vm.expectEmit(true, true, true, true);
        emit BlacklightPool.WithdrawalBatchProcessed(
            5_000 * 1e6, uint64(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER())
        );
        pool.processWithdrawalBatch(10);

        assertEq(pool.totalUnstakingRequested(), 5_000 * 1e6);
        BlacklightPool.WithdrawalRequest[] memory q = pool.getWithdrawalQueue(alice);
        assertEq(q[0].unlockTimestamp, uint64(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER()));
    }

    function test_processWithdrawalBatch_skipsWhenNothingPending() public {
        _initOperatorForPool();
        pool.processWithdrawalBatch(10); // no revert, just no-op
        assertEq(pool.totalUnstakingRequested(), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAWAL — unlock timing and claim
    // ═══════════════════════════════════════════════════════════════════

    function test_claimBeforeUnlockReverts() public {
        _initOperatorForPool();
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(2_000 * 1e6);
        pool.processWithdrawalBatch(10);
        // Not warped: still locked
        vm.prank(alice);
        vm.expectRevert(BlacklightPool.NothingToClaim.selector);
        pool.claimWithdrawals();
    }

    function test_claimAfterUnlockSucceeds() public {
        _initOperatorForPool();
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(2_000 * 1e6);
        pool.processWithdrawalBatch(10);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();
        vm.warp(block.timestamp + pool.WITHDRAWAL_CLAIM_BUFFER() + 1); // past pool unlock (delay + buffer)

        uint256 aliceBefore = nil.balanceOf(alice);
        vm.prank(alice);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(alice), aliceBefore + 2_000 * 1e6);
        assertEq(pool.totalPendingWithdrawals(), 0);
        BlacklightPool.WithdrawalRequest[] memory q = pool.getWithdrawalQueue(alice);
        assertTrue(q[0].claimed);
    }

    function test_claimWithdrawals_revertsWhenNoRequests() public {
        _initOperatorForPool();
        vm.prank(alice);
        vm.expectRevert(BlacklightPool.NothingToClaim.selector);
        pool.claimWithdrawals();
    }

    function test_processUserWithdrawals_revertsWhenNoRequests() public {
        _initOperatorForPool();
        vm.prank(owner);
        vm.expectRevert(BlacklightPool.NothingToClaim.selector);
        pool.processUserWithdrawals(alice);
    }

    function test_claimWithdrawals_andProcessUserWithdrawals_payCorrectAmounts() public {
        _initOperatorForPool();
        nil.mint(alice, 15_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 15_000 * 1e6);
        pool.stake(15_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.startPrank(alice);
        pool.requestWithdraw(4_000 * 1e6);
        pool.requestWithdraw(3_000 * 1e6);
        vm.stopPrank();
        pool.processWithdrawalBatch(10);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();

        vm.prank(alice);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(alice), 7_000 * 1e6);
        assertEq(pool.totalPendingWithdrawals(), 0);
    }

    function test_processUserWithdrawals_keeperPath() public {
        _initOperatorForPool();
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(2_000 * 1e6);
        pool.processWithdrawalBatch(10);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();

        vm.prank(owner);
        pool.processUserWithdrawals(alice);
        assertEq(nil.balanceOf(alice), 2_000 * 1e6);
    }

    function test_processWithdrawalBatch_handlesMultipleUsers() public {
        _initOperatorForPool();

        address bob = makeAddr("bob");
        uint256 aliceAmount = 8_000 * 1e6;
        uint256 bobAmount = 12_000 * 1e6;

        // Alice stakes
        nil.mint(alice, aliceAmount);
        vm.startPrank(alice);
        nil.approve(address(pool), aliceAmount);
        pool.stake(aliceAmount);
        vm.stopPrank();

        // Bob stakes
        nil.mint(bob, bobAmount);
        vm.startPrank(bob);
        nil.approve(address(pool), bobAmount);
        pool.stake(bobAmount);
        vm.stopPrank();

        vm.prank(owner);
        pool.forwardStakeToNode();

        vm.prank(alice);
        pool.requestWithdraw(3_000 * 1e6);
        vm.prank(bob);
        pool.requestWithdraw(4_000 * 1e6);

        uint256 expectedTotal = 3_000 * 1e6 + 4_000 * 1e6;
        uint64 expectedUnlock = uint64(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER());

        vm.expectEmit(true, true, true, true);
        emit BlacklightPool.WithdrawalBatchProcessed(expectedTotal, expectedUnlock);
        pool.processWithdrawalBatch(10);

        assertEq(pool.totalUnstakingRequested(), expectedTotal);

        BlacklightPool.WithdrawalRequest[] memory qa = pool.getWithdrawalQueue(alice);
        BlacklightPool.WithdrawalRequest[] memory qb = pool.getWithdrawalQueue(bob);
        assertEq(qa[0].unlockTimestamp, expectedUnlock);
        assertEq(qb[0].unlockTimestamp, expectedUnlock);
    }

    function test_pullUnstakedFromStaking_updatesTotalUnstakingRequested() public {
        _initOperatorForPool();

        uint256 amount = 5_000 * 1e6;
        nil.mint(alice, amount);
        vm.startPrank(alice);
        nil.approve(address(pool), amount);
        pool.stake(amount);
        vm.stopPrank();

        // Forward NIL to node BEFORE requestWithdraw (invariant: unstaked NIL must be at node first)
        vm.prank(owner);
        pool.forwardStakeToNode();

        vm.prank(alice);
        pool.requestWithdraw(amount);

        pool.processWithdrawalBatch(10);
        assertEq(pool.totalUnstakingRequested(), amount);

        // After delay, unstaked NIL should be pulled back and totalUnstakingRequested reduced
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();
        assertEq(pool.totalUnstakingRequested(), 0);
    }

    /// @notice Test that usersWithPendingWithdrawals list is correctly maintained when
    ///         a user makes a new withdrawal after previous ones were processed and claimed.
    ///         This tests the fix for the bug where users weren't re-added to the list.
    function test_processWithdrawalBatch_newRequestAfterClaimedWithdrawal() public {
        _initOperatorForPool();

        uint256 stakeAmount = 20_000 * 1e6;
        uint256 firstWithdrawal = 5_000 * 1e6;
        uint256 secondWithdrawal = 3_000 * 1e6;

        // Alice stakes
        nil.mint(alice, stakeAmount);
        vm.startPrank(alice);
        nil.approve(address(pool), stakeAmount);
        pool.stake(stakeAmount);
        vm.stopPrank();

        vm.prank(owner);
        pool.forwardStakeToNode();

        // First withdrawal request
        vm.prank(alice);
        pool.requestWithdraw(firstWithdrawal);

        // Verify it's counted
        assertEq(pool.totalPendingWithdrawalRequestCount(), 1);
        assertEq(pool.totalPendingWithdrawals(), firstWithdrawal);

        // Process first withdrawal batch
        pool.processWithdrawalBatch(10);
        assertEq(pool.totalPendingWithdrawalRequestCount(), 0, "After processing, no unprocessed requests");

        // Wait for unlock and claim
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();
        vm.prank(alice);
        pool.claimWithdrawals();

        // Verify first withdrawal is claimed
        BlacklightPool.WithdrawalRequest[] memory q = pool.getWithdrawalQueue(alice);
        assertEq(q.length, 1);
        assertTrue(q[0].claimed);
        assertGt(q[0].unlockTimestamp, 0, "First withdrawal was processed and has unlockTimestamp set");

        // Make a NEW withdrawal request after the first one was claimed
        vm.prank(alice);
        pool.requestWithdraw(secondWithdrawal);

        // CRITICAL: The new withdrawal should be counted and processable
        assertEq(pool.totalPendingWithdrawalRequestCount(), 1, "New withdrawal should be counted");
        assertEq(pool.totalPendingWithdrawals(), secondWithdrawal);

        // Should be able to process the new withdrawal batch
        vm.expectEmit(true, true, true, true);
        emit BlacklightPool.WithdrawalBatchProcessed(
            secondWithdrawal, uint64(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER())
        );
        pool.processWithdrawalBatch(10);

        // Verify the new withdrawal was processed
        q = pool.getWithdrawalQueue(alice);
        assertEq(q.length, 2);
        assertTrue(q[0].claimed, "First withdrawal still claimed");
        assertEq(q[1].unlockTimestamp, uint64(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER()));
        assertFalse(q[1].claimed);
        assertFalse(q[1].cancelled);
    }

    /// @notice Test that usersWithPendingWithdrawals list is correctly maintained when
    ///         a user makes a new withdrawal after cancelling a previous one.
    function test_processWithdrawalBatch_newRequestAfterCancelledWithdrawal() public {
        _initOperatorForPool();

        uint256 stakeAmount = 20_000 * 1e6;
        uint256 firstWithdrawal = 5_000 * 1e6;
        uint256 secondWithdrawal = 3_000 * 1e6;

        // Alice stakes
        nil.mint(alice, stakeAmount);
        vm.startPrank(alice);
        nil.approve(address(pool), stakeAmount);
        pool.stake(stakeAmount);
        vm.stopPrank();

        vm.prank(owner);
        pool.forwardStakeToNode();

        // First withdrawal request
        vm.prank(alice);
        pool.requestWithdraw(firstWithdrawal);

        // Verify it's counted
        assertEq(pool.totalPendingWithdrawalRequestCount(), 1);
        assertEq(pool.totalPendingWithdrawals(), firstWithdrawal);

        // Cancel the first withdrawal
        vm.prank(alice);
        pool.cancelPendingWithdrawal(0);

        // Verify it's cancelled and not counted
        assertEq(pool.totalPendingWithdrawalRequestCount(), 0);
        assertEq(pool.totalPendingWithdrawals(), 0);

        BlacklightPool.WithdrawalRequest[] memory q = pool.getWithdrawalQueue(alice);
        assertEq(q.length, 1);
        assertTrue(q[0].cancelled);

        // Make a NEW withdrawal request after cancelling the first one
        vm.prank(alice);
        pool.requestWithdraw(secondWithdrawal);

        // CRITICAL: The new withdrawal should be counted and processable
        assertEq(pool.totalPendingWithdrawalRequestCount(), 1, "New withdrawal should be counted");
        assertEq(pool.totalPendingWithdrawals(), secondWithdrawal);

        // Should be able to process the new withdrawal batch
        pool.processWithdrawalBatch(10);

        // Verify the new withdrawal was processed
        q = pool.getWithdrawalQueue(alice);
        assertEq(q.length, 2);
        assertTrue(q[0].cancelled, "First withdrawal still cancelled");
        assertEq(q[1].unlockTimestamp, uint64(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER()));
        assertFalse(q[1].claimed);
        assertFalse(q[1].cancelled);
    }

    /// @notice Test that multiple withdrawals from the same user are correctly tracked
    ///         even when some are processed and others remain pending.
    function test_processWithdrawalBatch_multipleRequestsWithPartialProcessing() public {
        _initOperatorForPool();

        uint256 stakeAmount = 30_000 * 1e6;
        uint256 withdrawal1 = 5_000 * 1e6;
        uint256 withdrawal2 = 4_000 * 1e6;
        uint256 withdrawal3 = 3_000 * 1e6;

        // Alice stakes
        nil.mint(alice, stakeAmount);
        vm.startPrank(alice);
        nil.approve(address(pool), stakeAmount);
        pool.stake(stakeAmount);
        vm.stopPrank();

        vm.prank(owner);
        pool.forwardStakeToNode();

        // Make three withdrawal requests
        vm.startPrank(alice);
        pool.requestWithdraw(withdrawal1);
        pool.requestWithdraw(withdrawal2);
        pool.requestWithdraw(withdrawal3);
        vm.stopPrank();

        // All three should be counted
        assertEq(pool.totalPendingWithdrawalRequestCount(), 3);
        assertEq(pool.totalPendingWithdrawals(), withdrawal1 + withdrawal2 + withdrawal3);

        // Process only the first two (maxEntries = 2)
        pool.processWithdrawalBatch(2);

        // Only one should remain unprocessed (totalPendingWithdrawalRequestCount counts only unprocessed)
        // But totalPendingWithdrawals still includes all unclaimed withdrawals (processed + unprocessed)
        assertEq(pool.totalPendingWithdrawalRequestCount(), 1, "One request should remain unprocessed");
        assertEq(pool.totalPendingWithdrawals(), withdrawal1 + withdrawal2 + withdrawal3, "totalPendingWithdrawals includes all unclaimed");

        // Verify first two were processed
        BlacklightPool.WithdrawalRequest[] memory q = pool.getWithdrawalQueue(alice);
        assertEq(q.length, 3);
        assertGt(q[0].unlockTimestamp, 0, "First withdrawal processed");
        assertGt(q[1].unlockTimestamp, 0, "Second withdrawal processed");
        assertEq(q[2].unlockTimestamp, 0, "Third withdrawal still pending");

        // Process the remaining one
        pool.processWithdrawalBatch(10);
        assertEq(pool.totalPendingWithdrawalRequestCount(), 0, "All requests processed");
        q = pool.getWithdrawalQueue(alice);
        assertGt(q[2].unlockTimestamp, 0, "Third withdrawal now processed");
    }

    /// @notice Test that totalPendingWithdrawalRequestCount correctly counts only
    ///         unprocessed withdrawals (unlockTimestamp == 0 && !claimed && !cancelled).
    function test_totalPendingWithdrawalRequestCount_countsOnlyUnprocessed() public {
        _initOperatorForPool();

        uint256 stakeAmount = 30_000 * 1e6;
        nil.mint(alice, stakeAmount);
        vm.startPrank(alice);
        nil.approve(address(pool), stakeAmount);
        pool.stake(stakeAmount);
        vm.stopPrank();

        vm.prank(owner);
        pool.forwardStakeToNode();

        // Make three withdrawal requests
        vm.startPrank(alice);
        pool.requestWithdraw(5_000 * 1e6);
        pool.requestWithdraw(4_000 * 1e6);
        pool.requestWithdraw(3_000 * 1e6);
        vm.stopPrank();

        assertEq(pool.totalPendingWithdrawalRequestCount(), 3);

        // Process all
        pool.processWithdrawalBatch(10);
        assertEq(pool.totalPendingWithdrawalRequestCount(), 0, "All processed, none pending");

        // Wait and claim all
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();
        vm.prank(alice);
        pool.claimWithdrawals();

        // Still should be 0 (all claimed)
        assertEq(pool.totalPendingWithdrawalRequestCount(), 0);

        // Make a new withdrawal
        vm.prank(alice);
        pool.requestWithdraw(2_000 * 1e6);

        // Should now be 1
        assertEq(pool.totalPendingWithdrawalRequestCount(), 1, "New withdrawal counted");
    }

    function test_partialIdleNIL_fulfillsInOrderUpToBalance() public {
        _initOperatorForPool();
        // Two requests 3k and 4k. Process only first (maxEntries=1), so only 3k gets unlockTimestamp.
        // Pull 3k; claim 3k. Second request stays pending until next batch.
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.startPrank(alice);
        pool.requestWithdraw(3_000 * 1e6);
        pool.requestWithdraw(4_000 * 1e6);
        vm.stopPrank();
        pool.processWithdrawalBatch(1); // only first request processed
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();
        vm.prank(alice);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(alice), 3_000 * 1e6);
        assertEq(pool.totalPendingWithdrawals(), 4_000 * 1e6);
        // Process second request, warp, pull, claim rest
        pool.processWithdrawalBatch(10);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();
        vm.prank(alice);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(alice), 7_000 * 1e6);
        assertEq(pool.totalPendingWithdrawals(), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SECURITY: Permissionless functions — no fund theft / lock / redirect
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Attacker calling processUserWithdrawals(victim) must not receive victim's NIL; victim must.
    function test_security_processUserWithdrawals_sendsToUserNotCaller() public {
        _initOperatorForPool();
        address attacker = makeAddr("attacker");
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(2_000 * 1e6);
        pool.processWithdrawalBatch(10);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();

        uint256 aliceBefore = nil.balanceOf(alice);
        uint256 attackerBefore = nil.balanceOf(attacker);
        vm.prank(attacker);
        pool.processUserWithdrawals(alice);

        assertEq(nil.balanceOf(alice), aliceBefore + 2_000 * 1e6, "alice receives her withdrawal");
        assertEq(nil.balanceOf(attacker), attackerBefore, "attacker receives nothing");
    }

    /// @notice processWithdrawalBatch does not send tokens to caller.
    function test_security_processWithdrawalBatch_sendsNoTokensToCaller() public {
        _initOperatorForPool();
        address caller = makeAddr("randomCaller");
        nil.mint(alice, 5_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 5_000 * 1e6);
        pool.stake(5_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(2_000 * 1e6);

        uint256 callerBefore = nil.balanceOf(caller);
        vm.prank(caller);
        pool.processWithdrawalBatch(10);
        assertEq(nil.balanceOf(caller), callerBefore, "caller receives no tokens");
    }

    /// @notice pullUnstakedFromStaking sends NIL to the pool, not to caller.
    function test_security_pullUnstakedFromStaking_sendsToPoolNotCaller() public {
        _initOperatorForPool();
        address caller = makeAddr("randomCaller");
        uint256 amount = 5_000 * 1e6;
        nil.mint(alice, amount);
        vm.startPrank(alice);
        nil.approve(address(pool), amount);
        pool.stake(amount);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(amount);
        pool.processWithdrawalBatch(10);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);

        uint256 poolBefore = nil.balanceOf(address(pool));
        uint256 callerBefore = nil.balanceOf(caller);
        vm.prank(caller);
        pool.pullUnstakedFromStaking();

        assertEq(nil.balanceOf(address(pool)), poolBefore + amount, "pool receives unstaked NIL");
        assertEq(nil.balanceOf(caller), callerBefore, "caller receives nothing");
    }

    /// @notice claimWithdrawals only sends to msg.sender (no recipient parameter).
    function test_security_claimWithdrawals_sendsOnlyToMsgSender() public {
        _initOperatorForPool();
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        vm.prank(alice);
        pool.requestWithdraw(3_000 * 1e6);
        pool.processWithdrawalBatch(10);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();

        uint256 aliceBefore = nil.balanceOf(alice);
        vm.prank(alice);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(alice), aliceBefore + 3_000 * 1e6, "alice receives her claim");
    }

    /// @notice When idle balance is less than one user's total claimable, only up to idle is transferred (FIFO within user).
    function test_security_claimPartialIdle_doesNotExceedBalance() public {
        _initOperatorForPool();
        address bob = makeAddr("bob");
        address carol = makeAddr("carol");
        address dave = makeAddr("dave");
        nil.mint(alice, 30_000 * 1e6);
        nil.mint(carol, 13_000 * 1e6);
        nil.mint(dave, 5_000 * 1e6);
        nil.mint(bob, 8_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 30_000 * 1e6);
        pool.stake(30_000 * 1e6);
        vm.stopPrank();
        vm.startPrank(carol);
        nil.approve(address(pool), 13_000 * 1e6);
        pool.stake(13_000 * 1e6);
        vm.stopPrank();
        vm.startPrank(dave);
        nil.approve(address(pool), 5_000 * 1e6);
        pool.stake(5_000 * 1e6);
        vm.stopPrank();
        vm.startPrank(bob);
        nil.approve(address(pool), 8_000 * 1e6);
        pool.stake(8_000 * 1e6);
        vm.stopPrank();

        // Forward NIL to node BEFORE any requestWithdraw (invariant: unstaked NIL must be at node first)
        vm.prank(owner);
        pool.forwardStakeToNode();

        vm.prank(alice);
        pool.requestWithdraw(30_000 * 1e6);
        vm.prank(carol);
        pool.requestWithdraw(13_000 * 1e6);
        vm.prank(dave);
        pool.requestWithdraw(5_000 * 1e6);
        vm.prank(bob);
        pool.requestWithdraw(3_000 * 1e6);
        vm.prank(bob);
        pool.requestWithdraw(5_000 * 1e6);
        // Process only 4 entries so 51k is unstaked (alice 30k, carol 13k, dave 5k, bob 3k); bob's 5k stays unprocessed
        pool.processWithdrawalBatch(4);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();
        vm.prank(alice);
        pool.claimWithdrawals();
        vm.prank(carol);
        pool.claimWithdrawals();
        vm.prank(dave);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(address(pool)), 3_000 * 1e6, "pool has 3k idle before bob");
        vm.prank(bob);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(bob), 3_000 * 1e6, "bob gets only first request (3k) due to partial liquidity");
        assertEq(pool.totalPendingWithdrawals(), 5_000 * 1e6, "5k request still pending until more liquidity");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TOTAL PROCESSING STAKE & getStakerStakeBreakdown
    // ═══════════════════════════════════════════════════════════════════

    function test_totalProcessingStake_increasesOnStake_decreasesOnWithdrawProcessingAndForward() public {
        assertEq(pool.totalProcessingStake(), 0, "initial");
        nil.mint(alice, 20_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 20_000 * 1e6);
        pool.stake(10_000 * 1e6);
        assertEq(pool.totalProcessingStake(), 10_000 * 1e6, "after stake");
        pool.stake(10_000 * 1e6);
        assertEq(pool.totalProcessingStake(), 20_000 * 1e6, "after second stake");
        vm.stopPrank();

        _initOperatorForPool();
        vm.prank(alice);
        pool.withdrawProcessingStake(5_000 * 1e6);
        assertEq(pool.totalProcessingStake(), 15_000 * 1e6, "after withdrawProcessingStake(5k)");
        vm.prank(owner);
        pool.forwardStakeToNode();
        assertEq(pool.totalProcessingStake(), 0, "after forward (all forwarded)");
    }

    /// @notice If owner forwards stake to node, staker's processing stake becomes 0; withdrawProcessingStake reverts.
    function test_withdrawProcessingStake_revertsAfterForwardStakeToNode() public {
        _initOperatorForPool();
        uint256 amount = 10_000 * 1e6;
        nil.mint(alice, amount);
        vm.startPrank(alice);
        nil.approve(address(pool), amount);
        pool.stake(amount);
        vm.stopPrank();
        (uint256 proc, uint256 staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(proc, amount);
        assertEq(staked, 0);

        vm.prank(owner);
        pool.forwardStakeToNode();

        (proc, staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(proc, 0);
        assertEq(staked, amount);

        vm.prank(alice);
        vm.expectRevert(BlacklightPool.InsufficientProcessingStake.selector);
        pool.withdrawProcessingStake(1);
    }

    /// @notice Staker may withdraw all processing stake (remaining == 0); must not revert with BelowMinimumStake.
    function test_withdrawProcessingStake_allowsWithdrawAll() public {
        _initOperatorForPool();
        uint256 amount = 1_000 * 1e6; // exactly 1000 NIL; pool minStakePerUser is 500
        nil.mint(alice, amount);
        vm.startPrank(alice);
        nil.approve(address(pool), amount);
        pool.stake(amount);
        vm.stopPrank();
        (uint256 proc, uint256 staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(proc, amount);
        assertEq(staked, 0);
        assertTrue(pool.isStaker(alice));
        assertEq(pool.stakerCount(), 2); // operator + alice

        vm.prank(alice);
        pool.withdrawProcessingStake(amount); // withdraw all

        (proc, staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(proc, 0);
        assertEq(staked, 0);
        assertEq(nil.balanceOf(alice), amount);
        assertFalse(pool.isStaker(alice));
        assertEq(pool.stakerCount(), 1);
        assertEq(pool.totalProcessingStake(), 0);
        // totalUserStakes may still include owner's stake (from initOwnerNodeStake), so do not assert 0
    }

    /// @notice Staker with exactly minStakePerUser in processing can withdraw all (remaining == 0).
    function test_withdrawProcessingStake_allowsWithdrawAll_atMinStake() public {
        _initOperatorForPool();
        nil.mint(alice, MIN_STAKE);
        vm.startPrank(alice);
        nil.approve(address(pool), MIN_STAKE);
        pool.stake(MIN_STAKE);
        vm.stopPrank();
        assertEq(pool.minStakePerUser(), MIN_STAKE);

        vm.prank(alice);
        pool.withdrawProcessingStake(MIN_STAKE); // withdraw all; remaining 0 must not revert

        (uint256 proc, uint256 staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(proc, 0);
        assertEq(staked, 0);
        assertEq(nil.balanceOf(alice), MIN_STAKE);
        assertFalse(pool.isStaker(alice));
    }

    function test_getStakerStakeBreakdown_processingAndAtNode() public {
        _initOperatorForPool();
        address bob = makeAddr("bob");
        nil.mint(alice, 12_000 * 1e6);
        nil.mint(bob, 8_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 12_000 * 1e6);
        pool.stake(12_000 * 1e6);
        vm.stopPrank();
        vm.startPrank(bob);
        nil.approve(address(pool), 8_000 * 1e6);
        pool.stake(8_000 * 1e6);
        vm.stopPrank();
        assertEq(pool.totalProcessingStake(), 20_000 * 1e6, "all processing");
        (uint256 aliceProc, uint256 aliceNode) = pool.getStakerStakeBreakdown(alice);
        (uint256 bobProc, uint256 bobNode) = pool.getStakerStakeBreakdown(bob);
        assertEq(aliceProc, 12_000 * 1e6, "alice processing");
        assertEq(aliceNode, 0, "alice atNode before forward");
        assertEq(bobProc, 8_000 * 1e6, "bob processing");
        assertEq(bobNode, 0, "bob atNode before forward");

        vm.prank(owner);
        pool.forwardStakeToNode();
        assertEq(pool.totalProcessingStake(), 0, "none processing after forward");
        (aliceProc, aliceNode) = pool.getStakerStakeBreakdown(alice);
        (bobProc, bobNode) = pool.getStakerStakeBreakdown(bob);
        assertEq(aliceProc, 0, "alice processing after forward");
        assertEq(aliceNode, 12_000 * 1e6, "alice atNode");
        assertEq(bobProc, 0, "bob processing after forward");
        assertEq(bobNode, 8_000 * 1e6, "bob atNode");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  E2E WORKFLOW: processing stake → partial withdraw → forward → request → batch → claim
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Full workflow: (1) stake → processing, (2) partial withdraw processing,
    ///         (3) forward to node → processing 0 / staked updated, (4) request withdraw → pending,
    ///         (5) keeper processWithdrawalBatch → unbonding set, (6) after 8 days claim → pool drops.
    function test_e2e_workflow_processingToStakedToPendingToClaim() public {
        _initOperatorForPool();
        uint256 stakeAmount = 20_000 * 1e6;
        nil.mint(alice, stakeAmount);
        vm.startPrank(alice);
        nil.approve(address(pool), stakeAmount);
        pool.stake(stakeAmount);
        vm.stopPrank();

        (uint256 proc, uint256 staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(proc, stakeAmount, "1. stake -> processing");
        assertEq(staked, 0);
        assertEq(pool.totalProcessingStake(), stakeAmount);

        uint256 withdrawProcessingAmount = 5_000 * 1e6;
        vm.prank(alice);
        pool.withdrawProcessingStake(withdrawProcessingAmount);
        (proc, staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(proc, stakeAmount - withdrawProcessingAmount, "2. partial withdraw processing");
        assertEq(staked, 0);
        assertEq(pool.totalProcessingStake(), stakeAmount - withdrawProcessingAmount);
        assertEq(nil.balanceOf(alice), withdrawProcessingAmount);

        vm.prank(owner);
        pool.forwardStakeToNode();
        (proc, staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(proc, 0, "3. forward -> processing 0");
        assertEq(staked, stakeAmount - withdrawProcessingAmount);
        assertEq(pool.totalProcessingStake(), 0);

        uint256 requestAmount = 3_000 * 1e6;
        uint256 totalUserBefore = pool.totalUserStakes();
        vm.prank(alice);
        pool.requestWithdraw(requestAmount);
        assertEq(pool.totalPendingWithdrawals(), requestAmount, "4. request -> pending");
        assertEq(pool.totalUserStakes(), totalUserBefore, "totals unchanged until batch");
        assertEq(pool.totalStakedAtNode(), totalUserBefore, "totalStakedAtNode = node stake until batch");
        (proc, staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(staked, stakeAmount - withdrawProcessingAmount, "staked unchanged until batch");

        vm.prank(owner);
        pool.processWithdrawalBatch(10);
        assertEq(pool.totalUserStakes(), totalUserBefore - requestAmount);
        assertEq(pool.totalStakedAtNode(), totalUserBefore - requestAmount);
        (proc, staked) = pool.getStakerStakeBreakdown(alice);
        assertEq(staked, stakeAmount - withdrawProcessingAmount - requestAmount);
        assertEq(pool.totalUnstakingRequested(), requestAmount, "5. batch -> unbonding");
        BlacklightPool.WithdrawalRequest[] memory q = pool.getWithdrawalQueue(alice);
        assertEq(q.length, 1);
        assertGt(q[0].unlockTimestamp, 0);

        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();
        uint256 poolIdleBefore = nil.balanceOf(address(pool));
        uint256 aliceBefore = nil.balanceOf(alice);
        vm.prank(alice);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(alice), aliceBefore + requestAmount, "6. claim -> staker receives");
        assertEq(nil.balanceOf(address(pool)), poolIdleBefore - requestAmount, "6. pool idle drops");
        assertEq(pool.totalPendingWithdrawals(), 0);
        q = pool.getWithdrawalQueue(alice);
        assertTrue(q[0].claimed);
    }

    /// @notice Invariant: totalProcessingStake + staking.stakeOf(operator) = totalUserStakes (total pool funds backing stakers).
    ///         Also totalProcessingStake <= pool NIL balance.
    function test_invariant_totalProcessingStake_plus_stakeAtNode_equals_totalUserStakes_afterStake() public {
        assertEq(pool.totalProcessingStake() + staking.stakeOf(pool.operator()), pool.totalUserStakes(), "initial 0+0=0");
        nil.mint(alice, 30_000 * 1e6);
        vm.prank(alice);
        nil.approve(address(pool), 30_000 * 1e6);
        vm.prank(alice);
        pool.stake(30_000 * 1e6);
        assertEq(pool.totalProcessingStake(), 30_000 * 1e6, "processing = staked");
        assertLe(pool.totalProcessingStake(), nil.balanceOf(address(pool)), "processing <= balance");
        assertEq(pool.totalProcessingStake() + staking.stakeOf(pool.operator()), pool.totalUserStakes(), "processing+0=total");
    }

    function test_invariant_totalProcessingStake_plus_stakeAtNode_equals_totalUserStakes_afterForward() public {
        _initOperatorForPool();
        nil.mint(alice, 50_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 50_000 * 1e6);
        pool.stake(50_000 * 1e6);
        vm.stopPrank();
        assertEq(pool.totalProcessingStake() + staking.stakeOf(pool.operator()), pool.totalUserStakes(), "after stake");
        vm.prank(owner);
        pool.forwardStakeToNode();
        assertEq(pool.totalProcessingStake(), 0, "no processing after forward");
        assertEq(pool.totalProcessingStake() + staking.stakeOf(pool.operator()), pool.totalUserStakes(), "0+atNode=total");
        assertGe(staking.stakeOf(pool.operator()), 50_000 * 1e6 + OPERATOR_INIT_STAKE, "node has init+50k");
    }

    function test_invariant_totalProcessingStake_plus_stakeAtNode_equals_totalUserStakes_afterRequestWithdraw() public {
        _initOperatorForPool();
        nil.mint(alice, 40_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 40_000 * 1e6);
        pool.stake(40_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        assertEq(pool.totalProcessingStake() + staking.stakeOf(pool.operator()), pool.totalUserStakes(), "after forward");
        vm.prank(alice);
        pool.requestWithdraw(10_000 * 1e6);
        // totalUserStakes and totalStakedAtNode unchanged until processWithdrawalBatch; sum(stakers.staked) = node stake
        assertEq(pool.totalUserStakes(), 130_000 * 1e6, "totalUserStakes unchanged until batch");
        assertEq(pool.totalStakedAtNode(), staking.stakeOf(pool.operator()), "totalStakedAtNode = node stake");
        assertEq(pool.totalProcessingStake() + staking.stakeOf(pool.operator()), pool.totalUserStakes(), "processing+node=totalUserStakes");
    }

    function test_invariant_totalProcessingStake_plus_stakeAtNode_equals_totalUserStakes_partialForward() public {
        _initOperatorForPool();
        nil.mint(alice, 100_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 100_000 * 1e6);
        pool.stake(100_000 * 1e6);
        vm.stopPrank();
        uint256 atNodeBefore = staking.stakeOf(pool.operator());
        vm.prank(owner);
        pool.forwardStakeToNode();
        assertEq(pool.totalProcessingStake(), 0, "all forwarded");
        assertEq(pool.totalProcessingStake() + staking.stakeOf(pool.operator()), pool.totalUserStakes(), "0+atNode=total");
        assertEq(staking.stakeOf(pool.operator()), atNodeBefore + 100_000 * 1e6, "node increased by 100k");
        assertEq(nil.balanceOf(address(pool)), 0, "pool balance 0");
    }

    function test_invariant_poolBalance_plus_stakeAtNode_equals_totalUserStakes_plus_pendingWithdrawals() public {
        _initOperatorForPool();
        nil.mint(alice, 25_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 25_000 * 1e6);
        pool.stake(25_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        uint256 poolBal = nil.balanceOf(address(pool));
        uint256 atNode = staking.stakeOf(pool.operator());
        assertEq(poolBal + atNode, pool.totalUserStakes(), "balance+node=totalUserStakes (no pending)");
        vm.prank(alice);
        pool.requestWithdraw(5_000 * 1e6);
        poolBal = nil.balanceOf(address(pool));
        atNode = staking.stakeOf(pool.operator());
        assertEq(poolBal + atNode, pool.totalUserStakes(), "balance+node=totalUserStakes (with pending; totals unchanged until batch)");
    }

    /// @notice initialize() has no access control: first caller sets owner. Use factory (same-tx init) to avoid front-run.
    function test_security_initialize_noAccessControl_firstCallerBecomesOwner() public {
        BlacklightPool p = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        address intendedOwner = makeAddr("intendedOwner");
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        p.initialize(operatorNode, attacker, COMMISSION_BPS, MIN_STAKE);
        assertEq(p.owner(), attacker, "first caller becomes owner");
        vm.prank(intendedOwner);
        vm.expectRevert(BlacklightPool.AlreadyInitialized.selector);
        p.initialize(operatorNode, intendedOwner, COMMISSION_BPS, MIN_STAKE);
    }

    /// @notice Owner cannot withdraw staker funds to themselves. forwardStakeToNode sends to staking; claimVerifierRewards sends to pool.
    function test_security_ownerCannotWithdrawStakerFundsToSelf() public {
        _initOperatorForPool();
        uint256 aliceStake = 10_000 * 1e6;
        nil.mint(alice, aliceStake);
        vm.startPrank(alice);
        nil.approve(address(pool), aliceStake);
        pool.stake(aliceStake);
        vm.stopPrank();
        assertEq(nil.balanceOf(address(pool)), aliceStake, "pool holds alice's stake");

        uint256 ownerBefore = nil.balanceOf(owner);
        // Owner forwards to node: NIL goes to staking contract, not owner
        vm.prank(owner);
        pool.forwardStakeToNode();
        assertEq(nil.balanceOf(owner), ownerBefore, "owner did not receive NIL from forwardStakeToNode");
        assertEq(nil.balanceOf(address(staking)), aliceStake, "NIL is in staking contract");

        // If reward policy had rewards, claimVerifierRewards sends to pool, not owner
        nil.mint(address(rewardPolicy), 1_000 * 1e6);
        rewardPolicy.setRewards(address(pool), 1_000 * 1e6);
        vm.prank(owner);
        pool.claimVerifierRewards();
        assertEq(nil.balanceOf(owner), ownerBefore, "owner did not receive NIL from claimVerifierRewards");
        assertEq(nil.balanceOf(address(pool)), 1_000 * 1e6, "rewards went to pool");
    }

    /// @notice requestWithdraw only deducts from msg.sender; other stakers' balances are unchanged.
    function test_security_requestWithdraw_onlyAffectsCaller() public {
        _initOperatorForPool();
        address bob = makeAddr("bob");
        nil.mint(alice, 5_000 * 1e6);
        nil.mint(bob, 5_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 5_000 * 1e6);
        pool.stake(5_000 * 1e6);
        vm.stopPrank();
        vm.startPrank(bob);
        nil.approve(address(pool), 5_000 * 1e6);
        pool.stake(5_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();

        vm.prank(alice);
        pool.requestWithdraw(2_000 * 1e6);

        (uint256 aliceProc, uint256 aliceStaked,,) = pool.stakers(alice);
        (uint256 bobProc, uint256 bobStaked,,) = pool.stakers(bob);
        assertEq(aliceStaked, 5_000 * 1e6, "alice staked unchanged until batch");
        assertEq(pool.getPendingWithdrawalSum(alice), 2_000 * 1e6, "alice has 2k pending");
        assertEq(bobProc + bobStaked, 5_000 * 1e6, "bob balance unchanged");
    }

    /// @notice stake() only pulls from msg.sender; another address cannot be drained by a third party.
    function test_security_stake_onlyPullsFromCaller() public {
        _initOperatorForPool();
        address attacker = makeAddr("attacker");
        nil.mint(alice, 10_000 * 1e6);
        nil.mint(attacker, MIN_STAKE);
        vm.prank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        // Attacker stakes their own MIN_STAKE; alice's balance should be untouched
        vm.prank(attacker);
        nil.approve(address(pool), MIN_STAKE);
        vm.prank(attacker);
        pool.stake(MIN_STAKE);
        assertEq(nil.balanceOf(alice), 10_000 * 1e6, "alice's tokens untouched");
        assertEq(nil.balanceOf(attacker), 0, "attacker's tokens staked");
        assertEq(nil.balanceOf(address(pool)), MIN_STAKE, "only attacker's amount in pool");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  REWARD DISTRIBUTION (settleEpoch)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice settleEpoch with no claimable rewards is a no-op; epoch not incremented.
    function test_settleEpoch_noRewards_isNoOp() public {
        _initOperatorForPool();
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        uint256 epochBefore = pool.epochNumber();
        pool.settleEpoch(); // no rewards set on policy
        assertEq(pool.epochNumber(), epochBefore, "epoch unchanged when no rewards");
    }

    /// @notice settleEpoch claims rewards and distributes: platform 1%, owner commission, rest to stakers by staked.
    function test_settleEpoch_distributesPlatformFeeAndCommissionAndStakers() public {
        _initOperatorForPool();
        uint256 aliceStake = 10_000 * 1e6;
        nil.mint(alice, aliceStake);
        vm.startPrank(alice);
        nil.approve(address(pool), aliceStake);
        pool.stake(aliceStake);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        // Owner has 90k staked, alice has 10k staked. totalStakedAtNode = 100k.
        uint256 rewardAmount = 10_000 * 1e6; // 10k NIL reward
        nil.mint(address(rewardPolicy), rewardAmount);
        rewardPolicy.setRewards(address(pool), rewardAmount);

        uint256 platformBefore = nil.balanceOf(platformFeeRecipient);
        uint256 ownerBefore = nil.balanceOf(owner);
        uint256 aliceBefore = nil.balanceOf(alice);
        uint256 poolBefore = nil.balanceOf(address(pool));

        pool.settleEpoch();

        uint256 platformFee = (rewardAmount * pool.PLATFORM_FEE_BPS()) / pool.BPS_DENOMINATOR(); // 1% = 100
        uint256 afterPlatform = rewardAmount - platformFee;
        uint256 ownerCommission = (afterPlatform * COMMISSION_BPS) / pool.BPS_DENOMINATOR(); // 5% of 9900 = 495
        uint256 toStakers = afterPlatform - ownerCommission; // 9900 - 495 = 9405
        // Owner staked 90k, alice 10k → owner gets 90% of toStakers, alice 10%
        uint256 ownerStakerShare = (90_000 * 1e6 * toStakers) / (100_000 * 1e6);
        uint256 aliceStakerShare = toStakers - ownerStakerShare;

        assertEq(nil.balanceOf(platformFeeRecipient), platformBefore + platformFee);
        assertEq(nil.balanceOf(owner), ownerBefore + ownerCommission + ownerStakerShare);
        assertEq(nil.balanceOf(alice), aliceBefore + aliceStakerShare);
        assertEq(pool.epochNumber(), 1);
        // No idle NIL from rewards: pool balance unchanged (we had poolBefore, claimed +rewardAmount, sent out rewardAmount)
        assertEq(nil.balanceOf(address(pool)), poolBefore);
    }

    /// @notice Reward distribution is based on "staked" only; processing stake gets no share.
    function test_settleEpoch_distributionProportionalToStakedNotProcessingStake() public {
        _initOperatorForPool();
        address bob = makeAddr("bob");
        nil.mint(alice, 20_000 * 1e6);
        nil.mint(bob, 20_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 20_000 * 1e6);
        pool.stake(10_000 * 1e6); // 10k processing, 0 staked
        vm.stopPrank();
        vm.startPrank(bob);
        nil.approve(address(pool), 20_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        // After forward: owner 90k staked, alice 10k staked, bob 10k staked. totalStakedAtNode = 110k.
        // Alice has 0 processing, 10k staked. Bob has 0 processing, 10k staked.
        uint256 rewardAmount = 11_000 * 1e6; // 11k NIL so math is easy
        nil.mint(address(rewardPolicy), rewardAmount);
        rewardPolicy.setRewards(address(pool), rewardAmount);

        uint256 aliceBefore = nil.balanceOf(alice);
        uint256 bobBefore = nil.balanceOf(bob);

        pool.settleEpoch();

        uint256 platformFee = (rewardAmount * 100) / 10_000; // 110
        uint256 afterPlatform = rewardAmount - platformFee;
        uint256 ownerCommission = (afterPlatform * COMMISSION_BPS) / 10_000;
        uint256 toStakers = afterPlatform - ownerCommission;
        // Owner 90k, alice 10k, bob 10k → owner 90/110, alice 10/110, bob 10/110 of toStakers
        uint256 aliceShare = (10_000 * 1e6 * toStakers) / (110_000 * 1e6);
        uint256 bobShare = (10_000 * 1e6 * toStakers) / (110_000 * 1e6);
        assertEq(nil.balanceOf(alice), aliceBefore + aliceShare, "alice gets share by staked");
        assertEq(nil.balanceOf(bob), bobBefore + bobShare, "bob gets share by staked");
    }

    /// @notice After settleEpoch there is no idle NIL in the contract from the claimed reward.
    function test_settleEpoch_noIdleNilFromRewards() public {
        _initOperatorForPool();
        nil.mint(alice, 5_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 5_000 * 1e6);
        pool.stake(5_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        uint256 poolBalanceBeforeSettle = nil.balanceOf(address(pool));
        uint256 rewardAmount = 1_000 * 1e6;
        nil.mint(address(rewardPolicy), rewardAmount);
        rewardPolicy.setRewards(address(pool), rewardAmount);

        pool.settleEpoch();

        assertEq(
            nil.balanceOf(address(pool)),
            poolBalanceBeforeSettle,
            "pool balance unchanged: all claimed reward distributed, no idle NIL"
        );
    }

    /// @notice When totalStakedAtNode is 0 (e.g. Idle phase with rewards), staker portion goes to owner.
    function test_settleEpoch_whenNoStakedAtNode_sendsStakerPortionToOwner() public {
        // Idle phase: no initOwnerNodeStake, no forwardStakeToNode. totalStakedAtNode = 0.
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        uint256 rewardAmount = 1_000 * 1e6;
        nil.mint(address(rewardPolicy), rewardAmount);
        rewardPolicy.setRewards(address(pool), rewardAmount);

        uint256 ownerBefore = nil.balanceOf(owner);
        pool.settleEpoch();
        uint256 platformFee = (rewardAmount * 100) / 10_000;
        uint256 afterPlatform = rewardAmount - platformFee;
        uint256 ownerCommission = (afterPlatform * COMMISSION_BPS) / 10_000;
        uint256 toStakers = afterPlatform - ownerCommission;
        assertEq(nil.balanceOf(owner), ownerBefore + ownerCommission + toStakers, "owner gets commission + full staker portion when no staked");
        assertEq(nil.balanceOf(address(pool)), 10_000 * 1e6, "only alice's processing stake remains in pool");
    }

    /// @notice Keeper (platform fee recipient) can call settleEpoch.
    function test_settleEpoch_callableByKeeper() public {
        _initOperatorForPool();
        nil.mint(alice, 5_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 5_000 * 1e6);
        pool.stake(5_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
        nil.mint(address(rewardPolicy), 1_000 * 1e6);
        rewardPolicy.setRewards(address(pool), 1_000 * 1e6);

        vm.prank(platformFeeRecipient);
        pool.settleEpoch();

        assertEq(pool.epochNumber(), 1);
        assertGt(nil.balanceOf(platformFeeRecipient), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SHUTDOWN (Active pools only; 1-day cooling-off; initiator can cancel)
    // ═══════════════════════════════════════════════════════════════════

    function test_initiateShutdown_ownerOnly() public {
        _initOperatorForPool();

        vm.prank(alice);
        vm.expectRevert(BlacklightPool.NotPoolOwner.selector);
        pool.initiateShutdown();

        vm.prank(owner);
        pool.initiateShutdown();

        assertEq(pool.shutdownInitiatedAt(), block.timestamp);
        assertEq(pool.shutdownInitiatedBy(), owner);
        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Active)); // still Active during cooling-off
    }

    function test_initiateShutdown_onlyForActivePool() public {
        // Pool is Idle (no initOwnerNodeStake)
        vm.prank(owner);
        vm.expectRevert(BlacklightPool.ShutdownOnlyForActive.selector);
        pool.initiateShutdown();
    }

    function test_initiateShutdownByKeeper_keeperOnly() public {
        _initOperatorForPool();

        vm.prank(alice);
        vm.expectRevert(BlacklightPool.NotPlatformFeeRecipient.selector);
        pool.initiateShutdownByKeeper();

        vm.prank(platformFeeRecipient);
        pool.initiateShutdownByKeeper();

        assertEq(pool.shutdownInitiatedAt(), block.timestamp);
        assertEq(pool.shutdownInitiatedBy(), platformFeeRecipient);
    }

    function test_initiateShutdownByKeeper_onlyForActivePool() public {
        vm.prank(platformFeeRecipient);
        vm.expectRevert(BlacklightPool.ShutdownOnlyForActive.selector);
        pool.initiateShutdownByKeeper();
    }

    function test_cancelShutdown_onlyInitiatorCanCancel_ownerInitiated() public {
        _initOperatorForPool();
        vm.prank(owner);
        pool.initiateShutdown();

        vm.prank(platformFeeRecipient);
        vm.expectRevert(BlacklightPool.NotAuthorizedToCancelShutdown.selector);
        pool.cancelShutdown();

        vm.prank(alice);
        vm.expectRevert(BlacklightPool.NotAuthorizedToCancelShutdown.selector);
        pool.cancelShutdown();

        vm.prank(owner);
        pool.cancelShutdown();

        assertEq(pool.shutdownInitiatedAt(), 0);
        assertEq(pool.shutdownInitiatedBy(), address(0));
    }

    function test_cancelShutdown_onlyInitiatorCanCancel_keeperInitiated() public {
        _initOperatorForPool();
        vm.prank(platformFeeRecipient);
        pool.initiateShutdownByKeeper();

        vm.prank(owner);
        vm.expectRevert(BlacklightPool.NotAuthorizedToCancelShutdown.selector);
        pool.cancelShutdown();

        vm.prank(platformFeeRecipient);
        pool.cancelShutdown();

        assertEq(pool.shutdownInitiatedAt(), 0);
        assertEq(pool.shutdownInitiatedBy(), address(0));
    }

    function test_confirmShutdown_afterCoolingOff_transitionsToShuttingDown() public {
        _initOperatorForPool();
        vm.prank(owner);
        pool.initiateShutdown();

        vm.warp(block.timestamp + pool.SHUTDOWN_COOLING_OFF_PERIOD() + 1);

        vm.prank(alice);
        pool.confirmShutdown();

        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.ShuttingDown));
    }

    function test_confirmShutdown_revertsBeforeCoolingOff() public {
        _initOperatorForPool();
        vm.prank(owner);
        pool.initiateShutdown();

        vm.prank(alice);
        vm.expectRevert(BlacklightPool.ShutdownNotPending.selector);
        pool.confirmShutdown();
    }

    function test_stake_revertsInShuttingDown() public {
        _initOperatorForPool();
        vm.prank(owner);
        pool.initiateShutdown();
        vm.warp(block.timestamp + pool.SHUTDOWN_COOLING_OFF_PERIOD() + 1);
        pool.confirmShutdown();

        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        vm.expectRevert(BlacklightPool.OperatorNotInitialized.selector);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
    }

    function test_requestWithdraw_bypasses70kFloorInShuttingDown() public {
        _initOperatorForPool();
        nil.mint(alice, 10_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 10_000 * 1e6);
        pool.stake(10_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();

        vm.prank(owner);
        pool.initiateShutdown();
        vm.warp(block.timestamp + pool.SHUTDOWN_COOLING_OFF_PERIOD() + 1);
        vm.prank(alice);
        pool.confirmShutdown();

        // Owner (90k staked) requests full exit - would normally revert (below 70k floor)
        vm.prank(owner);
        pool.requestWithdraw(OPERATOR_INIT_STAKE);
        assertEq(pool.totalPendingWithdrawals(), OPERATOR_INIT_STAKE);
        assertEq(pool.totalUserStakes(), OPERATOR_INIT_STAKE + 10_000 * 1e6, "totals unchanged until batch");
        vm.prank(owner);
        pool.processWithdrawalBatch(10);
        assertEq(pool.totalUserStakes(), 10_000 * 1e6); // only alice left
    }

    /// @notice forwardStakeToNode is permissionless; a non-owner (e.g. keeper) can call it.
    function test_forwardStakeToNode_callableByNonOwner() public {
        _initOperatorForPool();
        uint256 aliceStake = 10_000 * 1e6;
        nil.mint(alice, aliceStake);
        vm.startPrank(alice);
        nil.approve(address(pool), aliceStake);
        pool.stake(aliceStake);
        vm.stopPrank();

        assertEq(pool.totalProcessingStake(), aliceStake);
        assertEq(pool.totalStakedAtNode(), OPERATOR_INIT_STAKE);

        // Call as alice (not owner) — should succeed
        vm.prank(alice);
        pool.forwardStakeToNode();

        assertEq(pool.totalProcessingStake(), 0);
        assertEq(pool.totalStakedAtNode(), OPERATOR_INIT_STAKE + aliceStake);
        assertEq(pool.totalStakedAtNode(), staking.stakeOf(pool.operator()), "totalStakedAtNode = node stake");
        (uint256 proc, uint256 staked,,) = pool.stakers(alice);
        assertEq(proc, 0);
        assertEq(staked, aliceStake);
    }

    function test_forwardStakeToNode_revertsDuringShutdownPending() public {
        _initOperatorForPool();
        nil.mint(alice, 5_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 5_000 * 1e6);
        pool.stake(5_000 * 1e6);
        vm.stopPrank();

        vm.prank(owner);
        pool.initiateShutdown();

        vm.prank(alice);
        vm.expectRevert(BlacklightPool.OperatorNotInitialized.selector);
        pool.forwardStakeToNode();
    }

    function test_getShutdownStatus_returnsCorrectValues() public {
        _initOperatorForPool();
        assertEq(pool.shutdownInitiatedAt(), 0);

        vm.prank(owner);
        pool.initiateShutdown();

        (bool pending, uint64 initiatedAt, uint64 effectiveAt, bool canCancel) =
            pool.getShutdownStatus(owner);
        assertTrue(pending);
        assertEq(initiatedAt, block.timestamp);
        assertEq(effectiveAt, block.timestamp + pool.SHUTDOWN_COOLING_OFF_PERIOD());
        assertTrue(canCancel);

        (,,, bool canCancelAlice) = pool.getShutdownStatus(alice);
        assertFalse(canCancelAlice);
    }

    function test_e2e_shutdown_fullWorkflow() public {
        _initOperatorForPool();
        nil.mint(alice, 15_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 15_000 * 1e6);
        pool.stake(15_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();

        vm.prank(owner);
        pool.initiateShutdown();

        (bool pending,,,) = pool.getShutdownStatus(owner);
        assertTrue(pending);

        vm.warp(block.timestamp + pool.SHUTDOWN_COOLING_OFF_PERIOD() + 1);

        vm.prank(alice);
        pool.confirmShutdown();

        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.ShuttingDown));

        vm.prank(alice);
        pool.requestWithdraw(15_000 * 1e6);

        pool.processWithdrawalBatch(10);
        vm.warp(block.timestamp + UNSTAKE_DELAY + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();

        uint256 aliceBefore = nil.balanceOf(alice);
        vm.prank(alice);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(alice), aliceBefore + 15_000 * 1e6);
    }
}
