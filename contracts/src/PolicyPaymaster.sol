// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "@account-abstraction/contracts/core/UserOperationLib.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title PolicyPaymaster — sponsors agent gas so users never handle ETH, within a hard per-wallet quota
/// @notice Two layers: the off-chain service only signs ops it is willing to sponsor, and the
///         on-chain quota caps total gas per wallet, so even a compromised signer or a spamming
///         agent cannot drain the deposit beyond the quota.
/// @dev paymasterAndData = paymaster (20) | verificationGas (16) | postOpGas (16) |
///      abi.encode(uint48 validUntil, uint48 validAfter) (64) | signature (65).
///      Each op's max cost is reserved during validation (all ops in a bundle validate before any
///      executes), and the unused part is released in postOp.
contract PolicyPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    uint256 private constant VALID_TIMESTAMP_OFFSET = PAYMASTER_DATA_OFFSET;
    uint256 private constant SIGNATURE_OFFSET = VALID_TIMESTAMP_OFFSET + 64;

    address public verifyingSigner;
    uint256 public defaultQuota; // wei of gas per wallet
    mapping(address => uint256) public quotaOverride;
    mapping(address => uint256) public gasSpent; // includes in-flight reservations

    event GasCharged(address indexed wallet, uint256 actualGasCost, uint256 totalSpent);
    event QuotaSet(address indexed wallet, uint256 quota);
    event SignerUpdated(address signer);

    error QuotaExceeded(address wallet, uint256 spent, uint256 maxCost, uint256 quota);
    error InvalidSignatureLength();

    constructor(IEntryPoint entryPoint_, address signer_, uint256 defaultQuota_) BasePaymaster(entryPoint_) {
        verifyingSigner = signer_;
        defaultQuota = defaultQuota_;
    }

    function quotaOf(address wallet) public view returns (uint256) {
        uint256 q = quotaOverride[wallet];
        return q == 0 ? defaultQuota : q;
    }

    function remainingQuota(address wallet) external view returns (uint256) {
        uint256 q = quotaOf(wallet);
        uint256 spent = gasSpent[wallet];
        return spent >= q ? 0 : q - spent;
    }

    function setQuota(address wallet, uint256 quota) external onlyOwner {
        quotaOverride[wallet] = quota;
        emit QuotaSet(wallet, quota);
    }

    function setDefaultQuota(uint256 quota) external onlyOwner {
        defaultQuota = quota;
    }

    function setSigner(address signer_) external onlyOwner {
        verifyingSigner = signer_;
        emit SignerUpdated(signer_);
    }

    function resetSpent(address wallet) external onlyOwner {
        gasSpent[wallet] = 0;
    }

    /// @notice Hash the off-chain signer signs. Excludes the signature itself; binds chain and paymaster.
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                userOp.getSender(),
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(bytes32(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET])),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    function parsePaymasterAndData(bytes calldata paymasterAndData)
        public
        pure
        returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
    {
        (validUntil, validAfter) = abi.decode(paymasterAndData[VALID_TIMESTAMP_OFFSET:SIGNATURE_OFFSET], (uint48, uint48));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        (uint48 validUntil, uint48 validAfter, bytes calldata signature) = parsePaymasterAndData(userOp.paymasterAndData);
        if (signature.length != 64 && signature.length != 65) revert InvalidSignatureLength();

        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != verifyingSigner) {
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        address wallet = userOp.getSender();
        uint256 spent = gasSpent[wallet];
        uint256 quota = quotaOf(wallet);
        if (spent + maxCost > quota) revert QuotaExceeded(wallet, spent, maxCost, quota);
        gasSpent[wallet] = spent + maxCost; // reserve

        return (abi.encode(wallet, maxCost), _packValidationData(false, validUntil, validAfter));
    }

    function _postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256) internal override {
        (address wallet, uint256 reserved) = abi.decode(context, (address, uint256));
        uint256 spent = gasSpent[wallet] - reserved + actualGasCost;
        gasSpent[wallet] = spent;
        emit GasCharged(wallet, actualGasCost, spent);
    }
}
