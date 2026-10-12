/**
 * A click handler for buttons that act at once: it runs on a single click or a key press (whose click has detail 0),
 * and ignores the second click of a double-click. In the desk panel that click was aimed at the desk row the panel has
 * just replaced; on a Go button it would switch tmux a second time.
 */
export function singleClick(run: () => void): (e: MouseEvent) => void {
  return (e) => {
    if (e.detail <= 1) run();
  };
}
