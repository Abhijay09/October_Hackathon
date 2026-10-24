// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {Fixture} from "./utils/Fixture.sol";
import {PolicyPaymaster} from "../src/PolicyPaymaster.sol";

contract PaymasterTest is Fixture {
    function test_chargesActualGasToWalletQuota() public {
        agentPays(kirana, rs(100));
        uint256 spent = pm.gasSpent(address(wallet));
        assertGt(spent, 0);
        assertEq(pm.remainingQuota(address(wallet)), PM_QUOTA - spent);
    }

    function test_rejectsOpsSignedByUnknownSigner() public {
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(100)));
        op = signPaymaster(op, attackerPk, uint48(block.timestamp + 5 minutes), uint48(block.timestamp - 1));
        op.signature = signUserOp(op, agentPk);
        expectFailedOp("AA34 signature error");
        send(op);
    }

    function test_rejectsStalePaymasterSignature() public {
        PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(100)));
        op = signPaymaster(op, pmSignerPk, uint48(block.timestamp + 5 minutes), uint48(block.timestamp - 1));
        op.signature = signUserOp(op, agentPk);
        vm.warp(block.timestamp + 6 minutes);
        expectFailedOp("AA32 paymaster expired or not due");
        send(op);
    }

    function test_quotaReservedAcrossBundle() public {
        // Each op reserves its max cost during validation, so a bundle cannot overshoot the quota
        // even though no postOp has run yet when later ops validate.
        PackedUserOperation memory probe = buildOp(address(wallet), agentPk, payCall(kirana, rs(1)));
        uint256 maxCost = (uint256(300_000) + 500_000 + 50_000 + 150_000 + 80_000) * 2 gwei;
        pm.setQuota(address(wallet), maxCost * 2 + 1);
        (probe);

        PackedUserOperation[] memory ops = new PackedUserOperation[](3);
        for (uint256 i; i < 3; ++i) {
            PackedUserOperation memory op = buildOp(address(wallet), agentPk, payCall(kirana, rs(1)));
            op.nonce = ep.getNonce(address(wallet), uint192(uint160(agent))) + i;
            op = signPaymaster(op, pmSignerPk, uint48(block.timestamp + 5 minutes), uint48(block.timestamp - 1));
            op.signature = signUserOp(op, agentPk);
            ops[i] = op;
        }
        vm.prank(bundler, bundler);
        vm.expectRevert(); // FailedOpWithRevert(2, "AA33 reverted", QuotaExceeded(...))
        ep.handleOps(ops, bundler);
    }

    function test_onlyOwnerConfiguresQuota() public {
        vm.prank(attacker);
        vm.expectRevert();
        pm.setQuota(address(wallet), 100 ether);
    }
}
