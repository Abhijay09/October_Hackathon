// The owner's allowlist as an OpenZeppelin StandardMerkleTree over (target, selector, recipient).
// Leaves match PolicyLib.leaf() on-chain.
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";

export const POLICY_LEAF_TYPES = ["address", "bytes4", "address"];
export const TRANSFER_SELECTOR = "0xa9059cbb" as const;

export type PolicyLeaf = [Address, Hex, Address];
export type PolicyTree = StandardMerkleTree<PolicyLeaf>;

/** Allow e₹ transfers to each merchant. */
export function buildPolicy(rupee: Address, merchants: Address[], extra: PolicyLeaf[] = []): PolicyTree {
  const leaves: PolicyLeaf[] = merchants.map((m) => [getAddress(rupee), TRANSFER_SELECTOR, getAddress(m)]);
  leaves.push(...extra.map(([t, s, r]) => [getAddress(t), s.toLowerCase() as Hex, getAddress(r)] as PolicyLeaf));
  if (leaves.length === 0) {
    // An empty allowlist still needs a root; this leaf can never match a real call.
    leaves.push([zeroAddress, "0x00000000", zeroAddress]);
  }
  return StandardMerkleTree.of(leaves, POLICY_LEAF_TYPES);
}

export function loadPolicy(dump: ReturnType<PolicyTree["dump"]>): PolicyTree {
  return StandardMerkleTree.load(dump) as PolicyTree;
}

/** Proof for an action, or [] when it is not in the policy (the wallet will then reject it). */
export function proofFor(tree: PolicyTree, target: Address, selector: Hex, recipient: Address): Hex[] {
  const t = target.toLowerCase();
  const s = selector.toLowerCase();
  const r = recipient.toLowerCase();
  for (const [i, [lt, ls, lr]] of tree.entries()) {
    if (lt.toLowerCase() === t && ls.toLowerCase() === s && lr.toLowerCase() === r) {
      return tree.getProof(i) as Hex[];
    }
  }
  return [];
}

export function allowedRecipients(tree: PolicyTree): Address[] {
  return [...tree.entries()]
    .filter(([, [, s]]) => s.toLowerCase() === TRANSFER_SELECTOR)
    .map(([, [, , r]]) => getAddress(r));
}
