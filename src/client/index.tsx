/**
 * ClawBot client: registers a "ClawBot 微信通道" settings section.
 *
 * Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js.
 * The only externals are the loader module table entries the host provides.
 */
import { zh, en, type Translate } from './locales.ts'
import { ClawbotSection } from './ClawbotSection.tsx'

/** Shared with lib/settings.ts — must stay in sync. */
export const CLAWBOT_SETTINGS_NS = 'clawbot'
export type { Translate }

/** Type-safe structural subset of the Cordis Client Context this plugin touches. */
interface ClawbotClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: {
    register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
    bind(namespace: string): Translate
  }
  slots: {
    inject(slot: string, register: () => unknown): void
    register(options: Record<string, unknown>, render: () => unknown): unknown
  }
}

export const name = 'clawbot'
export const inject = ['slots', 'locale']

export function apply(ctx: ClawbotClientContext): void {
  // Register locale dictionaries for this section's labels.
  ctx.effect(() => ctx.locale.register(CLAWBOT_SETTINGS_NS, { zh, en }), 'dsh-plugin-clawbot: dictionaries')

  const t = ctx.locale.bind(CLAWBOT_SETTINGS_NS)

  // Register a settings section that shows up in the left navigation of the
  // DSH settings panel, exactly like the market's "插件市场" entry.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'clawbot',
      order: 50,    // after market (40)
      label: () => t('nav'),
      locale: CLAWBOT_SETTINGS_NS,
      inject: () => ({ t }),
    }, (ownerProps: { preferredSubsectionId?: string } = {}) => <ClawbotSection t={t} />))
}