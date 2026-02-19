// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BlacklightPool} from "../../src/BlacklightPool.sol";
import {MockNILToken} from "../mocks/MockNILToken.sol";
import {MockStakingOperators} from "../mocks/MockStakingOperators.sol";
import {MockRewardPolicy} from "../mocks/MockRewardPolicy.sol";

/// @title E2ERewardSettlementTest
/// @notice E2E tests for reward distribution: heartbeat manager simulates reward payment,
///         keeper calls settleEpoch, verify full distribution and no idle NIL.
contract E2ERewardSettlementTest is Test {
    address owner = makeAddr("owner");
    address operatorNode = makeAddr("operatorNode");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address platformFeeRecipient = makeAddr("platform");
    address heartbeatManager = makeAddr("heartbeatManager");
    address keeper = makeAddr("keeper");

    MockNILToken nil;
    MockStakingOperators staking;
    MockRewardPolicy rewardPolicy;
    BlacklightPool pool;

    uint256 constant COMMISSION_BPS = 500; // 5%
    uint256 constant MIN_STAKE = 500 * 1e6;
    uint256 constant UNSTAKE_DELAY = 7 days;
    uint256 constant OPERATOR_INIT_STAKE = 90_000 * 1e6;

    function setUp() public {
        nil = new MockNILToken();
        staking = new MockStakingOperators(address(nil), UNSTAKE_DELAY);
        rewardPolicy = new MockRewardPolicy(address(nil));
        pool = new BlacklightPool(address(nil), address(staking), address(rewardPolicy), platformFeeRecipient);
        pool.initialize(operatorNode, owner, COMMISSION_BPS, MIN_STAKE);
        vm.prank(operatorNode);
        staking.approveStaker(address(pool));
    }

    function _activatePoolWithStakers() internal {
        staking.addRewardToStake(operatorNode, OPERATOR_INIT_STAKE);
        vm.prank(owner);
        pool.initOwnerNodeStake();
        nil.mint(alice, 30_000 * 1e6);
        nil.mint(bob, 20_000 * 1e6);
        vm.startPrank(alice);
        nil.approve(address(pool), 30_000 * 1e6);
        pool.stake(30_000 * 1e6);
        vm.stopPrank();
        vm.startPrank(bob);
        nil.approve(address(pool), 20_000 * 1e6);
        pool.stake(20_000 * 1e6);
        vm.stopPrank();
        vm.prank(owner);
        pool.forwardStakeToNode();
    }

    /// @notice E2E: Heartbeat manager credits rewards to pool; keeper runs settleEpoch; all rewards distributed, no idle NIL.
    function test_e2e_heartbeatManagerPaysRewards_keeperSettles_noIdleNil() public {
        _activatePoolWithStakers();
        uint256 poolBalanceBefore = nil.balanceOf(address(pool));

        // Heartbeat manager simulates protocol paying rewards (e.g. after epoch heartbeat)
        uint256 rewardAmount = 10_000 * 1e6;
        nil.mint(address(rewardPolicy), rewardAmount);
        vm.prank(heartbeatManager);
        rewardPolicy.setRewards(address(pool), rewardAmount);

        uint256 platformBefore = nil.balanceOf(platformFeeRecipient);
        uint256 ownerBefore = nil.balanceOf(owner);
        uint256 aliceBefore = nil.balanceOf(alice);
        uint256 bobBefore = nil.balanceOf(bob);

        vm.prank(keeper);
        pool.settleEpoch();

        uint256 platformFee = (rewardAmount * pool.PLATFORM_FEE_BPS()) / pool.BPS_DENOMINATOR();
        uint256 afterPlatform = rewardAmount - platformFee;
        uint256 ownerCommission = (afterPlatform * COMMISSION_BPS) / pool.BPS_DENOMINATOR();
        uint256 toStakers = afterPlatform - ownerCommission;
        // Owner 90k, alice 30k, bob 20k → totalStaked 140k (integer division may leave remainder to owner)
        uint256 aliceShare = (30_000 * 1e6 * toStakers) / (140_000 * 1e6);
        uint256 bobShare = (20_000 * 1e6 * toStakers) / (140_000 * 1e6);
        uint256 ownerStakerShareAndRemainder = toStakers - aliceShare - bobShare;

        assertEq(nil.balanceOf(platformFeeRecipient), platformBefore + platformFee, "platform got fee");
        assertEq(nil.balanceOf(owner), ownerBefore + ownerCommission + ownerStakerShareAndRemainder, "owner got commission + staker share + rounding remainder");
        assertEq(nil.balanceOf(alice), aliceBefore + aliceShare, "alice got staker share");
        assertEq(nil.balanceOf(bob), bobBefore + bobShare, "bob got staker share");
        assertEq(nil.balanceOf(address(pool)), poolBalanceBefore, "no idle NIL from rewards");
        assertEq(pool.epochNumber(), 1);
    }

    /// @notice E2E: Multiple settleEpoch calls (multiple heartbeats); each settlement distributes fully.
    function test_e2e_multipleHeartbeats_multipleSettlements() public {
        _activatePoolWithStakers();

        for (uint256 i = 0; i < 3; i++) {
            uint256 rewardAmount = 1_000 * 1e6;
            nil.mint(address(rewardPolicy), rewardAmount);
            vm.prank(heartbeatManager);
            rewardPolicy.setRewards(address(pool), rewardAmount);

            uint256 poolBefore = nil.balanceOf(address(pool));
            vm.prank(keeper);
            pool.settleEpoch();
            assertEq(nil.balanceOf(address(pool)), poolBefore, "no idle NIL after each settle");
            assertEq(pool.epochNumber(), i + 1);
        }
    }

    /// @notice E2E: Keeper is platform fee recipient (typical setup); they receive 1% on settle.
    function test_e2e_keeperIsPlatformFeeRecipient_receivesFee() public {
        _activatePoolWithStakers();
        uint256 rewardAmount = 5_000 * 1e6;
        nil.mint(address(rewardPolicy), rewardAmount);
        vm.prank(heartbeatManager);
        rewardPolicy.setRewards(address(pool), rewardAmount);

        address keeperAsPlatform = platformFeeRecipient;
        uint256 keeperBefore = nil.balanceOf(keeperAsPlatform);
        vm.prank(keeperAsPlatform);
        pool.settleEpoch();
        uint256 expectedFee = (rewardAmount * 100) / 10_000;
        assertEq(nil.balanceOf(keeperAsPlatform), keeperBefore + expectedFee, "keeper (platform) received 1%");
    }
}
