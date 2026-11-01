/**
 * True when a dragleave really exits the container. The event also fires when
 * moving between its children, and `related` is null when leaving the window
 * or cancelling the drag.
 */
export function isDragLeavingContainer(container: { contains(other: Node | null): boolean }, related: EventTarget | null): boolean {
  return !container.contains(related as Node | null);
}
