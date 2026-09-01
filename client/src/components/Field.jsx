import { useId } from 'react';

// One labelled control, wired for assistive tech: the label points at the input,
// the hint and error are announced through aria-describedby, and an invalid
// field is marked as such rather than only turning red.
export default function Field({
  label,
  as = 'input',
  hint,
  error,
  required = false,
  optional = false,
  children,
  className = '',
  ...props
}) {
  const generatedId = useId();
  const id = props.id || generatedId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  const Control = as;
  const controlClass = { input: 'input', select: 'select', textarea: 'textarea' }[as] || 'input';

  return (
    <div className={`field ${className}`.trim()}>
      <label className="field__label" htmlFor={id}>
        {label}
        {required && <span aria-hidden="true">*</span>}
        {optional && <span className="field__optional">optional</span>}
      </label>

      <Control
        {...props}
        id={id}
        className={controlClass}
        required={required}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
      >
        {children}
      </Control>

      {hint && (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field__error" id={errorId}>
          {error}
        </span>
      )}
    </div>
  );
}
