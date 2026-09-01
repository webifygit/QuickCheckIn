export default function Spinner({ label = 'Loading' }) {
  return (
    <>
      <span className="spinner" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </>
  );
}
