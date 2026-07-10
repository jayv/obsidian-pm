export interface SubView {
  render(): void
  /** Re-render from current in-memory data, preserving DOM/scroll/selection where possible. Falls back to render(). */
  refresh?(): void
  destroy?(): void
  handleKeyDown?(e: KeyboardEvent): void
  /** Move keyboard focus into the view (so shortcuts like Insert work without tabbing in). */
  focus?(): void
  /**
   * How many task rows/cards this view is currently showing — read straight from the set it
   * just rendered, so the toolbar's "visible | total" count can never drift from the screen.
   * Each view defines "shown" its own way (Table: flat filtered rows respecting collapse;
   * Gantt: promoted rows; Kanban: leaf cards passing the filter).
   */
  visibleCount?(): number
}
