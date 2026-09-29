import { useCallback, useState } from 'react';

interface UseDatePopoverStateProps<T> {
  initialValue: () => T;
  /** The day the calendar should show for a value, if it has one. */
  anchorOf: (value: T) => Date | undefined;
  /** The month shown when the initial value has no anchor. */
  fallbackMonth: () => Date;
  onChange?: (value: T) => void;
}

/**
 * A picker edits a draft while its popover is open and commits it only on
 * save; closing any other way drops the draft. The calendar follows the
 * draft's anchor whenever the draft changes.
 */
export function useDatePopoverState<T>({
  initialValue,
  anchorOf,
  fallbackMonth,
  onChange,
}: UseDatePopoverStateProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [committed, setCommitted] = useState(initialValue);
  const [draft, setDraft] = useState(committed);
  const [month, setMonth] = useState(
    () => anchorOf(committed) ?? fallbackMonth()
  );

  const [followedDraft, setFollowedDraft] = useState(draft);
  if (draft !== followedDraft) {
    setFollowedDraft(draft);
    const anchor = anchorOf(draft);
    if (anchor) setMonth(new Date(anchor));
  }

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setDraft(committed);
        const anchor = anchorOf(committed);
        if (anchor) setMonth(new Date(anchor));
      }
      setIsOpen(open);
    },
    [committed, anchorOf]
  );

  const handleSave = useCallback(() => {
    setCommitted(draft);
    onChange?.(draft);
    setIsOpen(false);
  }, [draft, onChange]);

  const handleCancel = useCallback(() => {
    setDraft(committed);
    setIsOpen(false);
  }, [committed]);

  return {
    isOpen,
    value: isOpen ? draft : committed,
    setDraft,
    month,
    setMonth,
    handleOpenChange,
    handleSave,
    handleCancel,
  };
}
