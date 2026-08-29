/**
 * The connection the focused SQL editor belongs to.
 *
 * Why this is a module-level value and not a parameter, when §4.1 of
 * `docs/multi-connection-plan.md` removes exactly that kind of "ambient id":
 *
 * Monaco's providers (completion, hover, go-to-definition) are registered **once for the whole app**
 * and live for the life of the process. They cannot be given a static `connId`, because no tab
 * exists at registration time, and they cannot take one as a parameter, because Monaco is the caller.
 *
 * What makes this value **safe** while `dbHelper`'s ambient id is not, is the scope in which it is
 * read: completion and hover run only **inside the focused editor**, driven by the user typing.
 * Nothing runs in the background. The race §4.1 describes — two tabs refetching at once and
 * interleaving — cannot happen here, because only one editor takes keystrokes at a time.
 *
 * `SqlEditor` sets this on mount and whenever the editor takes focus.
 */
let focusedConnId = '';

export function setEditorConnId(connId: string): void {
  focusedConnId = connId;
}

export function editorConnId(): string {
  return focusedConnId;
}
