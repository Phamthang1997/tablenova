import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ModalBody, ModalFooter } from '../Modal';

interface PromptDialogProps {
  open: boolean;
  title: string;
  /** Label above the input. */
  label: React.ReactNode;
  defaultValue?: string;
  placeholder?: string;
  /** Extra line under the input (units, consequences). */
  note?: React.ReactNode;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * One-line text input dialog, replacing `window.prompt()` in the Redis panels.
 *
 * `prompt()` was used for "new key", "rename" and "TTL": it cannot be styled, cannot be
 * translated, and on Windows renders as a system box that looks nothing like the rest of the
 * app. Built on `Modal` like every other dialog (which also gives it Esc + backdrop close).
 */
export const PromptDialog: React.FC<PromptDialogProps> = ({
  open,
  title,
  label,
  defaultValue = '',
  placeholder,
  note,
  submitLabel,
  onSubmit,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [value, setValue] = useState(defaultValue);

  // Reopening for a different key must not show the previous key's text.
  useEffect(() => {
    queueMicrotask(() => {
      if (open) setValue(defaultValue);
    });
  }, [open, defaultValue]);

  if (!open) return null;

  return (
    <Modal title={title} onClose={onCancel} width="420px" zIndex={10001}>
      <ModalBody style={{ gap: '8px' }}>
        <label className="redis-dialog-label">{label}</label>
        <input
          type="text"
          className="form-input redis-dialog-input"
          autoFocus
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits; Esc is already handled by Modal.
            if (e.key === 'Enter') onSubmit(value);
          }}
        />
        {note && (
          <div className="redis-dialog-note">{note}</div>
        )}
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="btn btn-primary" onClick={() => onSubmit(value)}>
          {submitLabel ?? t('common.save')}
        </button>
      </ModalFooter>
    </Modal>
  );
};
