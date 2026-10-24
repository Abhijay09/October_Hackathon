// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseAccount} from "@account-abstraction/contracts/core/BaseAccount.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {SIG_VALIDATION_FAILED, SIG_VALIDATION_SUCCESS, _packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RBIRules} from "./lib/RBIRules.sol";
import {PolicyLib} from "./lib/PolicyLib.sol";

/// @title AgentWallet — an ERC-4337 smart account that lets an AI agent spend e₹ within an owner policy
/// @notice Threat model: the agent's session key may leak and the agent may be prompt-injected.
///         Every agent action is therefore re-checked on-chain against the owner's policy:
///         allowlisted (target, selector, recipient) Merkle root, per-transaction auto-approve limit
///         (≤ RBI's ₹15,000 AFA relaxation), daily limit (IST calendar day), transactions per hour,
///         and session expiry. Out-of-policy requests are queued for the owner; anomalous ones also
///         freeze the agent. Agent losses can never exceed the daily limit.
/// @dev Rejections never revert inside `executeAsAgent`, so the freeze and the pending request
///      persist. Validation happens for a whole bundle before execution, so execution re-checks
///      the freeze flag too.
contract AgentWallet is BaseAccount {
    using MessageHashUtils for bytes32;

    enum Reason {
        None,
        OverAfaLimit, // above the per-transaction auto-approve limit: needs owner approval (AFA)
        SelfCall, // agent tried to call the wallet itself (admin functions)
        ForbiddenSelector, // approve / transferFrom / permit: standing access to funds
        NotAllowlisted, // (target, selector, recipient) not under the owner's Merkle root
        VelocityLimit, // too many transactions this hour
        DailyLimit, // would exceed the IST-day spending limit
        BalanceDrift, // the call moved more e₹ than it declared
        CallFailed, // the target reverted; nothing moved
        Frozen, // the agent was already frozen when this op executed
        SessionInactive // the session key was revoked before this op executed
    }

    enum PendingStatus {
        None,
        Open,
        Approved,
        Rejected
    }

    struct Session {
        bool active;
        uint48 validAfter;
        uint48 validUntil;
        uint32 maxTxPerHour;
        uint128 perTxLimit; // paise
        uint128 dailyLimit; // paise
    }

    struct Usage {
        uint64 day; // IST day index of spentToday
        uint64 hour; // hour index of txThisHour
        uint32 txThisHour;
        uint128 spentToday; // paise
    }

    struct PendingRequest {
        address agent;
        address target;
        address recipient;
        uint64 createdAt;
        PendingStatus status;
        Reason reason;
        uint256 amount; // paise
        bytes data;
    }

    struct RecoveryRequest {
        address newOwner;
        uint64 executableAt; // 0 until the threshold is reached
        uint8 approvals;
        uint64 round;
    }

    uint256 public constant GUARDIAN_COUNT = 5;
    uint256 public constant RECOVERY_THRESHOLD = 3;
    uint256 public constant RECOVERY_DELAY = 48 hours;
    uint256 public constant PENDING_TTL = 24 hours;
    uint256 public constant MAX_OPEN_PENDING = 25;

    IEntryPoint private immutable _entryPoint;
    IERC20 public immutable rupee;

    address public owner;
    address public paymaster;
    bytes32 public policyRoot;
    bool public frozen;
    Reason public lastFreezeReason;
    uint64 public fraudReportedAt;

    mapping(address => Session) public sessions;
    mapping(address => Usage) public usage;
    address[] private _sessionKeys;

    mapping(uint256 => PendingRequest) private _pending;
    uint256 public pendingCount;
    uint256 public openPending;

    address[] private _guardians;
    mapping(address => bool) public isGuardian;
    RecoveryRequest public recovery;
    mapping(uint64 => mapping(address => bool)) public recoveryVoted;

    event AgentPayment(
        address indexed agent, address indexed target, address indexed recipient, uint256 amount, uint256 spentToday
    );
    event AgentBlocked(
        address indexed agent,
        address indexed target,
        address indexed recipient,
        uint256 amount,
        Reason reason,
        bool froze,
        uint256 pendingId
    );
    event ApprovalPending(uint256 indexed id, address indexed agent, address recipient, uint256 amount, Reason reason);
    event PendingApproved(uint256 indexed id, address indexed recipient, uint256 amount);
    event PendingRejected(uint256 indexed id);
    event AgentFrozen(Reason reason, address by);
    event AgentUnfrozen(address indexed rotatedFrom, address indexed rotatedTo);
    event FraudReported(uint64 at);
    event SessionAdded(address indexed key, uint48 validAfter, uint48 validUntil, uint128 perTxLimit, uint128 dailyLimit, uint32 maxTxPerHour);
    event SessionRevoked(address indexed key);
    event PolicyRootUpdated(bytes32 root);
    event PaymasterUpdated(address paymaster);
    event GuardiansUpdated(address[] guardians);
    event RecoveryProposed(uint64 indexed round, address indexed guardian, address newOwner);
    event RecoverySupported(uint64 indexed round, address indexed guardian, uint8 approvals);
    event RecoveryReady(uint64 indexed round, address newOwner, uint64 executableAt);
    event RecoveryVetoed(uint64 indexed round);
    event RecoveryExecuted(uint64 indexed round, address oldOwner, address newOwner);
    event OwnerExecuted(address indexed target, uint256 value, bytes data);

    error Unauthorized();
    error InvalidLimits();
    error InvalidGuardians();
    error NotOpen(uint256 id);
    error Expired(uint256 id);
    error AboveHardCap(uint256 amount);
    error CallReverted(bytes reason);
    error BalanceDriftDetected(uint256 moved, uint256 declared);
    error RecoveryConflict();
    error RecoveryNotReady();
    error AlreadyVoted();
    error InvalidCall();

    modifier onlyOwnerOrSelf() {
        if (msg.sender != owner && msg.sender != address(this)) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrEntryPoint() {
        // Session keys can only produce `executeAsAgent` calldata (enforced in validation), so an
        // EntryPoint call to an owner function always carries the owner's signature.
        if (msg.sender != owner && msg.sender != address(_entryPoint)) revert Unauthorized();
        _;
    }

    modifier onlyGuardian() {
        if (!isGuardian[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(
        IEntryPoint entryPoint_,
        IERC20 rupee_,
        address owner_,
        address paymaster_,
        address[] memory guardians_
    ) {
        _entryPoint = entryPoint_;
        rupee = rupee_;
        owner = owner_;
        paymaster = paymaster_;
        _setGuardians(guardians_);
    }

    receive() external payable {}

    // ------------------------------------------------------------------
    // ERC-4337 validation
    // ------------------------------------------------------------------

    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    /// @notice Nonces are 2D: each signer uses its own key, so owner and agent ops never collide.
    function getNonceFor(address signer) external view returns (uint256) {
        return _entryPoint.getNonce(address(this), uint192(uint160(signer)));
    }

    /// @dev `userOpHash` already commits to the chain id, the EntryPoint address and the nonce, so a
    ///      signature cannot be replayed on another chain, wallet or EntryPoint.
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        override
        returns (uint256 validationData)
    {
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(userOpHash.toEthSignedMessageHash(), userOp.signature);
        if (err != ECDSA.RecoverError.NoError) return SIG_VALIDATION_FAILED;
        if (signer == owner) return SIG_VALIDATION_SUCCESS;

        Session memory s = sessions[signer];
        if (!s.active || frozen) return SIG_VALIDATION_FAILED;

        // A session key may only call executeAsAgent, naming itself as the agent.
        bytes calldata callData = userOp.callData;
        if (callData.length < 36 || bytes4(callData[:4]) != this.executeAsAgent.selector) {
            return SIG_VALIDATION_FAILED;
        }
        if (address(uint160(uint256(bytes32(callData[4:36])))) != signer) return SIG_VALIDATION_FAILED;

        // Agent gas must come from the quota-limited paymaster, never from the wallet's own ETH.
        if (userOp.paymasterAndData.length < 20 || address(bytes20(userOp.paymasterAndData[:20])) != paymaster) {
            return SIG_VALIDATION_FAILED;
        }

        // Expiry is enforced by the EntryPoint itself via validAfter / validUntil.
        return _packValidationData(false, s.validUntil, s.validAfter);
    }

    // ------------------------------------------------------------------
    // Agent execution path
    // ------------------------------------------------------------------

    /// @notice The only entry point available to session keys.
    /// @param agent The session key that signed the UserOp (checked during validation).
    /// @param target Contract to call, typically the e₹ token.
    /// @param data Calldata, typically `transfer(merchant, amountPaise)`.
    /// @param proof Merkle proof that (target, selector, recipient) is in the owner's policy.
    function executeAsAgent(address agent, address target, bytes calldata data, bytes32[] calldata proof) external {
        _requireFromEntryPoint();
        (bytes4 selector, address recipient, uint256 amount) = _decodeAction(target, data);

        if (frozen) {
            emit AgentBlocked(agent, target, recipient, amount, Reason.Frozen, false, 0);
            return;
        }
        Session memory s = sessions[agent];
        if (!s.active) {
            emit AgentBlocked(agent, target, recipient, amount, Reason.SessionInactive, false, 0);
            return;
        }

        Usage storage u = usage[agent];
        _rollWindows(u);
        u.txThisHour += 1;

        Reason reason = _classify(s, u, target, selector, recipient, amount, proof);
        if (reason == Reason.None) {
            try this.performAgentCall(target, data, amount) {
                u.spentToday += uint128(amount);
                emit AgentPayment(agent, target, recipient, amount, u.spentToday);
                return;
            } catch (bytes memory err) {
                reason = (err.length >= 4 && bytes4(err) == BalanceDriftDetected.selector)
                    ? Reason.BalanceDrift
                    : Reason.CallFailed;
            }
        }
        _reject(agent, target, data, recipient, amount, reason);
    }

    /// @dev External so the agent call can be wrapped in try/catch; only the wallet may call it.
    function performAgentCall(address target, bytes calldata data, uint256 declaredSpend) external {
        if (msg.sender != address(this)) revert Unauthorized();
        _callWithSpendCheck(target, data, declaredSpend);
    }

    function _classify(
        Session memory s,
        Usage storage u,
        address target,
        bytes4 selector,
        address recipient,
        uint256 amount,
        bytes32[] calldata proof
    ) internal view returns (Reason) {
        if (target == address(this)) return Reason.SelfCall;
        if (PolicyLib.isForbiddenSelector(selector)) return Reason.ForbiddenSelector;
        if (!MerkleProof.verifyCalldata(proof, policyRoot, PolicyLib.leaf(target, selector, recipient))) {
            return Reason.NotAllowlisted;
        }
        if (u.txThisHour > s.maxTxPerHour) return Reason.VelocityLimit;
        // A single large payment to an allowlisted merchant is a normal "ask the owner" case, so
        // it is checked before the daily limit; only cumulative overspend (salami-slicing) freezes.
        if (amount > s.perTxLimit) return Reason.OverAfaLimit;
        if (uint256(u.spentToday) + amount > s.dailyLimit) return Reason.DailyLimit;
        return Reason.None;
    }

    /// @dev Only an over-limit payment to an allowlisted merchant is "benign". Every other
    ///      rejection is a hijack signal and freezes the agent. Anything out of policy is queued
    ///      for the owner (except failed calls and ops arriving after a freeze).
    function _reject(
        address agent,
        address target,
        bytes calldata data,
        address recipient,
        uint256 amount,
        Reason reason
    ) internal {
        bool freezeAgent = reason != Reason.OverAfaLimit && reason != Reason.CallFailed;
        if (freezeAgent) {
            frozen = true;
            lastFreezeReason = reason;
            emit AgentFrozen(reason, agent);
        }

        uint256 id;
        if (reason != Reason.CallFailed && openPending < MAX_OPEN_PENDING) {
            id = ++pendingCount;
            openPending += 1;
            _pending[id] = PendingRequest({
                agent: agent,
                target: target,
                recipient: recipient,
                createdAt: uint64(block.timestamp),
                status: PendingStatus.Open,
                reason: reason,
                amount: amount,
                data: data
            });
            emit ApprovalPending(id, agent, recipient, amount, reason);
        }
        emit AgentBlocked(agent, target, recipient, amount, reason, freezeAgent, id);
    }

    function _decodeAction(address target, bytes calldata data)
        internal
        view
        returns (bytes4 selector, address recipient, uint256 amount)
    {
        if (data.length >= 4) selector = bytes4(data[:4]);
        if (target == address(rupee) && selector == PolicyLib.ERC20_TRANSFER && data.length >= 68) {
            (recipient, amount) = abi.decode(data[4:68], (address, uint256));
        }
    }

    function _rollWindows(Usage storage u) internal {
        uint64 today = RBIRules.istDay(block.timestamp);
        if (u.day != today) {
            u.day = today;
            u.spentToday = 0;
        }
        uint64 hour = RBIRules.hourIndex(block.timestamp);
        if (u.hour != hour) {
            u.hour = hour;
            u.txThisHour = 0;
        }
    }

    function _callWithSpendCheck(address target, bytes memory data, uint256 declaredSpend) internal {
        uint256 before = rupee.balanceOf(address(this));
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert CallReverted(ret);
        if (target == address(rupee) && ret.length == 32 && !abi.decode(ret, (bool))) revert CallReverted(ret);
        uint256 afterwards = rupee.balanceOf(address(this));
        if (afterwards + declaredSpend < before) revert BalanceDriftDetected(before - afterwards, declaredSpend);
    }

    // ------------------------------------------------------------------
    // Owner approvals (the "additional factor of authentication")
    // ------------------------------------------------------------------

    function approvePending(uint256 id) external onlyOwnerOrSelf {
        PendingRequest storage p = _pending[id];
        if (p.status != PendingStatus.Open) revert NotOpen(id);
        if (block.timestamp > p.createdAt + PENDING_TTL) revert Expired(id);
        if (p.amount > RBIRules.HARD_PER_TX_CAP) revert AboveHardCap(p.amount);
        if (p.target == address(this)) revert InvalidCall();

        p.status = PendingStatus.Approved;
        openPending -= 1;
        _callWithSpendCheck(p.target, p.data, p.amount);
        emit PendingApproved(id, p.recipient, p.amount);
    }

    function rejectPending(uint256 id) external onlyOwnerOrSelf {
        PendingRequest storage p = _pending[id];
        if (p.status != PendingStatus.Open) revert NotOpen(id);
        p.status = PendingStatus.Rejected;
        openPending -= 1;
        emit PendingRejected(id);
    }

    function getPending(uint256 id) external view returns (PendingRequest memory) {
        return _pending[id];
    }

    // ------------------------------------------------------------------
    // Owner administration
    // ------------------------------------------------------------------

    function execute(address target, uint256 value, bytes calldata data) external onlyOwnerOrEntryPoint {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallReverted(ret);
        emit OwnerExecuted(target, value, data);
    }

    function addSession(
        address key,
        uint48 validAfter,
        uint48 validUntil,
        uint128 perTxLimit,
        uint128 dailyLimit,
        uint32 maxTxPerHour
    ) external onlyOwnerOrSelf {
        if (key == address(0) || key == owner || validUntil <= validAfter) revert InvalidLimits();
        _checkLimits(perTxLimit, dailyLimit, maxTxPerHour);
        if (!_isKnownKey(key)) _sessionKeys.push(key);
        sessions[key] = Session(true, validAfter, validUntil, maxTxPerHour, perTxLimit, dailyLimit);
        emit SessionAdded(key, validAfter, validUntil, perTxLimit, dailyLimit, maxTxPerHour);
    }

    function setLimits(address key, uint128 perTxLimit, uint128 dailyLimit, uint32 maxTxPerHour)
        external
        onlyOwnerOrSelf
    {
        Session storage s = sessions[key];
        if (!s.active) revert InvalidLimits();
        _checkLimits(perTxLimit, dailyLimit, maxTxPerHour);
        s.perTxLimit = perTxLimit;
        s.dailyLimit = dailyLimit;
        s.maxTxPerHour = maxTxPerHour;
        emit SessionAdded(key, s.validAfter, s.validUntil, perTxLimit, dailyLimit, maxTxPerHour);
    }

    function revokeSession(address key) external onlyOwnerOrSelf {
        sessions[key].active = false;
        emit SessionRevoked(key);
    }

    function setPolicyRoot(bytes32 root) external onlyOwnerOrSelf {
        policyRoot = root;
        emit PolicyRootUpdated(root);
    }

    function setPaymaster(address paymaster_) external onlyOwnerOrSelf {
        paymaster = paymaster_;
        emit PaymasterUpdated(paymaster_);
    }

    /// @notice The RBI-style "switch off": stop all agent spending immediately.
    function freeze() external onlyOwnerOrSelf {
        frozen = true;
        emit AgentFrozen(Reason.None, msg.sender);
    }

    /// @notice Freeze and timestamp a fraud report (RBI's customer-liability window runs from reporting).
    function reportFraud() external onlyOwnerOrSelf {
        frozen = true;
        fraudReportedAt = uint64(block.timestamp);
        emit AgentFrozen(Reason.None, msg.sender);
        emit FraudReported(fraudReportedAt);
    }

    /// @notice Unfreeze, optionally moving a (possibly leaked) session to a fresh key.
    function unfreeze(address rotateFrom, address rotateTo) external onlyOwnerOrSelf {
        if (rotateTo != address(0)) {
            Session memory s = sessions[rotateFrom];
            if (!s.active || rotateTo == owner || sessions[rotateTo].active) revert InvalidLimits();
            sessions[rotateFrom].active = false;
            if (!_isKnownKey(rotateTo)) _sessionKeys.push(rotateTo);
            sessions[rotateTo] = s;
            usage[rotateTo] = usage[rotateFrom]; // the day's spend carries over to the new key
            emit SessionRevoked(rotateFrom);
            emit SessionAdded(rotateTo, s.validAfter, s.validUntil, s.perTxLimit, s.dailyLimit, s.maxTxPerHour);
        }
        frozen = false;
        lastFreezeReason = Reason.None;
        emit AgentUnfrozen(rotateFrom, rotateTo);
    }

    function setGuardians(address[] calldata guardians_) external onlyOwnerOrSelf {
        if (recovery.newOwner != address(0)) revert RecoveryConflict();
        _setGuardians(guardians_);
    }

    function sessionKeys() external view returns (address[] memory) {
        return _sessionKeys;
    }

    function guardians() external view returns (address[] memory) {
        return _guardians;
    }

    function _checkLimits(uint128 perTxLimit, uint128 dailyLimit, uint32 maxTxPerHour) internal pure {
        if (perTxLimit == 0 || perTxLimit > RBIRules.AFA_EXEMPT_LIMIT) revert InvalidLimits();
        if (dailyLimit < perTxLimit || maxTxPerHour == 0) revert InvalidLimits();
    }

    function _isKnownKey(address key) internal view returns (bool) {
        for (uint256 i; i < _sessionKeys.length; ++i) {
            if (_sessionKeys[i] == key) return true;
        }
        return false;
    }

    function _setGuardians(address[] memory guardians_) internal {
        if (guardians_.length != GUARDIAN_COUNT) revert InvalidGuardians();
        for (uint256 i; i < _guardians.length; ++i) {
            isGuardian[_guardians[i]] = false;
        }
        for (uint256 i; i < guardians_.length; ++i) {
            address g = guardians_[i];
            if (g == address(0) || g == owner || isGuardian[g]) revert InvalidGuardians();
            isGuardian[g] = true;
        }
        _guardians = guardians_;
        emit GuardiansUpdated(guardians_);
    }

    // ------------------------------------------------------------------
    // Social recovery: 3-of-5 guardians, 48h timelock, owner veto
    // ------------------------------------------------------------------

    function proposeRecovery(address newOwner) external onlyGuardian {
        if (newOwner == address(0) || recovery.newOwner != address(0)) revert RecoveryConflict();
        uint64 round = recovery.round + 1;
        recovery = RecoveryRequest({newOwner: newOwner, executableAt: 0, approvals: 1, round: round});
        recoveryVoted[round][msg.sender] = true;
        emit RecoveryProposed(round, msg.sender, newOwner);
    }

    function supportRecovery() external onlyGuardian {
        RecoveryRequest storage r = recovery;
        if (r.newOwner == address(0)) revert RecoveryNotReady();
        if (recoveryVoted[r.round][msg.sender]) revert AlreadyVoted();
        recoveryVoted[r.round][msg.sender] = true;
        r.approvals += 1;
        emit RecoverySupported(r.round, msg.sender, r.approvals);
        if (r.approvals == RECOVERY_THRESHOLD) {
            r.executableAt = uint64(block.timestamp + RECOVERY_DELAY);
            emit RecoveryReady(r.round, r.newOwner, r.executableAt);
        }
    }

    /// @notice Owner veto: cancels a pending recovery at any time before it executes.
    function cancelRecovery() external onlyOwnerOrSelf {
        if (recovery.newOwner == address(0)) revert RecoveryNotReady();
        uint64 round = recovery.round;
        recovery = RecoveryRequest({newOwner: address(0), executableAt: 0, approvals: 0, round: round});
        emit RecoveryVetoed(round);
    }

    /// @notice Anyone may execute a recovery once 3 guardians agreed and 48 hours have passed.
    ///         All agent sessions are revoked and the wallet stays frozen until the new owner acts.
    function executeRecovery() external {
        RecoveryRequest memory r = recovery;
        if (r.newOwner == address(0) || r.executableAt == 0 || block.timestamp < r.executableAt) {
            revert RecoveryNotReady();
        }
        if (isGuardian[r.newOwner]) revert RecoveryConflict();
        address oldOwner = owner;
        owner = r.newOwner;
        for (uint256 i; i < _sessionKeys.length; ++i) {
            if (sessions[_sessionKeys[i]].active) {
                sessions[_sessionKeys[i]].active = false;
                emit SessionRevoked(_sessionKeys[i]);
            }
        }
        frozen = true;
        recovery = RecoveryRequest({newOwner: address(0), executableAt: 0, approvals: 0, round: r.round});
        emit RecoveryExecuted(r.round, oldOwner, r.newOwner);
    }
}
