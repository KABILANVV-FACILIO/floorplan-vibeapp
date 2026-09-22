import styles from './StatusPill.module.css';

interface StatusPillProps {
  label: string;
  bg: string;
  fg: string;
  /**
   * Overrides what the hover tooltip says. By default it is the label itself, which is the point:
   * these pills are ellipsised wherever the column is narrow ("Assigned · Amrit…", "Unpla…"), and
   * a truncated status is a status you cannot read. Pass this when the pill's own text is already
   * short but the FULL story is longer.
   */
  tip?: string;
}

export function StatusPill({ label, bg, fg, tip }: StatusPillProps) {
  return (
    <span className={styles.pill} style={{ background: bg, color: fg }} data-tip={tip ?? label}>
      {label}
    </span>
  );
}
