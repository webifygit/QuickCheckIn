const ICONS = {
  error: '!',
  success: '✓',
  info: 'i',
  warning: '!',
};

// Errors and confirmations are announced, not just shown: a guest using a screen
// reader must hear that the scan failed without having to go looking for it.
export default function Alert({ tone = 'info', children, className = '' }) {
  return (
    <div
      className={`alert alert--${tone} ${className}`.trim()}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="alert__icon" aria-hidden="true">
        {ICONS[tone]}
      </span>
      <span>{children}</span>
    </div>
  );
}
