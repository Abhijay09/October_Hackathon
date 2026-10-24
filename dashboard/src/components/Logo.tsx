/** The Alchemy flask, traced from the supplied logo. */
export function Flask({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1080 1080" role="img" aria-label="Alchemy">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M271 55 L769 6 L766 128 L671 134 L665 324 L967 889 L949 987 L845 1068 L183 1019 L105 921 L104 848 L362 335 L358 153 L272 164 Z M448 148 L572 138 L575 355 L739 663 L289 668 L449 359 Z"
      />
    </svg>
  );
}

/** The logo in its circle: white disc, white outline, black flask. */
export function Orb({ size }: { size?: number }) {
  return (
    <span className="orb" style={size ? { width: size, height: size } : undefined}>
      <Flask className="orb-flask" />
    </span>
  );
}
