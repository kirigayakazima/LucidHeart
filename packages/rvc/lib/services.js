// Cordis can throw on ctx.heart even behind optional chaining. Optional services
// use ctx.get() and must not prevent RVC from loading before QQ/Heart/PC services.
export function getOptionalService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name) || null
    return ctx?.[name] || null // Plain contexts used by older hosts and tests.
  } catch (error) {
    console.warn(`[@dsh/rvc] 服务读取失败 (${name}):`, error?.message || String(error))
    return null
  }
}

export function getVoiceServices(ctx) {
  return {
    heart: getOptionalService(ctx, 'heart'),
    mediaSender: getOptionalService(ctx, 'qqbotMediaSender'),
    pcBridge: getOptionalService(ctx, 'pcBridge'),
  }
}
