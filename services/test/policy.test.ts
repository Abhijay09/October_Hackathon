import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, concat, type Address } from "viem";
import { allowedRecipients, buildPolicy, proofFor, TRANSFER_SELECTOR } from "../src/lib/policy.js";
import { packUints, unpackUints, userOpHash, newUserOp } from "../src/lib/userop.js";

const rupee = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const kirana = "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec" as Address;
const railtix = "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097" as Address;

/** PolicyLib.leaf: keccak256(bytes.concat(keccak256(abi.encode(target, selector, recipient)))) */
function solidityLeaf(target: Address, selector: `0x${string}`, recipient: Address) {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes4" }, { type: "address" }], [target, selector, recipient]));
  return keccak256(concat([inner]));
}

describe("policy merkle tree", () => {
  it("uses the same leaf encoding as PolicyLib.leaf", () => {
    const tree = buildPolicy(rupee, [kirana]);
    expect(tree.leafHash([rupee, TRANSFER_SELECTOR, kirana])).toBe(solidityLeaf(rupee, TRANSFER_SELECTOR, kirana));
  });

  it("gives verifying proofs for allowed merchants and none for others", () => {
    const tree = buildPolicy(rupee, [kirana, railtix]);
    const proof = proofFor(tree, rupee, TRANSFER_SELECTOR, kirana);
    expect(proof.length).toBeGreaterThan(0);
    expect(tree.verify([rupee, TRANSFER_SELECTOR, kirana], proof)).toBe(true);
    expect(proofFor(tree, rupee, TRANSFER_SELECTOR, "0x000000000000000000000000000000000000dEaD")).toEqual([]);
    expect(allowedRecipients(tree)).toEqual(expect.arrayContaining([kirana, railtix]));
  });

  it("still produces a root for an empty allowlist", () => {
    expect(buildPolicy(rupee, []).root).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("userop", () => {
  it("packs gas fields as two uint128s", () => {
    expect(unpackUints(packUints(300_000n, 500_000n))).toEqual([300_000n, 500_000n]);
  });

  it("binds the hash to the chain id", () => {
    const op = newUserOp(kirana, 0n, "0x", 2n, 1n);
    expect(userOpHash(op, rupee, 31337)).not.toBe(userOpHash(op, rupee, 1));
  });
});
