/** Status mark: turns slowly while the agent is active, holds still when it is frozen. */
export function YinYang({ still, size = 96 }: { still: boolean; size?: number }) {
  return (
    <svg className={`yinyang ${still ? "yinyang-still" : ""}`} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="48" fill="#fff" stroke="currentColor" strokeWidth="2" />
      <path d="M50 2a48 48 0 0 1 0 96 24 24 0 0 1 0-48 24 24 0 0 0 0-48" fill="currentColor" />
      <circle cx="50" cy="26" r="6.5" fill="currentColor" />
      <circle cx="50" cy="74" r="6.5" fill="#fff" />
    </svg>
  );
}
