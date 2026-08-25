/**
 * Connection ID associated with the currently focused SQL editor.
 *
 * Module-level variable rather than function argument because Monaco providers are registered once
 globally and called by Monaco without connection context.
 *
 
 
 
 *
 * This is safe because completion/hover executes strictly in the focused editor during user typing,
 precluding background race conditions.
 
 
 *
 * `SqlEditor` sets this value on mount and when editor gains focus.
 */
let focusedConnId = '';

export function setEditorConnId(connId: string): void {
  focusedConnId = connId;
}

export function editorConnId(): string {
  return focusedConnId;
}
