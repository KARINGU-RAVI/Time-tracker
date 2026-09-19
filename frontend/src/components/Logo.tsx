/** The Office Hours mark: a progress dial with its hand pointing into the gap. Same artwork as branding/office-hours-logo.svg. */
export function Logo({ size = 56, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" role="img" aria-label="Office Hours" className={className}>
      <rect width="512" height="512" rx="112" fill="#3B4CCA" />
      <g fill="none" stroke="#fff" strokeWidth="40" strokeLinecap="round">
        <path d="M388 256 A132 132 0 1 1 256 124" />
        <path d="M256 256 L312 200" />
      </g>
    </svg>
  );
}
