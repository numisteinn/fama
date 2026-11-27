export function required<A>(value: A): NonNullable<A> {
  if (value === null || value === undefined) throw new Error("Expected a test value")
  return value
}
