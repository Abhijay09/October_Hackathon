// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PolicyLib
/// @notice Encoding of the owner's allowlist. Each allowed action is a Merkle leaf over
///         (target, selector, recipient); the wallet stores only the 32-byte root.
/// @dev The leaf is double-hashed so roots built with OpenZeppelin's StandardMerkleTree
///      (types ["address", "bytes4", "address"]) verify on-chain unchanged.
library PolicyLib {
    bytes4 internal constant ERC20_TRANSFER = 0xa9059cbb; // transfer(address,uint256)

    // Selectors an agent may never use, whatever the policy says: they grant third parties
    // standing access to the wallet's e₹, which would bypass every per-payment check.
    bytes4 internal constant ERC20_APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant ERC20_TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)
    bytes4 internal constant ERC20_INCREASE_ALLOWANCE = 0x39509351; // increaseAllowance(address,uint256)
    bytes4 internal constant ERC2612_PERMIT = 0xd505accf; // permit(address,address,uint256,uint256,uint8,bytes32,bytes32)

    function leaf(address target, bytes4 selector, address recipient) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(target, selector, recipient))));
    }

    function isForbiddenSelector(bytes4 selector) internal pure returns (bool) {
        return selector == ERC20_APPROVE || selector == ERC20_TRANSFER_FROM
            || selector == ERC20_INCREASE_ALLOWANCE || selector == ERC2612_PERMIT;
    }
}
