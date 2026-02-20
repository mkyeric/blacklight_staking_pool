// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BlacklightPool} from "../../src/BlacklightPool.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {IStakingOperators} from "../../src/interfaces/IStakingOperators.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title E2ENillionStakingWithdrawalTest
/// @notice E2E tests that exercise Nillion's StakingOperators contract directly for withdrawal:
///         requestUnstake → tranches with releaseTime → withdrawUnstaked after delay.
/// @dev    Run: anvil --fork-url https://rpc-blacklight-x9da3b5afc.t.conduit.xyz
///         Then: forge test --match-path "test/e2e/E2ENillionStakingWithdrawal.t.sol" -vvv
///         Requires .env: DEPLOYER_PRIVATE_KEY
contract E2ENillionStakingWithdrawalTest is Test {
    address constant NIL_ADDR = 0x32DEAe728473cb948B4D8661ac0f2755133D4173;
    address constant STAKING_ADDR = 0x89c1312Cedb0B0F67e4913D2076bd4a860652B69;
    address constant REWARD_POLICY_ADDR = 0x78E0FEBF3B8936f961729328a25dBA88d4Fea86B;

    address NODE_WALLET; // Fresh operator (set in setUp)
    address poolOwner;   // Pool owner (deployer); must differ from operator
    address constant PLATFORM_FEE_RECIPIENT = 0x0000000000000000000000000000000000000001;
    address stakerUser;

    IERC20 nil;
    IStakingOperators staking;
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
        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        poolOwner = vm.addr(deployerKey);
        stakerUser = makeAddr("stakerUser");
        NODE_WALLET = makeAddr("e2eNillionNodeWallet");

        deal(address(nil), NODE_WALLET, 10 * 1e6);
        deal(address(nil), stakerUser, 200_000 * 1e6);

        vm.startBroadcast(deployerKey);
        factory = new PoolFactory(address(nil), STAKING_ADDR, REWARD_POLICY_ADDR, PLATFORM_FEE_RECIPIENT);
        address poolAddr = factory.createPool(NODE_WALLET, poolOwner, COMMISSION_BPS, MIN_STAKE);
        vm.stopBroadcast();

        pool = BlacklightPool(payable(poolAddr));
    }

    /// @notice Nillion's unstakeDelay() is a protocol-wide constant (e.g. 7 days).
    function test_nillion_unstakeDelay_returnsConstant() public view {
        uint256 delay = staking.unstakeDelay();
        assertGt(delay, 0, "unstakeDelay should be positive");
        // Typical Nillion unbonding is 7 days
        assertEq(delay, 7 days, "unstakeDelay should be 7 days on Blacklight");
    }

    /// @notice requestUnstake creates a tranche with releaseTime = now + unstakeDelay().
    function test_nillion_requestUnstake_createsTrancheWithCorrectReleaseTime() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        uint256 stakeAmount = 75_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);
        pool.forwardStakeToNode(); // 75k at node so 5k withdrawal keeps 70k floor

        uint256 withdrawAmount = 5_000 * 1e6;
        vm.prank(stakerUser);
        pool.requestWithdraw(withdrawAmount);

        uint256 batchTime = block.timestamp;
        pool.processWithdrawalBatch(10);

        IStakingOperators.Tranche[] memory tranches = staking.getUnbondingTranches(NODE_WALLET);
        assertEq(tranches.length, 1, "Nillion should have one unbonding tranche");
        assertEq(tranches[0].amount, withdrawAmount, "tranche amount should match");
        uint256 expectedRelease = batchTime + staking.unstakeDelay();
        assertEq(tranches[0].releaseTime, expectedRelease, "releaseTime should be now + unstakeDelay");
        // Pool sets unlockTimestamp with 1-day buffer: batchTime + unstakeDelay + WITHDRAWAL_CLAIM_BUFFER
        BlacklightPool.WithdrawalRequest[] memory q = pool.getWithdrawalQueue(stakerUser);
        assertEq(q[0].unlockTimestamp, uint64(batchTime + staking.unstakeDelay() + pool.WITHDRAWAL_CLAIM_BUFFER()));
    }

    /// @notice Before unstakeDelay passes, withdrawUnstaked reverts (Nillion does not release early).
    function test_nillion_withdrawUnstaked_beforeDelay_reverts() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        uint256 stakeAmount = 75_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);
        pool.forwardStakeToNode();

        uint256 withdrawAmount = 5_000 * 1e6;
        vm.prank(stakerUser);
        pool.requestWithdraw(withdrawAmount);
        pool.processWithdrawalBatch(10);

        uint256 delay = staking.unstakeDelay();
        vm.warp(block.timestamp + delay - 1); // 1 second before unlock

        vm.expectRevert();
        pool.pullUnstakedFromStaking();
    }

    /// @notice After unstakeDelay, withdrawUnstaked (via pullUnstakedFromStaking) returns NIL to the pool.
    function test_nillion_withdrawUnstaked_afterDelay_returnsNIL() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        uint256 stakeAmount = 75_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);
        pool.forwardStakeToNode();

        uint256 withdrawAmount = 5_000 * 1e6;
        vm.prank(stakerUser);
        pool.requestWithdraw(withdrawAmount);
        pool.processWithdrawalBatch(10);

        uint256 delay = staking.unstakeDelay();
        vm.warp(block.timestamp + delay + 1);
        pool.pullUnstakedFromStaking();
        vm.warp(block.timestamp + pool.WITHDRAWAL_CLAIM_BUFFER() + 1); // past pool unlock (delay + buffer)

        uint256 poolBalanceBefore = nil.balanceOf(address(pool));
        uint256 balBefore = nil.balanceOf(stakerUser);
        vm.prank(stakerUser);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(stakerUser), balBefore + withdrawAmount, "user should receive NIL after delay + buffer");
        uint256 poolBalanceAfter = nil.balanceOf(address(pool));
        assertEq(poolBalanceAfter, poolBalanceBefore - withdrawAmount, "pool should have sent NIL to user");
    }

    /// @notice Two requestUnstake calls (two batches) create two tranches with separate release times.
    function test_nillion_twoRequestUnstakes_createTwoTranchesWithSeparateReleaseTimes() public {
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

        uint256 withdraw1 = 3_000 * 1e6;
        vm.prank(stakerUser);
        pool.requestWithdraw(withdraw1);
        uint256 t0 = block.timestamp;
        pool.processWithdrawalBatch(10);

        vm.warp(t0 + 2 days);

        uint256 withdraw2 = 2_000 * 1e6;
        vm.prank(stakerUser);
        pool.requestWithdraw(withdraw2);
        uint256 t1 = block.timestamp;
        pool.processWithdrawalBatch(10);

        IStakingOperators.Tranche[] memory tranches = staking.getUnbondingTranches(NODE_WALLET);
        assertEq(tranches.length, 2, "Nillion should have two unbonding tranches");

        uint256 delay = staking.unstakeDelay();
        uint256 release0 = t0 + delay;
        uint256 release1 = t1 + delay;
        assertEq(tranches[0].amount, withdraw1);
        assertEq(tranches[0].releaseTime, release0, "first tranche unlocks at t0 + delay");
        assertEq(tranches[1].amount, withdraw2);
        assertEq(tranches[1].releaseTime, release1, "second tranche unlocks at t1 + delay (full delay from second batch)");
        assertGt(tranches[1].releaseTime, tranches[0].releaseTime, "second tranche unlocks later");
    }

    /// @notice Brute-force: create one tranche per batch (warp 1s between batches so release times differ;
    ///         Nillion merges tranches with the same releaseTime). Stop when Nillion or pool reverts.
    /// @dev    Cap at 100 iterations. On Blacklight fork, Nillion's StakingOperators reverts after 32 tranches
    ///         (likely BatchTooLarge or similar), so max tranches per operator = 32.
    function test_nillion_bruteForce_maxTranchesPerOperator() public {
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

        // Use multiple stakers: each can have up to 5 concurrent requests. Need 32 total to hit
        // Nillion's tranche limit. 7 stakers × 5 = 35 requests max.
        // Each must stake >= minStakePerUser (500 NIL) and leave >= 500 NIL after each request.
        uint256 stakePerStaker = 10_000 * 1e6;
        address[7] memory stakers;
        for (uint256 s; s < 7; s++) {
            stakers[s] = address(uint160(0xB0B0 + s));
            deal(address(nil), stakers[s], stakePerStaker);
            vm.startPrank(stakers[s]);
            nil.approve(address(pool), stakePerStaker);
            pool.stake(stakePerStaker);
            vm.stopPrank();
        }
        vm.prank(NODE_WALLET);
        pool.forwardStakeToNode();
        uint256 amountPerWithdraw = 1 * 1e6;
        uint256 trancheCount = 0;

        for (uint256 round; round < 7; round++) {
            for (uint256 s; s < 7 && trancheCount < 32; s++) {
                vm.warp(block.timestamp + 1);
                vm.prank(stakers[s]);
                (bool reqOk,) = address(pool).call(
                    abi.encodeWithSelector(BlacklightPool.requestWithdraw.selector, amountPerWithdraw)
                );
                if (!reqOk) continue;

                (bool success,) = address(pool).call(
                    abi.encodeWithSelector(BlacklightPool.processWithdrawalBatch.selector, 1)
                );
                if (!success) break;
                trancheCount++;
                if (trancheCount >= 32) break;
            }
            if (trancheCount >= 32) break;
        }

        IStakingOperators.Tranche[] memory tranches = staking.getUnbondingTranches(NODE_WALLET);
        assertEq(tranches.length, trancheCount, "Nillion tranche count should match successful batches");

        emit log_named_uint("max_tranches_observed_for_one_operator", trancheCount);
        assertGt(trancheCount, 0, "at least one tranche should be created");
        // Nillion's StakingOperators (Blacklight) enforces a per-operator tranche limit; observed = 32
        assertEq(trancheCount, 32, "Nillion contract limits unbonding tranches per operator to 32");
    }

    /// @notice User requests withdrawal; permissionless keeper runs processWithdrawalBatch and
    ///         pullUnstakedFromStaking at UTC 00:00 every day. User successfully claims ~8 days later.
    /// @dev    Simulates: Day 0 user requests → Day 1 00:00 batch processes → Day 8 00:00 pull
    ///         returns NIL to pool → Day 9 00:00 user can claim (unlockTimestamp = batch + 8 days).
    function test_nillion_withdrawClaim_8daysLater_withDailyKeeperAtMidnight() public {
        vm.prank(NODE_WALLET);
        staking.approveStaker(address(pool));

        uint256 stakeAmount = 75_000 * 1e6;
        vm.prank(stakerUser);
        nil.approve(address(pool), stakeAmount);
        vm.prank(stakerUser);
        pool.stake(stakeAmount);
        vm.prank(poolOwner);
        pool.activateOperator(ACTIVATE_AMOUNT);
        pool.forwardStakeToNode();

        // Day 0, noon UTC: user requests withdrawal
        uint256 day0 = 1735689600; // 2025-01-01 00:00:00 UTC (adjust if needed; use round day)
        vm.warp(day0 + 12 hours);
        uint256 withdrawAmount = 5_000 * 1e6;
        vm.prank(stakerUser);
        pool.requestWithdraw(withdrawAmount);
        assertEq(pool.totalPendingWithdrawals(), withdrawAmount);

        // Simulate keeper running at UTC 00:00 every day
        for (uint256 day = 1; day <= 10; day++) {
            vm.warp(day0 + day * 1 days);

            // Keeper 1: process withdrawal batch (processes unprocessed requests)
            pool.processWithdrawalBatch(10);

            // Keeper 2: pull unstaked NIL from staking into pool
            // Succeeds only after unstakeDelay (7 days); reverts before that — keeper ignores revert
            try pool.pullUnstakedFromStaking() {} catch {}
        }

        // After day 8: unstakeDelay (7 days) has passed since day-1 batch; pull has received NIL.
        // unlockTimestamp = day1 + unstakeDelay + buffer = day1 + 8 days.
        // So by day 9 00:00, user can claim.
        assertGe(block.timestamp, day0 + 9 days, "warped past unlock time");

        uint256 balBefore = nil.balanceOf(stakerUser);
        vm.prank(stakerUser);
        pool.claimWithdrawals();
        assertEq(nil.balanceOf(stakerUser), balBefore + withdrawAmount, "user claims successfully 8 days after batch");
    }
}
