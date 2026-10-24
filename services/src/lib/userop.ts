// ERC-4337 v0.7 PackedUserOperation helpers.
import {
  concat,
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";

export interface PackedUserOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex; // verificationGasLimit (16) | callGasLimit (16)
  preVerificationGas: bigint;
  gasFees: Hex; // maxPriorityFeePerGas (16) | maxFeePerGas (16)
  paymasterAndData: Hex;
  signature: Hex;
}

/** Fixed, generous limits: fine for a local prototype, simpler than per-op estimation. */
export const GAS = {
  verificationGasLimit: 300_000n,
  callGasLimit: 500_000n,
  preVerificationGas: 60_000n,
  paymasterVerificationGasLimit: 150_000n,
  paymasterPostOpGasLimit: 80_000n,
} as const;

export function packUints(high: bigint, low: bigint): Hex {
  return pad(toHex((high << 128n) | low), { size: 32 });
}

export function unpackUints(packed: Hex): [bigint, bigint] {
  const v = BigInt(packed);
  return [v >> 128n, v & ((1n << 128n) - 1n)];
}

export function newUserOp(sender: Address, nonce: bigint, callData: Hex, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): PackedUserOp {
  return {
    sender,
    nonce,
    initCode: "0x",
    callData,
    accountGasLimits: packUints(GAS.verificationGasLimit, GAS.callGasLimit),
    preVerificationGas: GAS.preVerificationGas,
    gasFees: packUints(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/** Same as EntryPoint v0.7 getUserOpHash: binds the op to one EntryPoint on one chain. */
export function userOpHash(op: PackedUserOp, entryPoint: Address, chainId: number | bigint): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        op.sender,
        op.nonce,
        keccak256(op.initCode),
        keccak256(op.callData),
        op.accountGasLimits,
        op.preVerificationGas,
        op.gasFees,
        keccak256(op.paymasterAndData),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [inner, entryPoint, BigInt(chainId)]),
  );
}

/** Upper bound the EntryPoint reserves from the paymaster for this op. */
export function maxCost(op: PackedUserOp): bigint {
  const [, maxFeePerGas] = unpackUints(op.gasFees);
  const [vgl, cgl] = unpackUints(op.accountGasLimits);
  return (vgl + cgl + op.preVerificationGas + GAS.paymasterVerificationGasLimit + GAS.paymasterPostOpGasLimit) * maxFeePerGas;
}

export function paymasterStatic(paymaster: Address): Hex {
  return concat([
    paymaster,
    pad(toHex(GAS.paymasterVerificationGasLimit), { size: 16 }),
    pad(toHex(GAS.paymasterPostOpGasLimit), { size: 16 }),
  ]);
}

export function encodeValidity(validUntil: number, validAfter: number): Hex {
  return encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, validAfter]);
}

/** JSON-safe form for the bundler RPC (bigints as hex quantities). */
export function toRpc(op: PackedUserOp): Record<string, string> {
  return { ...op, nonce: toHex(op.nonce), preVerificationGas: toHex(op.preVerificationGas) };
}

export function fromRpc(o: Record<string, string>): PackedUserOp {
  return {
    sender: o.sender as Address,
    nonce: BigInt(o.nonce),
    initCode: (o.initCode ?? "0x") as Hex,
    callData: o.callData as Hex,
    accountGasLimits: o.accountGasLimits as Hex,
    preVerificationGas: BigInt(o.preVerificationGas),
    gasFees: o.gasFees as Hex,
    paymasterAndData: (o.paymasterAndData ?? "0x") as Hex,
    signature: (o.signature ?? "0x") as Hex,
  };
}
