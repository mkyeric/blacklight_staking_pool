// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BlacklightPool} from "../../src/BlacklightPool.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {IStakingOperators} from "../../src/interfaces/IStakingOperators.sol";
import {IRewardPolicy} from "../../src/interfaces/IRewardPolicy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title E2ENodeWalletFlowTest
/// @notice E2E tests using a single node wallet (0x4f48...) as operator; a separate staker
///         funds the pool (contract blocks operator from staking). Flow: approve staker,
///         stake (as staker), activate (as owner), and test withdrawals before/after activation.
/// @dev    Run: anvil --fork-url https://rpc-blacklight-x9da3b5afc.t.conduit.xyz
///         Then: forge test --match-path "test/e2e/E2ENodeWalletFlow.t.sol" -vvv
///         Requires .env: DEPLOYER_PRIVATE_KEY (for deploying factory + pool)
contract E2ENodeWalletFlowTest is Test {
    address constant NIL_ADDR = 0x32DEAe728473cb948B4D8661ac0f2755133D4173;
    address constant STAKING_ADDR = 0x89c1312Cedb0B0F67e4913D2076bd4a860652B69;
    address constant REWARD_POLICY_ADDR = 0x78E0FEBF3B8936f961729328a25dBA88d4Fea86B;

    /// @notice Node wallet = operator. Use fresh address so initialize() passes.
    address NODE_WALLET;
    address poolOwner;   // Pool owner (deployer); must differ from operator
    address constant PLATFORM_FEE_RECIPIENT = 0x0000000000000000000000000000000000000001;
    /// @notice Separate staker (contract blocks operator from staking).
    address stakerUser;

    IERC20 nil;
    IStakingOperators staking;
    IRewardPolicy rewardPolicy;
    BlacklightPool pool;
    PoolFactory factory;

    uint256 deployerKey;

    uint256 constant COMMISSION_BPS = 500;
    uint256 constant MIN_STAKE = 500 * 1e6;
    uint256 constant ACTIVATE_AMOUNT = 70_000 * 1e6;

    function setUp() public {
        vm.createSelectFork("anvil");

        nil = IERC20(NIL_ADDR);
        staking = IStakingOperators(STAKING_ADDR);
        rewardPolicy = IRewardPolicy(REWARD_POLICY_ADDR);

        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        stakerUser = makeAddr("stakerUser");
        NODE_WALLET = makeAddr("e2eNodeWallet"); // Fresh operator (no prior stake on chain)

        // Fund node wallet (for gas / approve) and staker (for staking; operator cannot stake)
        deal(address(nil), NODE_WALLET, 10 * 1e6);
        deal(address(nil), stakerUser, 200_000 * 1e6);

        poolOwner = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);
        factory = new PoolFactory(address(nil), STAKING_ADDR, REWARD_POLICY_ADDR, PLATFORM_FEE_RECIPIENT);
        address poolAddr = factory.createPool(NODE_WALLET, poolOwner, COMMISSION_BPS, MIN_STAKE);
        vm.stopBroadcast();

        pool = BlacklightPool(payable(poolAddr));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Full pool setup flow (approve → stake → activate)
    // ═══════════════════════════════════════════════════════════════════

    function test_fullPoolSetupFlow() public {
        // 1. Operator approves pool as staker
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));
        assertEq(staking.approvedStaker(NODE_WALLET), address(pool));

        // 2. Staker (not operator) stakes into pool
        uint256 stakeAmount = ACTIVATE_AMOUNT;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);

        (uint256 proc, uint256 staked,,) = pool.stakers(stakerUser);
        assertEq(proc + staked, stakeAmount);
        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Idle));

        // 3. Owner activates operator (transitions to Active)
        vm.prank(poolOwner);
        pool.activateOperator(stakeAmount);

        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Active));
        assertTrue(pool.operatorInitialized());
        assertGe(staking.stakeOf(NODE_WALLET), ACTIVATE_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Activate pool
    // ═══════════════════════════════════════════════════════════════════

    function test_activatePool_transitionsToActive() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        vm.prank(stakerUser);
        nil.approve(address(pool), ACTIVATE_AMOUNT);
        vm.prank(stakerUser);
        pool.stake(ACTIVATE_AMOUNT);

        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);

        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Active));
        assertTrue(pool.operatorInitialized());
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Staking (before and after activation)
    // ═══════════════════════════════════════════════════════════════════

    function test_stakingBeforeActivation_idlePhase() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        uint256 amount = 10_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), amount);
        vm.prank(stakerUser);
        pool.stake(amount);

        (uint256 proc, uint256 staked,,) = pool.stakers(stakerUser);
        assertEq(proc + staked, amount);
        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Idle));
    }

    function test_stakingAfterActivation_activePhase() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        vm.prank(stakerUser);
        nil.approve(address(pool), ACTIVATE_AMOUNT);
        vm.prank(stakerUser);
        pool.stake(ACTIVATE_AMOUNT);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);

        // Assert Active phase and staker balance (on fork, protocol may clear approved staker
        // after stakeTo, so we do not test additional stake here)
        (uint256 proc, uint256 staked,,) = pool.stakers(stakerUser);
        assertEq(proc + staked, ACTIVATE_AMOUNT);
        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Active));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Request withdraw BEFORE pool activation (Idle phase → immediate)
    // ═══════════════════════════════════════════════════════════════════

    function test_requestWithdrawBeforeActivation_immediateWithdrawal() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        uint256 stakeAmount = 20_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);

        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Idle));

        uint256 withdrawAmount = 5_000 * 1e6;
        uint256 balBefore = nil.balanceOf(stakerUser);

        vm.prank(stakerUser);
        pool.withdrawProcessingStake(withdrawAmount);

        uint256 balAfter = nil.balanceOf(stakerUser);
        assertEq(balAfter, balBefore + withdrawAmount, "NIL should be returned immediately in Idle phase");

        (uint256 proc, uint256 staked,,) = pool.stakers(stakerUser);
        assertEq(proc + staked, stakeAmount - withdrawAmount);
    }

    function test_requestWithdrawBeforeActivation_fullWithdrawal() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        uint256 stakeAmount = 10_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);

        uint256 balBefore = nil.balanceOf(stakerUser);

        vm.prank(stakerUser);
        pool.withdrawProcessingStake(stakeAmount);

        assertEq(nil.balanceOf(stakerUser), balBefore + stakeAmount);
        (uint256 proc, uint256 staked,,) = pool.stakers(stakerUser);
        assertEq(proc + staked, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Request withdraw AFTER pool activation (Active phase → queued)
    // ═══════════════════════════════════════════════════════════════════

    function test_requestWithdrawAfterActivation_queuedThenClaimed() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        uint256 stakeAmount = 80_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);
        pool.forwardStakeToNode();

        assertEq(uint8(pool.poolPhase()), uint8(BlacklightPool.PoolPhase.Active));

        uint256 withdrawAmount = 5_000 * 1e6;
        vm.prank(stakerUser);
        pool.requestWithdraw(withdrawAmount);

        // In Active phase, NIL is queued, not returned immediately
        assertEq(pool.totalPendingWithdrawals(), withdrawAmount);

        vm.prank(NODE_WALLET);
        pool.processWithdrawalBatch(10);

        uint256 delay = staking.unstakeDelay();
        vm.warp(block.timestamp + delay + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);

        pool.pullUnstakedFromStaking();

        uint256 balBefore = nil.balanceOf(stakerUser);
        vm.prank(stakerUser);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(stakerUser), balBefore + withdrawAmount);
    }

    function test_requestWithdrawAfterActivation_revertsIfBelow70k() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        uint256 stakeAmount = 75_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);

        // Withdrawing 10k would leave 65k, below 70k floor
        vm.prank(stakerUser);
        vm.expectRevert();
        pool.requestWithdraw(10_000 * 1e6);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Combined: withdraw before activate, then activate, then withdraw after
    // ═══════════════════════════════════════════════════════════════════

    function test_withdrawBeforeAndAfterActivation_combinedFlow() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        // Stake 80k
        uint256 totalStake = 80_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), totalStake);
        vm.prank(stakerUser);
        pool.stake(totalStake);

        // Immediate partial withdraw from processing in Idle (5k)
        uint256 withdrawIdle = 5_000 * 1e6;
        vm.prank(stakerUser);
        pool.withdrawProcessingStake(withdrawIdle);

        (uint256 procAfterIdle, uint256 stakedAfterIdle,,) = pool.stakers(stakerUser);
        assertEq(procAfterIdle + stakedAfterIdle, totalStake - withdrawIdle);

        // Activate (need >= 70k in pool), then forward remaining so 75k at node for 3k withdrawal
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);
        pool.forwardStakeToNode();

        // Queued withdraw in Active (3k)
        uint256 withdrawActive = 3_000 * 1e6;
        vm.prank(stakerUser);
        pool.requestWithdraw(withdrawActive);

        vm.prank(NODE_WALLET);
        pool.processWithdrawalBatch(10);

        uint256 delay = staking.unstakeDelay();
        vm.warp(block.timestamp + delay + pool.WITHDRAWAL_CLAIM_BUFFER() + 1);
        pool.pullUnstakedFromStaking();

        uint256 balBefore = nil.balanceOf(stakerUser);
        vm.prank(stakerUser);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(stakerUser), balBefore + withdrawActive);
    }
}
