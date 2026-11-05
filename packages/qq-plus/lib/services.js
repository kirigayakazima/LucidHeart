export function optionalService(ctx, name) {
  try { if (typeof ctx?.get === 'function') return ctx.get(name) ?? null } catch { return null }
  // Compatibility for plain test contexts / hosts without get. Never a requirement to inject Heart.
  try { return ctx?.[name] ?? null } catch { return null }
}
