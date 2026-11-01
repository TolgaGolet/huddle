import { useEffect, useRef, type ReactNode } from "react";
import { cycleFocus } from "../lib/focusTrap";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  readonly onClose: () => void;
  /** Id of the element that titles the dialog; use `label` if there is none. */
  readonly labelledBy?: string;
  readonly label?: string;
  readonly overlayClassName: string;
  readonly panelClassName?: string;
  readonly closeOnBackdrop?: boolean;
  /** Where focus goes on close, for when the element that opened it is gone. */
  readonly returnFocus?: () => HTMLElement | null | undefined;
  readonly children: ReactNode;
}

/**
 * Modal overlay: focuses its first control, keeps Tab inside, closes on Escape
 * and puts focus back on close. Put the safest action first, since it gets focus.
 */
export default function Dialog({ onClose, labelledBy, label, overlayClassName, panelClassName, closeOnBackdrop, returnFocus, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  // Callers pass inline handlers, so a ref keeps the listener below from
  // re-subscribing on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();
    return () => {
      (returnFocusRef.current?.() ?? opener)?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      e.preventDefault();
      cycleFocus([...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)], e.shiftKey);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- backdrop click is a mouse shortcut; Escape is the keyboard route.
    <div
      className={overlayClassName}
      onMouseDown={closeOnBackdrop ? (e) => { if (e.target === e.currentTarget) onClose(); } : undefined}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-label={label} tabIndex={-1} className={panelClassName}>
        {children}
      </div>
    </div>
  );
}
