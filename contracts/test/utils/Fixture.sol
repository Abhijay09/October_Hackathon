// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentWallet} from "../../src/AgentWallet.sol";
import {PolicyPaymaster} from "../../src/PolicyPaymaster.sol";
import {ERupee} from "../../src/ERupee.sol";
import {PolicyLib} from "../../src/lib/PolicyLib.sol";

/// @dev Shared deployment + UserOp helpers. Every agent action in the tests goes through the real
///      EntryPoint v0.7 with a signed paymaster, exactly as on a live chain.
abstract contract Fixture is Test {
    using MessageHashUtils for bytes32;

    // 2026-10-24 12:00 IST
    uint256 internal constant START = 1_792_823_400;
    uint256 internal constant PM_QUOTA = 1 ether;

    EntryPoint internal ep;
    ERupee internal inr;
    PolicyPaymaster internal pm;
    AgentWallet internal wallet;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal agentPk = 0xA6E47;
    uint256 internal pmSignerPk = 0xBEEF;
    uint256 internal attackerPk = 0xBAD;

    address internal owner;
    address internal agent;
    address internal pmSigner;
    address internal attacker;
    address payable internal bundler = payable(address(0xB0B));
    address internal bank = address(0xBA4C);

    address internal kirana = address(0x1001); // "Kirana Mart" (fictional)
    address internal railtix = address(0x1002); // "RailTix" (fictional)
    address internal apiCredits = address(0x1003); // "API Credits Co." (fictional)

    address[] internal guardians;
    uint256[] internal guardianPks;

    bytes32[] internal leaves;
    bytes32 internal root;

    function setUp() public virtual {
        vm.warp(START);
        owner = vm.addr(ownerPk);
        agent = vm.addr(agentPk);
        pmSigner = vm.addr(pmSignerPk);
        attacker = vm.addr(attackerPk);
        for (uint256 i; i < 5; ++i) {
            guardianPks.push(0x6000 + i);
            guardians.push(vm.addr(0x6000 + i));
        }

        ep = new EntryPoint();
        inr = new ERupee();
        pm = new PolicyPaymaster(IEntryPoint(address(ep)), pmSigner, PM_QUOTA);
        pm.deposit{value: 100 ether}();
        wallet = new AgentWallet(IEntryPoint(address(ep)), IERC20(address(inr)), owner, address(pm), guardians);

        inr.registerWallet(address(wallet), bank);
        inr.mint(address(wallet), rs(50_000));

        leaves.push(transferLeaf(kirana));
        leaves.push(transferLeaf(railtix));
        leaves.push(transferLeaf(apiCredits));
        root = merkleRoot(leaves);

        vm.startPrank(owner);
        wallet.setPolicyRoot(root);
        wallet.addSession(agent, uint48(START), uint48(START + 7 days), uint128(rs(5_000)), uint128(rs(20_000)), 5);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- amounts

    function rs(uint256 rupees) internal pure returns (uint256) {
        return rupees * 100;
    }

    // ---------------------------------------------------------------- policy / merkle

    function transferLeaf(address recipient) internal view returns (bytes32) {
        return PolicyLib.leaf(address(inr), PolicyLib.ERC20_TRANSFER, recipient);
    }

    function merkleRoot(bytes32[] memory nodes) internal pure returns (bytes32) {
        if (nodes.length == 0) return bytes32(0);
        bytes32[] memory level = nodes;
        while (level.length > 1) level = _nextLevel(level);
        return level[0];
    }

    function merkleProof(bytes32[] memory nodes, uint256 index) internal pure returns (bytes32[] memory proof) {
        bytes32[] memory tmp = new bytes32[](32);
        uint256 len;
        bytes32[] memory level = nodes;
        while (level.length > 1) {
            uint256 sibling = index ^ 1;
            if (sibling < level.length) tmp[len++] = level[sibling];
            level = _nextLevel(level);
            index /= 2;
        }
        proof = new bytes32[](len);
        for (uint256 i; i < len; ++i) proof[i] = tmp[i];
    }

    function proofFor(address merchant) internal view returns (bytes32[] memory) {
        bytes32 l = transferLeaf(merchant);
        for (uint256 i; i < leaves.length; ++i) {
            if (leaves[i] == l) return merkleProof(leaves, i);
        }
        return new bytes32[](0);
    }

    function _nextLevel(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i; i < level.length; i += 2) {
            if (i + 1 == level.length) {
                next[i / 2] = level[i];
            } else {
                (bytes32 a, bytes32 b) = level[i] < level[i + 1] ? (level[i], level[i + 1]) : (level[i + 1], level[i]);
                next[i / 2] = keccak256(abi.encodePacked(a, b));
            }
        }
    }

    // ---------------------------------------------------------------- userops

    function agentCall(address target, bytes memory data, bytes32[] memory proof) internal view returns (bytes memory) {
        return abi.encodeCall(AgentWallet.executeAsAgent, (agent, target, data, proof));
    }

    function payCall(address merchant, uint256 amountPaise) internal view returns (bytes memory) {
        return agentCall(
            address(inr), abi.encodeCall(IERC20.transfer, (merchant, amountPaise)), proofFor(merchant)
        );
    }

    /// @dev Build a UserOp for `sender`, signed by `signerPk`, sponsored by the paymaster.
    function buildOp(address sender, uint256 signerPk, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        address signer = vm.addr(signerPk);
        op.sender = sender;
        op.nonce = ep.getNonce(sender, uint192(uint160(signer)));
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(300_000) << 128) | uint256(500_000));
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
        op = signPaymaster(op, pmSignerPk, uint48(block.timestamp + 5 minutes), uint48(block.timestamp - 1));
        op.signature = signUserOp(op, signerPk);
    }

    function signPaymaster(PackedUserOperation memory op, uint256 pk, uint48 validUntil, uint48 validAfter)
        internal
        view
        returns (PackedUserOperation memory)
    {
        op.paymasterAndData = abi.encodePacked(
            address(pm), uint128(150_000), uint128(80_000), abi.encode(validUntil, validAfter)
        );
        bytes32 h = this.paymasterHash(op, validUntil, validAfter);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h.toEthSignedMessageHash());
        op.paymasterAndData = bytes.concat(op.paymasterAndData, abi.encodePacked(r, s, v));
        return op;
    }

    /// @dev External shim: PolicyPaymaster.getHash takes calldata.
    function paymasterHash(PackedUserOperation calldata op, uint48 validUntil, uint48 validAfter)
        external
        view
        returns (bytes32)
    {
        return pm.getHash(op, validUntil, validAfter);
    }

    function signUserOp(PackedUserOperation memory op, uint256 pk) internal view returns (bytes memory) {
        bytes32 h = ep.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h.toEthSignedMessageHash());
        return abi.encodePacked(r, s, v);
    }

    function send(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, bundler);
    }

    function sendBundle(PackedUserOperation[] memory ops) internal {
        vm.prank(bundler, bundler);
        ep.handleOps(ops, bundler);
    }

    function agentPays(address merchant, uint256 amountPaise) internal {
        send(buildOp(address(wallet), agentPk, payCall(merchant, amountPaise)));
    }

    function expectFailedOp(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
    }

    function lastPendingReason() internal view returns (AgentWallet.Reason) {
        return wallet.getPending(wallet.pendingCount()).reason;
    }
}
