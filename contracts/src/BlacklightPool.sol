// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStakingOperators} from "./interfaces/IStakingOperators.sol";
import {IRewardPolicy} from "./interfaces/IRewardPolicy.sol";

/// @title  BlacklightPool
/// @notice A non-custodial staking pool so users with less than 70,000 NIL can
///         participate in Blacklight rewards by pooling with others. One operator = one pool.
/// @dev    Clone-ready: constructor only sets chain-wide immutables; per-pool config is set
///         in initialize(). The implementation contract must not be initialized.
///         IMPORTANT: Pools must only be created via PoolFactory.createPool(), which deploys
///         a clone and calls initialize() in the same transaction. Creating a pool any other
///         way (e.g. cloning without the factory) allows front-running: the first caller of
///         initialize() becomes owner and can set themselves as commission recipient.
contract BlacklightPool is ReentrancyGuard {
    using SafeERC20 for IERC20;
    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Maximum commission the pool owner can set (50%).
    uint256 public constant MAX_COMMISSION_BPS = 5_000;

    /// @notice Basis-point denominator (10_000 = 100%).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Minimum allowed value for minStakePerUser (500 $NIL). Operator can set higher.
    /// @dev    NIL token uses 6 decimals, so 500 NIL = 500 * 10^6
    uint256 public constant MIN_STAKE_PER_USER = 500 * 1e6;

    /// @notice Maximum number of unique stakers per pool (gas and design bound).
    uint256 public constant MAX_STAKERS = 100;

    /// @notice Maximum NIL a single staker may have staked in the pool (100,000 $NIL).
    /// @dev    NIL token uses 6 decimals, so 100,000 NIL = 100_000 * 10^6
    uint256 public constant MAX_STAKER_STAKE = 100_000 * 1e6;

    /// @notice Official minimum NIL the pool owner must keep staked on the node to earn rewards
    ///         (70,000 $NIL). Owner withdrawal requests revert if they would leave stake below this.
    /// @dev    NIL token uses 6 decimals, so 70,000 NIL = 70_000 * 10^6
    uint256 public constant MIN_OPERATOR_STAKE = 70_000 * 1e6;

    /// @notice Platform operation fee: 1% of pool rewards. Hardcoded for transparency; cannot be
    ///         increased. Applied during reward distribution (settleEpoch).
    uint256 public constant PLATFORM_FEE_BPS = 100;

    /// @notice Extra time added to unlockTimestamp after the staking contract's unstake delay.
    ///         Gives a buffer for someone to call pullUnstakedFromStaking() so idle NIL is
    ///         available when users claim.
    uint256 public constant WITHDRAWAL_CLAIM_BUFFER = 1 days;

    /// @notice Maximum concurrent (unclaimed) withdrawal requests per staker.
    ///         Quota is released when a request is successfully claimed.
    uint256 public constant MAX_CONCURRENT_WITHDRAWAL_REQUESTS = 5;

    /// @notice Cooling-off period between initiateShutdown / initiateShutdownByKeeper and
    ///         the actual transition to ShuttingDown. During this period the initiator
    ///         can cancel. Once confirmed, shutdown is irreversible.
    uint256 public constant SHUTDOWN_COOLING_OFF_PERIOD = 1 days;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES (set in constructor; same for all pools on this chain)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice NIL ERC-20 token on the Blacklight L2.
    IERC20 public immutable nilToken;

    /// @notice Nillion StakingOperators contract.
    IStakingOperators public immutable stakingContract;

    /// @notice Reward policy contract that streams NIL to the pool as the approved staker.
    IRewardPolicy public immutable rewardPolicy;

    /// @notice Platform fee recipient. 1% of pool rewards (PLATFORM_FEE_BPS) is sent here during
    ///         reward distribution. Set by PoolFactory at deployment; required (never address(0)).
    address public immutable platformFeeRecipient;

    // ═══════════════════════════════════════════════════════════════════
    //  CONFIGURATION (set in initialize; one per pool)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Pool owner; can manage pool and receive commission. Set in initialize().
    address public owner;

    /// @notice Blacklight verifier-node wallet this pool stakes to.
    address public operator;

    /// @notice Operator commission in basis points (e.g. 500 = 5%).
    uint256 public commissionBps;

    /// @notice Minimum NIL a user must have staked at all times. Must be ≥ 500 NIL.
    uint256 public minStakePerUser;

    /// @notice True after initialize() has been called (prevents re-initialization).
    bool private _initialized;

    /// @notice Pool lifecycle phase: Uninitialized → Idle (pre-activation) → Active (operator staked via pool)
    ///         → ShuttingDown (emergency/voluntary wind-down; no new stakes; 70k floor bypassed).
    enum PoolPhase {
        Uninitialized,
        Idle,
        Active,
        ShuttingDown
    }

    PoolPhase public poolPhase;

    /// @notice Timestamp when shutdown was initiated. 0 = not initiated.
    uint64 public shutdownInitiatedAt;

    /// @notice Address that initiated shutdown (owner or platformFeeRecipient). Only this address
    ///         can cancel during the cooling-off period. owner-initiated: only owner can cancel;
    ///         keeper-initiated: only platformFeeRecipient (keeper) can cancel.
    address public shutdownInitiatedBy;

    // ═══════════════════════════════════════════════════════════════════
    //  STAKER STATE
    // ═══════════════════════════════════════════════════════════════════

    struct StakerInfo {
        uint256 processingStake;  // NIL in pool not yet forwarded to node (not "staked" for rewards/withdraw-queue)
        uint256 staked;           // NIL already at node (forwarded); only this is subject to requestWithdraw / queue
        uint64 depositEpoch;      // epoch of most recent deposit (for future reward proration)
        uint64 depositTimestamp;  // block.timestamp of most recent deposit (for future reward proration)
    }

    /// @notice Per-user staking data.
    mapping(address => StakerInfo) public stakers;

    /// @notice Ordered list of current staker addresses (max MAX_STAKERS).
    address[] public stakerList;

    /// @notice Fast lookup for staker membership.
    mapping(address => bool) public isStaker;

    /// @notice Sum of all users' `staked` balances (including the owner’s node stake when initialized).
    uint256 public totalUserStakes;

    /// @notice Amount of NIL in the pool not yet forwarded to the staking contract.
    ///         Increases on stake(), decreases on requestWithdraw() and forwardStakeToNode().
    uint256 public totalProcessingStake;

    /// @notice Sum of all users' staked (at-node) amounts. Equals actual node stake until processWithdrawalBatch() runs.
    ///         totalUserStakes = totalProcessingStake + totalStakedAtNode. Decreases only in processWithdrawalBatch().
    uint256 public totalStakedAtNode;

    /// @notice Current epoch number (incremented on each settlement). Starts at 0.
    ///         Used for depositEpoch when staking (for future partial-epoch reward proration).
    uint256 public epochNumber;

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAWAL QUEUE STATE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A single queued withdrawal request.
    struct WithdrawalRequest {
        uint256 amount;
        uint64 requestTimestamp;
        uint64 unlockTimestamp; // 0 = not yet processed by batch; set when batch runs
        bool claimed;
        bool cancelled; // true if staker cancelled before batch processed it
    }

    /// @notice Per-user queue of withdrawal requests (FIFO).
    mapping(address => WithdrawalRequest[]) internal withdrawalQueue;

    /// @notice Sum of all queued withdrawal amounts not yet claimed.
    uint256 public totalPendingWithdrawals;

    /// @notice Amount currently requested from the staking contract but not yet received.
    ///         Prevents double-requesting in processWithdrawalBatch.
    uint256 public totalUnstakingRequested;

    /// @notice Addresses that have at least one entry in their withdrawal queue (for batch iteration).
    address[] internal usersWithPendingWithdrawals;

    /// @notice O(1) lookup: true if user is in usersWithPendingWithdrawals (avoids O(n) scan in requestWithdraw).
    mapping(address => bool) internal isInPendingWithdrawalsList;

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error InvalidAddress();
    error ZeroAmount();
    error BelowMinimumStake();
    error ExceedsStakerCap();
    error MaxStakersReached();
    error CommissionTooHigh();
    error InsufficientStake();
    error NothingToClaim();
    error OperatorStakeTooLow();
    error InvalidRewardPolicy();
    error OperatorNotUsingPoolAsStaker();
    error OperatorAlreadyInitialized();
    error OperatorNotInitialized();
    /// @notice Staking is blocked until the operator has approved this pool as staker.
    error OperatorNotApproved();
    /// @notice The operator address cannot stake; only owner or other users may stake.
    error OperatorCannotStake();
    /// @notice Staker has reached the maximum concurrent withdrawal requests; claim some to free quota.
    error TooManyWithdrawalRequests();
    /// @notice Withdrawal from processing stake: amount exceeds staker's processing stake (e.g. already forwarded).
    error InsufficientProcessingStake();
    /// @notice In Idle phase use withdrawProcessingStake to withdraw; requestWithdraw applies only to staked (at-node) amount.
    error IdlePhaseUseWithdrawProcessingStake();
    /// @notice Cannot cancel: withdrawal already batched (unlockTimestamp set) or already claimed/cancelled.
    error WithdrawalNotPending();
    /// @notice Shutdown can only be initiated for an Active pool.
    error ShutdownOnlyForActive();
    /// @notice Shutdown is not in a pending state (nothing to cancel or confirm).
    error ShutdownNotPending();
    /// @notice Caller is not authorized to cancel this shutdown (only initiator can cancel).
    error NotAuthorizedToCancelShutdown();
    /// @notice Caller is not the platform fee recipient (keeper).
    error NotPlatformFeeRecipient();
    /// @notice Pool NIL balance is below the amount required for the operation (e.g. totalProcessingStake or withdrawal).
    error InsufficientPoolBalance();

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event Staked(address indexed user, uint256 amount);
    event WithdrawProcessingStake(address indexed user, uint256 amount);
    event WithdrawQueued(address indexed user, uint256 amount, uint256 index, uint64 unlockTimestamp);
    event WithdrawalBatchProcessed(uint256 totalAmount, uint64 unlockTimestamp);
    event WithdrawalClaimed(address indexed user, uint256 amount, uint256 index);
    event WithdrawalCancelled(address indexed user, uint256 amount, uint256 index);
    event WithdrawalsUnlocked(uint256 amount);
    /// @notice Emitted when an epoch is settled: rewards claimed and distributed (platform, owner, stakers).
    event EpochSettled(
        uint256 indexed epochNumber,
        uint256 rewardAmount,
        uint256 platformFee,
        uint256 ownerCommission,
        uint256 toStakers
    );
    /// @notice Emitted when shutdown is initiated (owner or keeper). Cooling-off period starts.
    event ShutdownInitiated(address indexed initiator, uint64 initiatedAt, uint64 effectiveAt);
    /// @notice Emitted when shutdown is cancelled during the cooling-off period.
    event ShutdownCancelled(address indexed cancelledBy);
    /// @notice Emitted when shutdown is confirmed (cooling-off passed). Pool enters ShuttingDown; irreversible.
    event ShutdownConfirmed(uint64 confirmedAt);

    // ═══════════════════════════════════════════════════════════════════
    //  INITIALIZER & OWNERSHIP ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error MinStakeTooLow();
    error AlreadyInitialized();
    error NotPoolOwner();
    /// @notice Operator has existing stake or has been used before; pool must use a fresh operator.
    error OperatorAlreadyInUse();

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotPoolOwner();
        _;
    }

    /// @notice True if this pool can stake to the operator (approved staker or bound staker).
    /// @dev    approvedStaker is set before first stakeTo and cleared by it; operatorStaker
    ///         persists. After activation, only operatorStaker is set.
    function _isPoolApprovedForOperator() internal view returns (bool) {
        return stakingContract.approvedStaker(operator) == address(this)
            || stakingContract.operatorStaker(operator) == address(this);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR (implementation only; sets chain-wide immutables)
    // ═══════════════════════════════════════════════════════════════════

    /// @param _nilToken              NIL ERC-20 address on the Blacklight L2.
    /// @param _stakingContract       StakingOperators contract address.
    /// @param _rewardPolicy          Reward policy contract that pays NIL to this pool.
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
        nilToken = IERC20(_nilToken);
        stakingContract = IStakingOperators(_stakingContract);
        rewardPolicy = IRewardPolicy(_rewardPolicy);
        platformFeeRecipient = _platformFeeRecipient;

        // Sanity check: reward policy must pay out the same token the pool is using.
        if (address(rewardPolicy.rewardToken()) != address(nilToken)) revert InvalidRewardPolicy();
        // Explicitly set initial phase for clarity.
        poolPhase = PoolPhase.Uninitialized;
    }

    /// @notice Set or update the operator wallet address while in Idle phase.
    /// @dev    Allows late binding of the node wallet; callable only by the owner.
    function setOperatorWallet(address _operator) external onlyOwner {
        if (poolPhase != PoolPhase.Idle) revert OperatorAlreadyInitialized();
        if (_operator == address(0)) revert InvalidAddress();
        operator = _operator;
    }

    /// @notice Activate the operator/node by staking NIL from the pool to the staking contract.
    /// @dev    Requires this pool to be the approved staker for the operator and to have
    ///         at least MIN_OPERATOR_STAKE idle NIL. Transitions the pool to Active.
    /// @param amountToStake  Amount of NIL to stake to the operator on activation.
    function activateOperator(uint256 amountToStake) external onlyOwner nonReentrant {
        if (poolPhase != PoolPhase.Idle) revert OperatorAlreadyInitialized();
        if (operator == address(0)) revert InvalidAddress();
        if (amountToStake == 0) revert ZeroAmount();

        // Ensure the pool is the approved or bound staker for this operator.
        if (!_isPoolApprovedForOperator()) {
            revert OperatorNotUsingPoolAsStaker();
        }

        uint256 idleBalance = nilToken.balanceOf(address(this));
        if (idleBalance < MIN_OPERATOR_STAKE || idleBalance < amountToStake) {
            revert OperatorStakeTooLow();
        }
        if (idleBalance < totalProcessingStake) revert InsufficientPoolBalance();
        if (amountToStake > totalProcessingStake) revert InsufficientStake();

        nilToken.safeIncreaseAllowance(address(stakingContract), amountToStake);
        stakingContract.stakeTo(operator, amountToStake);

        // Move amountToStake from processing to staked (at-node) proportionally per staker.
        // Ensure sum(shares) == amountToStake exactly (assign rounding remainder to one staker)
        // so totalProcessingStake stays in sync with sum(si.processingStake); otherwise
        // requestWithdraw can underflow totalStakedAtNode and lock funds.
        uint256 _totalProcessing = totalProcessingStake;
        totalProcessingStake -= amountToStake;
        totalStakedAtNode += amountToStake;
        if (_totalProcessing > 0) {
            address[] storage list = stakerList;
            uint256 listLen = list.length;
            uint256 allocated;
            for (uint256 i; i < listLen;) {
                StakerInfo storage si = stakers[list[i]];
                if (si.processingStake > 0) {
                    uint256 share = (si.processingStake * amountToStake) / _totalProcessing;
                    if (share > si.processingStake) share = si.processingStake;
                    allocated += share;
                    si.processingStake -= share;
                    si.staked += share;
                }
                unchecked { i++; }
            }
            uint256 remainder = amountToStake - allocated;
            if (remainder > 0) {
                for (uint256 i; i < listLen && remainder > 0;) {
                    StakerInfo storage si = stakers[list[i]];
                    if (si.processingStake > 0) {
                        uint256 take = remainder > si.processingStake ? si.processingStake : remainder;
                        si.processingStake -= take;
                        si.staked += take;
                        remainder -= take;
                    }
                    unchecked { i++; }
                }
            }
        }

        uint256 currentStake = stakingContract.stakeOf(operator);
        if (currentStake < MIN_OPERATOR_STAKE) revert OperatorStakeTooLow();

        poolPhase = PoolPhase.Active;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INITIALIZER (call once per clone after deployment)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Initializes pool config. Must be called once after the contract is created.
    /// @dev    SECURITY: Has no access control—the first caller sets owner. Pools must only be
    ///         created via PoolFactory.createPool() (clone + initialize in one tx). Any other
    ///         creation path allows front-running and wrong owner.
    /// @param _operator        Blacklight node wallet to stake to (node identity only).
    /// @param _owner           Pool owner; economically owns node stake, receives commission,
    ///                         and can manage the pool.
    /// @param _commissionBps   Commission in basis points (≤ MAX_COMMISSION_BPS).
    /// @param _minStakePerUser Minimum NIL per staker (≥ MIN_STAKE_PER_USER).
    function initialize(
        address _operator,
        address _owner,
        uint256 _commissionBps,
        uint256 _minStakePerUser
    ) external {
        if (_initialized) revert AlreadyInitialized();
        // Operator may be provided up front or set later via a dedicated function.
        if (_operator == address(0)) revert InvalidAddress();
        if (_owner == address(0)) revert InvalidAddress();
        if (_commissionBps > MAX_COMMISSION_BPS) revert CommissionTooHigh();
        if (_minStakePerUser < MIN_STAKE_PER_USER) revert MinStakeTooLow();

        // Require a fresh operator: no existing stake and no prior staker binding.
        if (stakingContract.stakeOf(_operator) != 0) revert OperatorAlreadyInUse();
        if (stakingContract.operatorStaker(_operator) != address(0)) revert OperatorAlreadyInUse();

        _initialized = true;
        operator = _operator;
        owner = _owner;
        commissionBps = _commissionBps;
        minStakePerUser = _minStakePerUser;
        poolPhase = PoolPhase.Idle;
    }

    /// @notice Backwards-compatibility helper for legacy flows that relied on an existing solo node stake.
    /// @dev    New deployments should prefer the activateOperator() workflow. This function is kept
    ///         for compatibility but behaves the same as before, and will transition the pool to Active.
    function initOwnerNodeStake() external onlyOwner {
        if (poolPhase == PoolPhase.Active) revert OperatorAlreadyInitialized();
        if (isStaker[owner]) revert OperatorAlreadyInitialized();
        // Ensure the pool is the approved or bound staker for this operator (node wallet).
        if (!_isPoolApprovedForOperator()) {
            revert OperatorNotUsingPoolAsStaker();
        }

        uint256 currentStake = stakingContract.stakeOf(operator);
        // Enforce that the node is properly funded before we record the owner as a staker.
        if (currentStake < MIN_OPERATOR_STAKE) revert OperatorStakeTooLow();

        StakerInfo storage info = stakers[owner];
        info.processingStake = 0;
        info.staked = currentStake;
        info.depositEpoch = uint64(epochNumber);
        info.depositTimestamp = uint64(block.timestamp);

        totalUserStakes += currentStake;
        totalStakedAtNode += currentStake;

        if (!isStaker[owner]) {
            if (stakerList.length >= MAX_STAKERS) revert MaxStakersReached();
            stakerList.push(owner);
            isStaker[owner] = true;
        }

        poolPhase = PoolPhase.Active;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SHUTDOWN (Active pools only; 1-day cooling-off; initiator can cancel)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Initiate shutdown (owner only). Pool enters cooling-off for SHUTDOWN_COOLING_OFF_PERIOD.
    ///         During cooling-off the pool stays Active: staking is allowed and the 70k floor is
    ///         enforced on withdrawals. Only the owner can cancel. After cooling-off, anyone must
    ///         call confirmShutdown() to transition to ShuttingDown; shutdown is irreversible once confirmed.
    function initiateShutdown() external onlyOwner {
        if (poolPhase != PoolPhase.Active) revert ShutdownOnlyForActive();
        if (shutdownInitiatedAt != 0) revert ShutdownNotPending(); // already initiated

        uint64 now64 = uint64(block.timestamp);
        shutdownInitiatedAt = now64;
        shutdownInitiatedBy = owner;
        emit ShutdownInitiated(owner, now64, now64 + uint64(SHUTDOWN_COOLING_OFF_PERIOD));
    }

    /// @notice Initiate shutdown (keeper / platform fee recipient only). Same cooling-off as owner.
    ///         During cooling-off the pool stays Active (staking allowed, 70k enforced). Only the
    ///         keeper can cancel. After cooling-off, confirmShutdown() must be called to enter ShuttingDown.
    function initiateShutdownByKeeper() external {
        if (msg.sender != platformFeeRecipient) revert NotPlatformFeeRecipient();
        if (poolPhase != PoolPhase.Active) revert ShutdownOnlyForActive();
        if (shutdownInitiatedAt != 0) revert ShutdownNotPending();

        uint64 now64 = uint64(block.timestamp);
        shutdownInitiatedAt = now64;
        shutdownInitiatedBy = platformFeeRecipient;
        emit ShutdownInitiated(platformFeeRecipient, now64, now64 + uint64(SHUTDOWN_COOLING_OFF_PERIOD));
    }

    /// @notice Cancel shutdown during cooling-off. Only the initiator can cancel:
    ///         owner-initiated → only owner; keeper-initiated → only platformFeeRecipient.
    function cancelShutdown() external {
        if (shutdownInitiatedAt == 0) revert ShutdownNotPending();
        if (msg.sender != shutdownInitiatedBy) revert NotAuthorizedToCancelShutdown();

        shutdownInitiatedAt = 0;
        address cancelledBy = shutdownInitiatedBy;
        shutdownInitiatedBy = address(0);
        emit ShutdownCancelled(cancelledBy);
    }

    /// @notice Confirm shutdown after cooling-off. Callable by anyone. Transitions pool to ShuttingDown.
    ///         Irreversible. This is the only way to enter ShuttingDown: during cooling-off the pool
    ///         remains Active (staking allowed, 70k floor enforced); only after confirmShutdown() are
    ///         new stakes blocked and the 70k floor bypassed for withdrawals.
    function confirmShutdown() external {
        if (shutdownInitiatedAt == 0) revert ShutdownNotPending();
        if (block.timestamp < shutdownInitiatedAt + SHUTDOWN_COOLING_OFF_PERIOD) revert ShutdownNotPending();

        poolPhase = PoolPhase.ShuttingDown;
        emit ShutdownConfirmed(uint64(block.timestamp));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  USER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Deposit NIL into the pool.
    ///         The caller must have approved this contract on the NIL token
    ///         for at least `amount` before calling.
    /// @param amount  NIL to stake (in wei, 6 decimals - matches NIL token decimals).
    function stake(uint256 amount) external nonReentrant {
        // Staking is allowed in Idle and Active phases; disallow Uninitialized and ShuttingDown.
        if (poolPhase == PoolPhase.Uninitialized) revert OperatorNotInitialized();
        if (poolPhase == PoolPhase.ShuttingDown) revert OperatorNotInitialized();
        if (amount == 0) revert ZeroAmount();
        // Block staking until the pool is approved or bound as staker for the operator.
        if (!_isPoolApprovedForOperator()) revert OperatorNotApproved();
        // Operator cannot stake; only owner or other users may add NIL to the pool this way.
        if (msg.sender == operator) revert OperatorCannotStake();

        StakerInfo storage info = stakers[msg.sender];
        uint256 newBalance = info.processingStake + info.staked + amount;

        if (newBalance < minStakePerUser) revert BelowMinimumStake();
        if (newBalance > MAX_STAKER_STAKE) revert ExceedsStakerCap();

        // Register new staker (enforce staker count limit)
        if (!isStaker[msg.sender]) {
            if (stakerList.length >= MAX_STAKERS) revert MaxStakersReached();
            stakerList.push(msg.sender);
            isStaker[msg.sender] = true;
        }

        // Pull NIL from user
        nilToken.safeTransferFrom(msg.sender, address(this), amount);

        // Update accounting: new deposits go to processing stake only
        info.processingStake += amount;
        info.depositEpoch = uint64(epochNumber);
        info.depositTimestamp = uint64(block.timestamp);
        totalUserStakes += amount;
        totalProcessingStake += amount;

        emit Staked(msg.sender, amount);
    }

    /// @notice Withdraw NIL from the caller's processing stake only. Immediate transfer.
    ///         Reverts if amount > processingStake (e.g. owner already called forwardStakeToNode).
    ///         Remaining balance (processingStake + staked - amount) must be 0 or >= minStakePerUser;
    ///         withdrawing all (remaining == 0) is allowed.
    /// @param amount  NIL to withdraw from processing stake.
    function withdrawProcessingStake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        StakerInfo storage info = stakers[msg.sender];
        if (amount > info.processingStake) revert InsufficientProcessingStake();
        if (nilToken.balanceOf(address(this)) < amount) revert InsufficientPoolBalance();

        uint256 remaining = info.processingStake + info.staked - amount;
        if (remaining > 0 && remaining < minStakePerUser) revert BelowMinimumStake();

        info.processingStake -= amount;
        totalProcessingStake -= amount;
        totalUserStakes -= amount;

        if (info.processingStake == 0 && info.staked == 0) {
            _removeStaker(msg.sender);
        }

        nilToken.safeTransfer(msg.sender, amount);
        emit WithdrawProcessingStake(msg.sender, amount);
    }

    /// @notice Forward pool idle NIL to the staking contract (stake to operator).
    ///         Forwards the full totalProcessingStake to the node. Reverts if pool balance is
    ///         below totalProcessingStake (ensures accounting invariant: balance >= processing stake).
    ///         Permissionless: anyone may call; no funds go to the caller.
    function forwardStakeToNode() external nonReentrant {
        if (poolPhase != PoolPhase.Active) revert OperatorNotInitialized();
        if (shutdownInitiatedAt != 0) revert OperatorNotInitialized(); // no forwarding during shutdown process
        uint256 amount = totalProcessingStake;
        if (amount == 0) revert ZeroAmount();
        uint256 balance = nilToken.balanceOf(address(this));
        if (balance < amount) revert InsufficientPoolBalance();

        totalProcessingStake -= amount;
        totalStakedAtNode += amount;
        nilToken.safeIncreaseAllowance(address(stakingContract), amount);
        stakingContract.stakeTo(operator, amount);

        // Move each staker's processing stake to staked (at-node)
        address[] storage list = stakerList;
        uint256 len = list.length;
        for (uint256 i; i < len;) {
            StakerInfo storage si = stakers[list[i]];
            if (si.processingStake > 0) {
                si.staked += si.processingStake;
                si.processingStake = 0;
            }
            unchecked { i++; }
        }
    }

    /// @notice Pull all currently claimable verifier rewards for this pool from the reward policy.
    /// @dev    Rewards are sent directly to the pool contract. Prefer calling settleEpoch() so
    ///         rewards are claimed and distributed immediately with no idle NIL left in the pool.
    function claimVerifierRewards() external onlyOwner nonReentrant {
        rewardPolicy.claim();
    }

    /// @notice Claim all pending rewards from the reward policy and distribute them immediately.
    ///         Callable by anyone (e.g. keeper / platform fee recipient). No NIL from claimed
    ///         rewards remains idle in the contract: platform fee (1%), owner commission, and
    ///         staker shares are sent out in the same tx. Distribution to stakers is proportional
    ///         to each staker's "staked" (at-node) amount, not "processing stake".
    /// @dev    If there are no claimable rewards, this is a no-op (epoch not incremented).
    ///         If totalStakedAtNode is 0, the staker portion is sent to the owner.
    function settleEpoch() external nonReentrant {
        if (poolPhase == PoolPhase.Uninitialized) return;

        uint256 balanceBefore = nilToken.balanceOf(address(this));
        rewardPolicy.claim();
        uint256 balanceAfter = nilToken.balanceOf(address(this));
        uint256 rewardAmount = balanceAfter - balanceBefore;
        if (rewardAmount == 0) return;

        uint256 platformFee = (rewardAmount * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 afterPlatform = rewardAmount - platformFee;
        uint256 ownerCommission = (afterPlatform * commissionBps) / BPS_DENOMINATOR;
        uint256 toStakers = afterPlatform - ownerCommission;

        nilToken.safeTransfer(platformFeeRecipient, platformFee);
        nilToken.safeTransfer(owner, ownerCommission);

        uint256 totalStaked = totalStakedAtNode;
        uint256 distributedToStakers;
        if (totalStaked > 0) {
            address[] storage list = stakerList;
            uint256 len = list.length;
            for (uint256 i; i < len;) {
                uint256 stakedAmount = stakers[list[i]].staked;
                if (stakedAmount > 0) {
                    uint256 share = (stakedAmount * toStakers) / totalStaked;
                    if (share > 0) {
                        nilToken.safeTransfer(list[i], share);
                        distributedToStakers += share;
                    }
                }
                unchecked { i++; }
            }
        }
        uint256 remainder = toStakers - distributedToStakers;
        if (remainder > 0) {
            nilToken.safeTransfer(owner, remainder);
        }

        uint256 newEpoch = epochNumber + 1;
        epochNumber = newEpoch;
        emit EpochSettled(newEpoch, rewardAmount, platformFee, ownerCommission, distributedToStakers);
    }

    /// @notice Queue a withdrawal from the caller's staked (at-node) amount only. Does not touch processing stake.
    ///         Staked is NOT reduced here: it is reduced when processWithdrawalBatch() runs, so rewards still
    ///         accrue on the full staked amount until the batch is processed. In Idle phase use
    ///         withdrawProcessingStake() instead. Disabled when staked = 0.
    ///         Remaining free staked after this request must be 0 or >= minStakePerUser; withdrawing all is allowed.
    /// @param amount  NIL to withdraw (must be ≤ staked minus existing pending; must respect 70k pool floor
    ///         after activation, except in ShuttingDown where 70k floor is bypassed).
    function requestWithdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (poolPhase == PoolPhase.Idle) revert IdlePhaseUseWithdrawProcessingStake();

        StakerInfo storage info = stakers[msg.sender];
        uint256 pendingSum = _getPendingWithdrawalSum(msg.sender);
        if (amount > info.staked || pendingSum + amount > info.staked) revert InsufficientStake();

        // Remaining "free" staked after this request = staked - pendingSum - amount; must be 0 or >= min.
        uint256 remaining = info.staked - pendingSum - amount;
        if (remaining > 0 && remaining < minStakePerUser) revert BelowMinimumStake();

        // Active or ShuttingDown: queue withdrawals. In ShuttingDown, 70k floor is bypassed.
        if (poolPhase != PoolPhase.Active && poolPhase != PoolPhase.ShuttingDown) revert OperatorNotInitialized();

        // In Active (not ShuttingDown): enforce pool-level 70k floor (at-node after all pending leaves).
        if (poolPhase == PoolPhase.Active) {
            if (totalStakedAtNode - totalPendingWithdrawals < MIN_OPERATOR_STAKE + amount) revert OperatorStakeTooLow();
        }

        // Enforce max concurrent (unclaimed) withdrawal requests per staker
        uint256 unclaimedCount = _countUnclaimedWithdrawals(msg.sender);
        if (unclaimedCount >= MAX_CONCURRENT_WITHDRAWAL_REQUESTS) revert TooManyWithdrawalRequests();

        // Add user to list for batch iteration if not already present
        if (!isInPendingWithdrawalsList[msg.sender]) {
            usersWithPendingWithdrawals.push(msg.sender);
            isInPendingWithdrawalsList[msg.sender] = true;
        }

        uint64 now64 = uint64(block.timestamp);
        withdrawalQueue[msg.sender].push(
            WithdrawalRequest({amount: amount, requestTimestamp: now64, unlockTimestamp: 0, claimed: false, cancelled: false})
        );
        uint256 index = withdrawalQueue[msg.sender].length - 1;

        totalPendingWithdrawals += amount;
        // staked / totalStakedAtNode / totalUserStakes are reduced in processWithdrawalBatch()

        emit WithdrawQueued(msg.sender, amount, index, 0);
    }

    /// @notice Cancel a pending withdrawal request. Only requests that have not yet been
    ///         included in a batch (unlockTimestamp == 0) can be cancelled. Once the batch
    ///         has been processed and unstake requested on the staking contract, the user
    ///         cannot cancel and must wait to claim. Staked was never reduced on request, so
    ///         we only decrement totalPendingWithdrawals and mark the request cancelled.
    /// @param index  Index in the caller's withdrawal queue of the request to cancel.
    function cancelPendingWithdrawal(uint256 index) external nonReentrant {
        WithdrawalRequest[] storage q = withdrawalQueue[msg.sender];
        if (index >= q.length) revert WithdrawalNotPending();

        WithdrawalRequest storage req = q[index];
        if (req.claimed || req.cancelled) revert WithdrawalNotPending();
        if (req.unlockTimestamp != 0) revert WithdrawalNotPending(); // already batched

        uint256 amount = req.amount;
        req.cancelled = true;
        totalPendingWithdrawals -= amount;
        // staked / totalStakedAtNode / totalUserStakes were not reduced on request, so nothing to restore

        emit WithdrawalCancelled(msg.sender, amount, index);
        _maybePrunePendingWithdrawalsList(msg.sender);
    }

    /// @notice Permissionless: aggregate up to maxEntries unprocessed withdrawal requests,
    ///         reduce stakers' staked and totals, request that amount from the staking contract, and set unlock times.
    ///         Staked is reduced here (not in requestWithdraw) so that sum(stakers.staked) = node stake and
    ///         rewards accrue until the batch is processed.
    /// @param maxEntries  Maximum number of queue entries to include in this batch (gas limit).
    function processWithdrawalBatch(uint256 maxEntries) external nonReentrant {
        if (poolPhase != PoolPhase.Active && poolPhase != PoolPhase.ShuttingDown) revert OperatorNotInitialized();
        (uint256 totalAmount, address[] memory usersToSet, uint256[] memory indicesToSet, uint256 n) =
            _gatherUnprocessedRequests(maxEntries);

        if (totalAmount == 0) return;

        // Reduce each staker's staked and global totals so sum(stakers.staked) = node stake after requestUnstake
        for (uint256 k; k < n;) {
            address u = usersToSet[k];
            uint256 idx = indicesToSet[k];
            uint256 amt = withdrawalQueue[u][idx].amount;
            StakerInfo storage si = stakers[u];
            si.staked -= amt;
            totalStakedAtNode -= amt;
            totalUserStakes -= amt;
            if (si.processingStake == 0 && si.staked == 0) {
                _removeStaker(u);
            }
            unchecked { k++; }
        }

        stakingContract.requestUnstake(operator, totalAmount);
        totalUnstakingRequested += totalAmount;

        uint64 unlockTime = uint64(block.timestamp + stakingContract.unstakeDelay() + WITHDRAWAL_CLAIM_BUFFER);
        for (uint256 k; k < n;) {
            withdrawalQueue[usersToSet[k]][indicesToSet[k]].unlockTimestamp = unlockTime;
            unchecked { k++; }
        }

        emit WithdrawalBatchProcessed(totalAmount, unlockTime);
    }

    /// @notice Permissionless: pull matured NIL from the staking contract into the pool
    ///         and update accounting so queued requests can be claimed.
    function pullUnstakedFromStaking() external nonReentrant {
        if (poolPhase != PoolPhase.Active && poolPhase != PoolPhase.ShuttingDown) revert OperatorNotInitialized();
        uint256 balBefore = nilToken.balanceOf(address(this));
        stakingContract.withdrawUnstaked(operator);
        uint256 received = nilToken.balanceOf(address(this)) - balBefore;
        if (received > 0) {
            if (received > totalUnstakingRequested) totalUnstakingRequested = 0;
            else totalUnstakingRequested -= received;
            emit WithdrawalsUnlocked(received);
        }
    }

    /// @notice Claim all currently claimable withdrawals for msg.sender (up to contract's idle NIL).
    function claimWithdrawals() external nonReentrant {
        _claimFor(msg.sender, msg.sender);
    }

    /// @notice Keeper path: claim all currently claimable withdrawals for a user.
    /// @param user  User whose queue to process; NIL is sent to this user.
    function processUserWithdrawals(address user) external nonReentrant {
        _claimFor(user, user);
    }

    /// @dev Internal claim: fulfill claimable requests for `user`, transfer to `beneficiary`.
    function _claimFor(address user, address beneficiary) internal {
        WithdrawalRequest[] storage q = withdrawalQueue[user];
        uint256 idleBalance = nilToken.balanceOf(address(this));
        uint256 toTransfer;
        uint256 len = q.length;

        for (uint256 i; i < len;) {
            WithdrawalRequest storage req = q[i];
            if (!req.claimed && !req.cancelled && req.unlockTimestamp != 0 && req.unlockTimestamp <= block.timestamp) {
                if (toTransfer + req.amount > idleBalance) break;
                toTransfer += req.amount;
                totalPendingWithdrawals -= req.amount;
                req.claimed = true;
                emit WithdrawalClaimed(user, req.amount, i);
            }
            unchecked { i++; }
        }

        if (toTransfer == 0) revert NothingToClaim();
        nilToken.safeTransfer(beneficiary, toTransfer);
        _maybePrunePendingWithdrawalsList(user);
    }

    /// @dev Check if a user is already in the usersWithPendingWithdrawals list (O(1) via mapping).
    function _isInPendingWithdrawalsList(address user) internal view returns (bool) {
        return isInPendingWithdrawalsList[user];
    }

    /// @dev Count unclaimed, non-cancelled withdrawal requests for a user (concurrent request slots in use).
    function _countUnclaimedWithdrawals(address user) internal view returns (uint256) {
        WithdrawalRequest[] storage q = withdrawalQueue[user];
        uint256 count;
        uint256 len = q.length;
        for (uint256 i; i < len;) {
            if (!q[i].claimed && !q[i].cancelled) count++;
            unchecked { i++; }
        }
        return count;
    }

    /// @dev Sum of unclaimed, non-cancelled withdrawal request amounts for a user (for "processing unstake" and checks).
    function _getPendingWithdrawalSum(address user) internal view returns (uint256) {
        WithdrawalRequest[] storage q = withdrawalQueue[user];
        uint256 sum;
        uint256 len = q.length;
        for (uint256 i; i < len;) {
            if (!q[i].claimed && !q[i].cancelled) sum += q[i].amount;
            unchecked { i++; }
        }
        return sum;
    }

    /// @dev Gather up to maxEntries unprocessed requests; return total amount and (user, index) pairs.
    function _gatherUnprocessedRequests(uint256 maxEntries)
        internal
        view
        returns (uint256 totalAmount, address[] memory usersToSet, uint256[] memory indicesToSet, uint256 n)
    {
        usersToSet = new address[](maxEntries);
        indicesToSet = new uint256[](maxEntries);
        totalAmount = 0;
        n = 0;

        uint256 usersLen = usersWithPendingWithdrawals.length;
        for (uint256 i; i < usersLen && n < maxEntries;) {
            address u = usersWithPendingWithdrawals[i];
            WithdrawalRequest[] storage q = withdrawalQueue[u];
            uint256 qLen = q.length;
            for (uint256 j; j < qLen && n < maxEntries;) {
                if (q[j].unlockTimestamp == 0 && !q[j].claimed && !q[j].cancelled) {
                    totalAmount += q[j].amount;
                    usersToSet[n] = u;
                    indicesToSet[n] = j;
                    n++;
                }
                unchecked { j++; }
            }
            unchecked { i++; }
        }
    }

    /// @dev If user has no unclaimed, non-cancelled withdrawal requests, remove them from
    ///      usersWithPendingWithdrawals so batch iteration stays bounded.
    function _maybePrunePendingWithdrawalsList(address user) internal {
        if (_countUnclaimedWithdrawals(user) != 0) return;
        address[] storage list = usersWithPendingWithdrawals;
        uint256 len = list.length;
        for (uint256 i; i < len;) {
            if (list[i] == user) {
                list[i] = list[len - 1];
                list.pop();
                isInPendingWithdrawalsList[user] = false;
                break;
            }
            unchecked { i++; }
        }
    }

    /// @dev Remove staker from stakerList and clear isStaker (when balance goes to zero).
    function _removeStaker(address staker) internal {
        if (!isStaker[staker]) return;
        isStaker[staker] = false;
        address[] storage list = stakerList;
        uint256 len = list.length;
        for (uint256 i; i < len;) {
            if (list[i] == staker) {
                list[i] = list[len - 1];
                list.pop();
                break;
            }
            unchecked { i++; }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Number of current stakers.
    function stakerCount() external view returns (uint256) {
        return stakerList.length;
    }

    /// @notice Get the withdrawal queue for a user (for indexing and tests).
    function getWithdrawalQueue(address user) external view returns (WithdrawalRequest[] memory) {
        return withdrawalQueue[user];
    }

    /// @notice Number of concurrent (unclaimed) withdrawal requests for a staker.
    ///         Used to enforce MAX_CONCURRENT_WITHDRAWAL_REQUESTS; quota is released on claim.
    function getPendingWithdrawalRequestCount(address user) external view returns (uint256) {
        return _countUnclaimedWithdrawals(user);
    }

    /// @notice Sum of a staker's unclaimed, non-cancelled withdrawal request amounts (processing unstake).
    ///         Use in UI to show "Processing unstake: XXX NIL". Staked is not reduced until processWithdrawalBatch.
    function getPendingWithdrawalSum(address user) external view returns (uint256) {
        return _getPendingWithdrawalSum(user);
    }

    /// @notice Total number of withdrawal requests not yet included in a batch (unlockTimestamp == 0).
    ///         Used by keeper UI to show how many requests are pending for processWithdrawalBatch and to disable the button when zero.
    function totalPendingWithdrawalRequestCount() external view returns (uint256 count) {
        uint256 usersLen = usersWithPendingWithdrawals.length;
        for (uint256 i; i < usersLen;) {
            WithdrawalRequest[] storage q = withdrawalQueue[usersWithPendingWithdrawals[i]];
            uint256 qLen = q.length;
            for (uint256 j; j < qLen;) {
                if (q[j].unlockTimestamp == 0 && !q[j].claimed && !q[j].cancelled) count++;
                unchecked { j++; }
            }
            unchecked { i++; }
        }
    }

    /// @notice Returns true once the operator/node has been activated via the pool.
    ///         False in Idle, ShuttingDown, and Uninitialized.
    /// @dev    Kept for compatibility with earlier designs that used a boolean; now derived from PoolPhase.
    function operatorInitialized() external view returns (bool) {
        return poolPhase == PoolPhase.Active;
    }

    /// @notice Shutdown status for UI. Returns (pending, initiatedAt, effectiveAt, canCancel).
    ///         pending: true if shutdown was initiated and not yet confirmed (cooling-off or elapsed).
    ///         initiatedAt: block timestamp when shutdown was initiated; 0 if not initiated.
    ///         effectiveAt: timestamp when shutdown becomes effective (initiatedAt + cooling-off); 0 if not initiated.
    ///         canCancel: true if cooling-off has not passed and caller is the initiator.
    function getShutdownStatus(address caller) external view returns (bool pending, uint64 initiatedAt, uint64 effectiveAt, bool canCancel) {
        initiatedAt = shutdownInitiatedAt;
        if (initiatedAt == 0) return (false, 0, 0, false);
        effectiveAt = initiatedAt + uint64(SHUTDOWN_COOLING_OFF_PERIOD);
        pending = poolPhase != PoolPhase.ShuttingDown;
        canCancel = pending && block.timestamp < effectiveAt && caller == shutdownInitiatedBy;
        return (pending, initiatedAt, effectiveAt, canCancel);
    }

    /// @notice Per-staker breakdown: processing stake (not yet forwarded) vs staked (at-node).
    ///         processing + atNode = user's total balance. Used by UI to show both and disable flows when zero.
    /// @param user  Staker address.
    /// @return processing  Amount of this staker's balance still in the pool (not yet forwarded).
    /// @return atNode      Amount of this staker's balance already at the staking contract.
    function getStakerStakeBreakdown(address user) external view returns (uint256 processing, uint256 atNode) {
        StakerInfo storage info = stakers[user];
        return (info.processingStake, info.staked);
    }
}
