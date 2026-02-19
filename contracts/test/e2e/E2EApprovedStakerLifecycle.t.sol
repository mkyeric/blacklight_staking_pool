// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BlacklightPool} from "../../src/BlacklightPool.sol";
import {PoolFactory} from "../../src/PoolFactory.sol";
import {IStakingOperators} from "../../src/interfaces/IStakingOperators.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IStakingOperatorsWithRegister {
    function registerOperator(string calldata metadataURI) external;
}

/// @title E2EApprovedStakerLifecycleTest
/// @notice Confirms which step (activateOperator vs registerOperator) causes approvedStaker
///         to be cleared on the Nillion StakingOperators contract.
/// @dev    Uses deployer as operator so we get a fresh address (no prior approvals).
///         Run: anvil --fork-url https://rpc-blacklight-x9da3b5afc.t.conduit.xyz
///         Then: forge test --match-path "test/e2e/E2EApprovedStakerLifecycle.t.sol" -vvv
///         Requires .env: DEPLOYER_PRIVATE_KEY, PLATFORM_FEE_RECIPIENT
contract E2EApprovedStakerLifecycleTest is Test {
    address constant NIL_ADDR = 0x32DEAe728473cb948B4D8661ac0f2755133D4173;
    address constant STAKING_ADDR = 0x89c1312Cedb0B0F67e4913D2076bd4a860652B69;
    address constant REWARD_POLICY_ADDR = 0x78E0FEBF3B8936f961729328a25dBA88d4Fea86B;

    IERC20 nil;
    IStakingOperators staking;
    BlacklightPool pool;
    PoolFactory factory;

    address operator;   // deployer (fresh address)
    address stakerUser;
    uint256 deployerKey;

    uint256 constant COMMISSION_BPS = 500;
    uint256 constant MIN_STAKE = 500 * 1e6;
    uint256 constant ACTIVATE_AMOUNT = 70_000 * 1e6;

    function setUp() public {
        vm.createSelectFork("anvil");

        nil = IERC20(NIL_ADDR);
        staking = IStakingOperators(STAKING_ADDR);

        deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        operator = vm.addr(deployerKey); // use deployer as operator (fresh address)
        stakerUser = makeAddr("stakerUser");

        deal(address(nil), operator, 10 * 1e6);
        deal(address(nil), stakerUser, 200_000 * 1e6);

        address platformFeeRecipient = vm.envOr("PLATFORM_FEE_RECIPIENT", address(0x0000000000000000000000000000000000000001));

        address poolOwnerAddr = makeAddr("poolOwner");
        vm.startBroadcast(deployerKey);
        factory = new PoolFactory(address(nil), STAKING_ADDR, REWARD_POLICY_ADDR, platformFeeRecipient);
        address poolAddr = factory.createPool(operator, poolOwnerAddr, COMMISSION_BPS, MIN_STAKE);
        vm.stopBroadcast();

        pool = BlacklightPool(payable(poolAddr));
    }

    /// @notice Try all orderings of A=approveStaker, S=stakeTo, R=registerOperator (≥75k) to find
    ///         one where approvedStaker stays pool so pool can stake multiple times.
    ///         Uses direct staking calls (pool as caller) to isolate protocol behavior.
    function test_approvedStakerPermutations_findWorkingSequence() public {
        deal(address(nil), address(pool), 100_000 * 1e6);
        uint256 snap = vm.snapshot();

        emit log_string("=== Permutation: A -> S -> R (standard) ===");
        _runSequence_A_S_R();

        vm.revertTo(snap);
        emit log_string("");
        emit log_string("=== Permutation: A -> S (35k) -> check -> S (40k) [split stakeTo] ===");
        _runSequence_splitStakeTo();

        vm.revertTo(snap);
        emit log_string("");
        emit log_string("=== Permutation: A -> R -> S (R first will revert) ===");
        _runSequence_A_R_S();

        vm.revertTo(snap);
        emit log_string("");
        emit log_string("=== Permutation: A -> S -> A (re-approve after S) ===");
        _runSequence_A_S_A();
    }

    function _runSequence_A_S_R() internal {
        vm.prank(operator);
        staking.approveStaker(address(pool));
        _poolApproveAndStakeTo(75_000 * 1e6);
        address a1 = staking.approvedStaker(operator);
        emit log_named_address("  approvedStaker after S:", a1);

        vm.prank(operator);
        try IStakingOperatorsWithRegister(STAKING_ADDR).registerOperator("blacklight-pool:test") {
            emit log_string("  R: success");
        } catch {
            emit log_string("  R: reverted");
        }
        address a2 = staking.approvedStaker(operator);
        emit log_named_address("  approvedStaker after R:", a2);
        _tryPoolStake(2_000 * 1e6);
    }

    function _runSequence_splitStakeTo() internal {
        deal(address(nil), address(pool), 100_000 * 1e6); // reset pool balance
        vm.prank(operator);
        staking.approveStaker(address(pool));

        _poolApproveAndStakeTo(35_000 * 1e6);
        address a1 = staking.approvedStaker(operator);
        emit log_named_address("  approvedStaker after S(35k):", a1);

        if (a1 == address(pool)) {
            _poolApproveAndStakeTo(40_000 * 1e6);
            address a2 = staking.approvedStaker(operator);
            emit log_named_address("  approvedStaker after S(40k):", a2);
        }
        _tryPoolStake(2_000 * 1e6);
    }

    function _runSequence_A_R_S() internal {
        deal(address(nil), address(pool), 100_000 * 1e6);
        vm.prank(operator);
        staking.approveStaker(address(pool));

        vm.prank(operator);
        try IStakingOperatorsWithRegister(STAKING_ADDR).registerOperator("blacklight-pool:test") {
            emit log_string("  R: success (unexpected)");
        } catch {
            emit log_string("  R: reverted (expected - needs stake first)");
        }
    }

    function _runSequence_A_S_A() internal {
        deal(address(nil), address(pool), 100_000 * 1e6);
        vm.prank(operator);
        staking.approveStaker(address(pool));
        _poolApproveAndStakeTo(75_000 * 1e6);

        vm.prank(operator);
        try staking.approveStaker(address(pool)) {
            emit log_string("  A (re-approve): success");
        } catch {
            emit log_string("  A (re-approve): reverted");
        }
        address a = staking.approvedStaker(operator);
        emit log_named_address("  approvedStaker after re-approve:", a);
        _tryPoolStake(2_000 * 1e6);
    }

    function _poolApproveAndStakeTo(uint256 amount) internal {
        vm.prank(address(pool));
        nil.approve(STAKING_ADDR, amount);
        vm.prank(address(pool));
        try staking.stakeTo(operator, amount) {
            emit log_string("  stakeTo: success");
        } catch {
            emit log_string("  stakeTo: reverted");
        }
    }

    function _tryPoolStake(uint256 amount) internal {
        deal(address(nil), stakerUser, 200_000 * 1e6);
        vm.prank(stakerUser);
        nil.approve(address(pool), amount);
        vm.prank(stakerUser);
        try pool.stake(amount) {
            emit log_string("  pool.stake: SUCCESS");
        } catch {
            emit log_string("  pool.stake: FAILED (OperatorNotApproved)");
        }
    }

    /// @notice Fork test: can 0x78ec... stake to 0x2631...? Run stakeTo to verify.
    function test_fork_stakeTo_78ec_to_2631() public {
        address stakerAddr = 0x78ecCb7273F6Ea5CcB138272deb47281489D8302;
        address operatorAddr = 0x26316c6706c8B43F1053635faC626cb2cA740953;
        uint256 amount = 10_000 * 1e6; // 10k NIL

        // Fund staker with NIL
        deal(address(nil), stakerAddr, 100_000 * 1e6);

        // Operator approves staker (0x2631... must approve 0x78ec...)
        vm.prank(operatorAddr);
        try staking.approveStaker(stakerAddr) {
            emit log_string("approveStaker: success");
        } catch (bytes memory reason) {
            emit log_string("approveStaker: reverted");
            emit log_bytes(reason);
        }

        // Staker approves StakingOperators and calls stakeTo
        vm.prank(stakerAddr);
        nil.approve(STAKING_ADDR, amount);
        try staking.stakeTo(operatorAddr, amount) {
            emit log_string("stakeTo: SUCCESS");
            emit log_named_uint("stakeOf(operator)", staking.stakeOf(operatorAddr));
        } catch (bytes memory reason) {
            emit log_string("stakeTo: REVERTED");
            emit log_bytes(reason);
        }
    }

    /// @notice Fork test: Approve NIL spending cap + stakeTo (no approveStaker; operator already bound to staker).
    function test_fork_approveNIL_then_stakeTo_78ec_to_2631() public {
        address stakerAddr = 0x78ecCb7273F6Ea5CcB138272deb47281489D8302;
        address operatorAddr = 0x26316c6706c8B43F1053635faC626cb2cA740953;
        uint256 amount = 10_000 * 1e6; // 10k NIL

        // Ensure staker has NIL
        deal(address(nil), stakerAddr, 100_000 * 1e6);

        // 1. Approve NIL spending cap (staker approves StakingOperators)
        vm.prank(stakerAddr);
        nil.approve(STAKING_ADDR, amount);
        emit log_string("Approve NIL spending cap: success");

        // 2. stakeTo
        vm.prank(stakerAddr);
        staking.stakeTo(operatorAddr, amount);
        emit log_string("stakeTo: SUCCESS");
        emit log_named_uint("stakeOf(operator)", staking.stakeOf(operatorAddr));
    }

}
