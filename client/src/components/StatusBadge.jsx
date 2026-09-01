const LABELS = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  CHECKED_IN: 'Checked in',
  REJECTED: 'Rejected',
};

export default function StatusBadge({ status }) {
  return (
    <span className={`status status--${String(status).toLowerCase()}`}>
      {LABELS[status] || status}
    </span>
  );
}

export { LABELS as STATUS_LABELS };
