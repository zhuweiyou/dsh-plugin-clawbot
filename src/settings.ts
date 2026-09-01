/**
 * ClawBot settings namespace — the Host half that lets the DSH settings UI
 * know this plugin exists and exposes the user-editable subset as a section
 * on the plugin configuration page.
 *
 * The browser half (src/client) keys its `settings.section` menu entry and
 * its `settings.plugin.item` card to the same namespace, so a profile that
 * never mounts this plugin leaves no trace in the settings UI.
 *
 * Only the fields a user might reasonably change at runtime are exposed:
 *   - dsh.cwd:       session working directory (per-contact DSH sessions)
 *   - dsh.agentPreset: preset used for new sessions
 * The WeChat token / accountId stay OUT of settings: they are derived from
 * the ClawBot account store on disk or the composition, and re-binding is
 * performed by the QR-code login flow in the panel, not by typing a value.
 */
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';

/** Shared by the browser half; must stay in sync with src/client/index.ts. */
export const CLAWBOT_SETTINGS_NS = settingsNamespace('clawbot');

export const ClawbotSettings = z.object({
  'dsh.cwd': z.string().default(''),
  'dsh.agentPreset': z.string().default(''),
});

/**
 * Wire the namespace so a saved change reaches the live config object the
 * bridge reads on every new session.
 *
 * @param ctx - the plugin context owning the wiring.
 * @param resolved - the live config object the manager reads (`cfg.dsh`).
 */
export function installClawbotSettings(ctx, resolved) {
  const entry = {
    'dsh.cwd': resolved.cwd ?? '',
    'dsh.agentPreset': resolved.agentPreset ?? '',
  };
  let source = () => entry;
  installSettingsSection(ctx, CLAWBOT_SETTINGS_NS, ClawbotSettings, entry, {
    setSource: (current) => { source = current; },
    onChange: () => {
      const next = source();
      if (typeof next['dsh.cwd'] === 'string' && next['dsh.cwd'].trim() !== '') {
        resolved.cwd = next['dsh.cwd'].trim();
      }
      if (typeof next['dsh.agentPreset'] === 'string' && next['dsh.agentPreset'].trim() !== '') {
        resolved.agentPreset = next['dsh.agentPreset'].trim();
      }
    },
  });
}